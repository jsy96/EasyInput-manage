import { useEffect, useRef, useState } from 'react'
import { version as appVersion } from '../../../package.json'
import { registerSW } from 'virtual:pwa-register'
import {
  Bell, Bluetooth, Check, ChevronDown, Download, FileUp, LoaderCircle, Mic,
  Radio, Settings, Timer, Usb, Wifi, X,
} from 'lucide-react'
import { ESPLoader, Transport } from 'esptool-js'
import { VoiceChat } from './VoiceChat'
import { downloadFile, healthCsv, ledgerCsv } from './services/downloads'
import { ChatConnection } from './services/chat'
import { BluetoothConnection } from './services/bluetooth'
import { emptyRoom } from '@shared/chat'
import type { RoomState } from '@shared/chat'
import { BoardConnections } from '@shared/connections'
import type { BoardTransport } from '@shared/connections'
import type { BoardMessage, BoardResult, BoardStatus } from '@shared/protocol'
import { PROTOCOL_VERSION } from '@shared/protocol'

const FLASH_BYTES = 16 * 1024 * 1024
type Page = 'voice' | 'device'
type FirmwareImageSpec = { file: string; address: number; bytes: number; sha256: string }
type FirmwareManifest = {
  format: string
  formatVersion: number
  board: string
  chip: string
  version: string
  flash: {
    size: '16MB'
    mode: 'dio' | 'qio' | 'dout' | 'qout'
    frequency: '80m' | '60m' | '48m' | '40m' | '30m' | '26m' | '24m' | '20m' | '16m' | '15m' | '12m'
    eraseAll: false
  }
  images: FirmwareImageSpec[]
}
type LoadedImage = FirmwareImageSpec & { data: Uint8Array }
type FlashCandidate = { loader: ESPLoader; transport: Transport; chip: string; mac: string }
type ConfigAction = 'wifi.configure' | 'wifi.clear' | 'wifi.connect_saved' | 'cloud.configure' | 'cloud.clear'

const emptyStatus: BoardStatus = {
  type: 'status', protocol: PROTOCOL_VERSION, uptime_ms: 0,
  wifi: { state: 'unknown' }, ble: { state: 'unknown' },
  peripherals: { shared_rail: 'unknown' },
  lights: { status_led: 'unknown', pixels: ['unknown', 'unknown', 'unknown', 'unknown', 'unknown'] },
  speaker: { state: 'unknown' }, microphone: { state: 'unknown' },
  cpu: { frequency_mhz: 0, usage_percent: [] },
  memory: {
    internal: { total_bytes: 0, free_bytes: 0, minimum_free_bytes: 0, largest_block_bytes: 0 },
    psram: { total_bytes: 0, free_bytes: 0, largest_block_bytes: 0 },
  },
  storage: {
    flash: { state: 'unknown', total_bytes: 0, unallocated_bytes: 0, read_bytes_per_second: 0, write_bytes_per_second: 0, erase_bytes_per_second: 0 },
    partitions: [],
    app: { state: 'unknown', partition_bytes: 0, image_bytes: 0, free_bytes: 0 },
    nvs: { state: 'unavailable', total_bytes: 0, used_entries: 0, free_entries: 0, total_entries: 0 },
  },
  power: {},
}

function stateLabel(state?: string): string {
  const labels: Record<string, string> = {
    unknown: '等待数据', disabled: '未启用', disconnected: '未连接', connecting: '连接中',
    connected: '已连接', advertising: '广播中', off: '关闭', on: '开启',
  }
  return state ? labels[state] ?? state : '等待数据'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatAddress(address: number): string {
  return `0x${address.toString(16).padStart(6, '0').toUpperCase()}`
}

function formatTime(minute: number | null | undefined): string {
  if (minute === null || minute === undefined) return '未设置'
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

async function digestHex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validateManifest(value: unknown): FirmwareManifest {
  if (!value || typeof value !== 'object') throw new Error('固件清单不是有效对象。')
  const manifest = value as Partial<FirmwareManifest>
  if (manifest.format !== 'easyinput-firmware' || manifest.formatVersion !== 1) throw new Error('固件包格式不受支持。')
  if (manifest.board !== 'easyinput-v2' || manifest.chip !== 'esp32s3') throw new Error('固件包目标不是 EasyInput V2 / ESP32-S3。')
  if (typeof manifest.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(manifest.version) ||
    !Array.isArray(manifest.images) || manifest.images.length !== 3) throw new Error('固件清单缺少有效版本或镜像。')
  const flash = manifest.flash
  if (!flash || flash.size !== '16MB' || flash.eraseAll !== false ||
    !['dio', 'qio', 'dout', 'qout'].includes(flash.mode) ||
    !['80m', '60m', '48m', '40m', '30m', '26m', '24m', '20m', '16m', '15m', '12m'].includes(flash.frequency)) {
    throw new Error('固件清单中的 Flash 参数不支持或包含整片擦除。')
  }
  const sorted = [...manifest.images].sort((a, b) => a.address - b.address)
  const allowedOffsets = new Set([0x0, 0x8000, 0x10000])
  const filenames = new Set<string>()
  let previousEnd = -1
  for (const image of sorted) {
    if (!image || typeof image.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.bin$/i.test(image.file) ||
      filenames.has(image.file) || !Number.isInteger(image.address) || !allowedOffsets.has(image.address) ||
      !Number.isInteger(image.bytes) || image.bytes <= 0 || image.address + image.bytes > FLASH_BYTES ||
      !/^[a-f\d]{64}$/i.test(image.sha256)) throw new Error('固件清单包含无效镜像信息。')
    filenames.add(image.file)
    if (image.address < previousEnd) throw new Error('固件镜像地址重叠。')
    previousEnd = image.address + image.bytes
  }
  const offsets = new Set(manifest.images.map((image) => image.address))
  if (![0x0, 0x8000, 0x10000].every((address) => offsets.has(address))) throw new Error('固件包必须包含 bootloader、分区表和应用镜像。')
  return manifest as FirmwareManifest
}

export default function App(): React.JSX.Element {
  const [activePage, setActivePage] = useState<Page>('voice')
  const [room, setRoom] = useState<RoomState>({ ...emptyRoom })
  const [clock, setClock] = useState(Date.now())
  const [, refreshConnections] = useState(0)
  const [chatBusy, setChatBusy] = useState(false)
  const [healthDownloading, setHealthDownloading] = useState(false)
  const [healthNote, setHealthNote] = useState('')
  const [ledgerDownloading, setLedgerDownloading] = useState(false)
  const [ledgerNote, setLedgerNote] = useState('')
  const [notice, setNotice] = useState('')
  const [serialOpen, setSerialOpen] = useState(false)
  const [serialConnecting, setSerialConnecting] = useState(false)
  const [serialError, setSerialError] = useState('')
  const [bleConnected, setBleConnected] = useState(false)
  const [bleConnecting, setBleConnecting] = useState(false)
  const [bleRetrying, setBleRetrying] = useState(false)
  const [bleError, setBleError] = useState('')
  const [wifiSsid, setWifiSsid] = useState('')
  const [wifiPassword, setWifiPassword] = useState('')
  const [wifiEditing, setWifiEditing] = useState(false)
  const [wifiBusy, setWifiBusy] = useState(false)
  const [wifiResult, setWifiResult] = useState<BoardResult | null>(null)
  const [remoteToken, setRemoteToken] = useState('')
  const [cloudBusy, setCloudBusy] = useState(false)
  const [cloudResult, setCloudResult] = useState<BoardResult | null>(null)
  const [manifest, setManifest] = useState<FirmwareManifest | null>(null)
  const [images, setImages] = useState<LoadedImage[]>([])
  const [packageError, setPackageError] = useState('')
  const [flashError, setFlashError] = useState('')
  const [flashLog, setFlashLog] = useState('')
  const [flashProgress, setFlashProgress] = useState(0)
  const [flashCandidate, setFlashCandidate] = useState<FlashCandidate | null>(null)
  const [flashPreparing, setFlashPreparing] = useState(false)
  const [flashing, setFlashing] = useState(false)
  const [confirmedTarget, setConfirmedTarget] = useState(false)
  const [updateWaiting, setUpdateWaiting] = useState(false)
  const chatRef = useRef<ChatConnection | null>(null)
  const chatBufferRef = useRef('')
  const bleConnectionRef = useRef<BluetoothConnection | null>(null)
  const connectionsRef = useRef(new BoardConnections())
  const portRef = useRef<SerialPort | null>(null)
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  const readTaskRef = useRef<Promise<void> | null>(null)
  const serialConnectRequestRef = useRef(false)
  const pendingConfigRef = useRef<{ action: ConfigAction; transport: 'usb' | 'ble'; timer: number } | null>(null)
  const flashFolderRef = useRef<HTMLInputElement | null>(null)
  const updateSWRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null)
  const updateStartedRef = useRef(false)

  const activeConnection = connectionsRef.current.current(clock)
  const hello = activeConnection?.session.hello ?? null
  const status = activeConnection?.session.status ?? null
  const lights = activeConnection?.session.lights ?? null
  const currentStatus = status ?? emptyStatus
  const lastSeenAt = activeConnection?.session.lastSeenAt ?? null
  const usbProtocolOnline = serialOpen && connectionsRef.current.isOnline('usb', clock)
  const bleProtocolOnline = bleConnected && connectionsRef.current.isOnline('ble', clock)
  const configTransport = usbProtocolOnline ? 'usb' as const : bleProtocolOnline ? 'ble' as const : null
  const deviceBusy = flashing || flashPreparing || flashCandidate !== null
  const updateBlocked = chatBusy || healthDownloading || ledgerDownloading || serialOpen || bleConnected || serialConnecting || bleConnecting || wifiBusy || cloudBusy || deviceBusy

  useEffect(() => {
    const chat = new ChatConnection({
      state: setRoom,
      telemetry: (text) => handleProtocolText('wifi', text),
      notice: setNotice,
      realtime: () => undefined,
      bridge: async (value) => {
        if (!bleConnectionRef.current?.writable) return
        await bleConnectionRef.current.write(new TextEncoder().encode(`${JSON.stringify(value)}\n`))
      },
    })
    chatRef.current = chat
    chat.start()
    return () => { chat.dispose(); if (chatRef.current === chat) chatRef.current = null }
  }, [])

  useEffect(() => {
    const connection = new BluetoothConnection({
      connected: setBleConnected,
      connecting: setBleConnecting,
      retrying: setBleRetrying,
      notice: setBleError,
      reset: () => { chatRef.current?.gatewayOff(); chatBufferRef.current = ''; resetTransport('ble') },
      text: (text) => handleProtocolText('ble', text),
    })
    bleConnectionRef.current = connection
    connection.start()
    return () => {
      connection.dispose()
      if (bleConnectionRef.current === connection) bleConnectionRef.current = null
    }
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let updateTimer: number | undefined
    updateSWRef.current = registerSW({
      immediate: true,
      onNeedRefresh: () => setUpdateWaiting(true),
      onRegisteredSW: (_url, registration) => {
        if (!registration) return
        updateTimer = window.setInterval(() => {
          if (document.visibilityState === 'visible') void registration.update()
        }, 30 * 60 * 1000)
      },
    })
    return () => { if (updateTimer !== undefined) window.clearInterval(updateTimer) }
  }, [])

  useEffect(() => {
    if (!updateWaiting || updateBlocked || updateStartedRef.current || !updateSWRef.current) return
    updateStartedRef.current = true
    void updateSWRef.current(true).catch(() => { updateStartedRef.current = false })
  }, [updateBlocked, updateWaiting])

  useEffect(() => {
    if (!wifiSsid && currentStatus.wifi.ssid) setWifiSsid(currentStatus.wifi.ssid)
  }, [currentStatus.wifi.ssid, wifiSsid])

  function resetTransport(transport: BoardTransport): void {
    connectionsRef.current.reset(transport)
    refreshConnections((previous) => previous + 1)
  }

  function finishConfigCommand(): void {
    const pending = pendingConfigRef.current
    if (pending) window.clearTimeout(pending.timer)
    pendingConfigRef.current = null
    setWifiBusy(false)
    setCloudBusy(false)
  }

  function handleBoardMessage(message: BoardMessage): void {
    if (message.type !== 'result') return
    const pending = pendingConfigRef.current
    if (!pending || pending.action !== message.action) return
    if (message.action.startsWith('wifi.')) {
      setWifiResult(message)
      if (message.action === 'wifi.configure') {
        setWifiPassword('')
        if (message.ok) setWifiEditing(false)
      }
      if (message.action === 'wifi.clear' && message.ok) {
        setWifiSsid('')
        setWifiPassword('')
        setWifiEditing(false)
      }
    } else {
      setCloudResult(message)
      if (message.ok && message.action === 'cloud.configure') setRemoteToken('')
    }
    finishConfigCommand()
  }

  function handleProtocolText(transport: BoardTransport, text: string): void {
    if (transport === 'ble') {
      const lines = (chatBufferRef.current + text).split(/\r?\n/)
      chatBufferRef.current = (lines.pop() ?? '').slice(-32768)
      for (const line of lines) {
        try {
          const value = JSON.parse(line) as Record<string, unknown>
          if (['hello', 'status', 'event', 'result', 'chat', 'lights'].includes(String(value.type))) chatRef.current?.bridge(value)
        } catch { /* Partial frames wait for newline. */ }
      }
    }
    const now = Date.now()
    const messages = connectionsRef.current.receive(transport, text, now)
    for (const message of messages) handleBoardMessage(message)
    if (messages.length) {
      setClock(now)
      refreshConnections((previous) => previous + 1)
    }
  }

  async function closeSerial(): Promise<void> {
    const port = portRef.current
    const reader = readerRef.current
    const readTask = readTaskRef.current
    if (!port) return
    try {
      if (reader) await reader.cancel()
      await readTask?.catch(() => undefined)
      if (port.readable?.locked === false || !readerRef.current) await port.close()
    } catch { /* Unplugging can close the port first. */ }
    if (readerRef.current === reader) readerRef.current = null
    if (readTaskRef.current === readTask) readTaskRef.current = null
    if (portRef.current === port) {
      portRef.current = null
      setSerialOpen(false)
      resetTransport('usb')
    }
  }

  async function readSerial(port: SerialPort): Promise<void> {
    if (!port.readable) return
    const reader = port.readable.getReader()
    readerRef.current = reader
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done || portRef.current !== port) break
        handleProtocolText('usb', decoder.decode(value, { stream: true }))
      }
    } catch (error) {
      if (portRef.current === port) setSerialError(error instanceof Error ? error.message : 'USB 串口读取失败。')
    } finally {
      reader.releaseLock()
      if (readerRef.current === reader) readerRef.current = null
      await port.close().catch(() => undefined)
      if (portRef.current === port) {
        portRef.current = null
        setSerialOpen(false)
        resetTransport('usb')
      }
    }
  }

  async function connectBoard(): Promise<void> {
    if (serialConnectRequestRef.current || deviceBusy) return
    setSerialError('')
    if (!('serial' in navigator)) {
      setSerialError('此浏览器不支持 Web Serial，请使用最新版 Chrome 或 Edge。')
      return
    }
    serialConnectRequestRef.current = true
    setSerialConnecting(true)
    try {
      if (portRef.current) await closeSerial()
      resetTransport('usb')
      const port = await navigator.serial.requestPort()
      await port.open({ baudRate: 115200, bufferSize: 65536 })
      portRef.current = port
      setSerialOpen(true)
      readTaskRef.current = readSerial(port)
      const writer = port.writable?.getWriter()
      if (!writer) throw new Error('USB 串口无法发送握手请求。')
      try {
        await writer.write(new TextEncoder().encode(`${JSON.stringify({ type: 'command', protocol: PROTOCOL_VERSION, action: 'hello.get' })}\n`))
      } finally { writer.releaseLock() }
    } catch (error) {
      if (portRef.current) await closeSerial()
      const message = error instanceof Error ? error.message : '无法打开 USB 串口。'
      if (error instanceof DOMException && error.name === 'NotFoundError') setSerialError('未选择串口。')
      else if (!message.toLowerCase().includes('cancel')) setSerialError(message)
    } finally {
      serialConnectRequestRef.current = false
      setSerialConnecting(false)
    }
  }

  async function sendConfig(action: ConfigAction): Promise<void> {
    const transport = configTransport
    if (!transport || pendingConfigRef.current || deviceBusy) return
    if (action === 'wifi.configure') {
      const passwordBytes = new TextEncoder().encode(wifiPassword).byteLength
      if (!wifiSsid || new TextEncoder().encode(wifiSsid).byteLength > 32 || (passwordBytes > 0 && (passwordBytes < 8 || passwordBytes > 63))) {
        setWifiResult({ type: 'result', protocol: PROTOCOL_VERSION, action, ok: false, message: '请检查 Wi-Fi 名称和密码长度。' })
        return
      }
    }
    if (action === 'cloud.configure' && remoteToken.trim().length < 16) {
      setCloudResult({ type: 'result', protocol: PROTOCOL_VERSION, action, ok: false, message: '配对码至少需要 16 位。' })
      return
    }
    const timer = window.setTimeout(() => {
      finishConfigCommand()
      const result = { type: 'result' as const, protocol: PROTOCOL_VERSION, action, ok: false, message: '等待开发板响应超时，请检查连接。' }
      if (action.startsWith('wifi.')) setWifiResult(result)
      else setCloudResult(result)
    }, 12000)
    pendingConfigRef.current = { action, transport, timer }
    setWifiBusy(action.startsWith('wifi.'))
    setCloudBusy(action.startsWith('cloud.'))
    if (action.startsWith('wifi.')) setWifiResult(null)
    else setCloudResult(null)
    const command: Record<string, unknown> = { type: 'command', protocol: PROTOCOL_VERSION, action }
    if (action === 'wifi.configure') Object.assign(command, { ssid: wifiSsid, password: wifiPassword })
    if (action === 'cloud.configure') Object.assign(command, { gateway: 'wss://easy.leige.online', device: 'easyinput-v2', token: remoteToken })
    const frame = new TextEncoder().encode(`${JSON.stringify(command)}\n`)
    try {
      if (transport === 'ble') {
        const connection = bleConnectionRef.current
        if (!connection?.writable) throw new Error('蓝牙命令通道已断开。')
        await connection.write(frame)
      } else {
        const writer = portRef.current?.writable?.getWriter()
        if (!writer) throw new Error('USB 命令通道已断开。')
        try { await writer.write(frame) } finally { writer.releaseLock() }
      }
      if (action === 'wifi.configure') setWifiPassword('')
    } catch (error) {
      finishConfigCommand()
      const result = { type: 'result' as const, protocol: PROTOCOL_VERSION, action, ok: false, message: error instanceof Error ? error.message : '配置发送失败。' }
      if (action.startsWith('wifi.')) setWifiResult(result)
      else setCloudResult(result)
    } finally {
      frame.fill(0)
      command.password = ''
      command.token = ''
    }
  }

  async function importFirmware(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    setPackageError('')
    setManifest(null)
    setImages([])
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    try {
      const manifestFile = files.find((file) => file.name === 'firmware.json')
      if (!manifestFile) throw new Error('所选目录中找不到 firmware.json。')
      const parsed = validateManifest(JSON.parse(await manifestFile.text()))
      const loaded: LoadedImage[] = []
      for (const spec of parsed.images) {
        const file = files.find((candidate) => candidate.name === spec.file)
        if (!file) throw new Error(`固件包缺少镜像：${spec.file}`)
        const data = new Uint8Array(await file.arrayBuffer())
        if (data.byteLength !== spec.bytes) throw new Error(`${spec.file} 文件大小与清单不符。`)
        if ((await digestHex(data)).toLowerCase() !== spec.sha256.toLowerCase()) throw new Error(`${spec.file} 校验失败。`)
        loaded.push({ ...spec, data })
      }
      setManifest(parsed)
      setImages(loaded.sort((a, b) => a.address - b.address))
    } catch (error) {
      setPackageError(error instanceof Error ? error.message : '固件包读取失败。')
    }
  }

  async function prepareFlash(): Promise<void> {
    if (!manifest || images.length === 0) return
    setFlashError('')
    setFlashLog('正在识别 ESP32-S3，请保持开发板开机。')
    setFlashCandidate(null)
    setConfirmedTarget(false)
    setFlashPreparing(true)
    let transport: Transport | null = null
    try {
      bleConnectionRef.current?.pause()
      await closeSerial()
      const port = await navigator.serial.requestPort()
      transport = new Transport(port, false)
      const loader = new ESPLoader({
        transport,
        baudrate: 115200,
        romBaudrate: 115200,
        debugLogging: false,
        terminal: {
          clean: () => undefined,
          writeLine: (line) => setFlashLog(line.trim()),
          write: (line) => setFlashLog(line.trim()),
        },
      })
      const chip = await loader.main('default_reset')
      if (!chip.toLowerCase().includes('esp32-s3')) throw new Error(`识别到 ${chip}，固件要求 ESP32-S3。`)
      const mac = await loader.chip.readMac(loader)
      setFlashCandidate({ loader, transport, chip, mac })
      setFlashLog('芯片和设备地址已读取，请确认后再写入。')
    } catch (error) {
      if (transport) await transport.disconnect().catch(() => undefined)
      setFlashError(error instanceof Error ? error.message : '连接下载端口失败。')
      setFlashLog('自动连接未完成。保持开发板开机，短按并松开 BOOT，然后重试。')
    } finally {
      setFlashPreparing(false)
    }
  }

  async function flashFirmware(): Promise<void> {
    if (!flashCandidate || !manifest || images.length === 0 || !confirmedTarget) return
    setFlashError('')
    setFlashing(true)
    setFlashProgress(0)
    setFlashLog('正在写入固件镜像…')
    const totalBytes = images.reduce((sum, image) => sum + image.bytes, 0)
    try {
      await flashCandidate.loader.writeFlash({
        fileArray: images.map((image) => ({ data: image.data, address: image.address })),
        flashMode: manifest.flash.mode,
        flashFreq: manifest.flash.frequency,
        flashSize: manifest.flash.size,
        eraseAll: false,
        compress: true,
        reportProgress: (index, written) => {
          const prior = images.slice(0, index).reduce((sum, image) => sum + image.bytes, 0)
          setFlashProgress(Math.min(100, Math.round(((prior + written) / totalBytes) * 100)))
        },
      })
      setFlashProgress(100)
      setFlashLog('写入完成。关机和重新开机后回到正常运行模式。')
    } catch (error) {
      setFlashError(error instanceof Error ? error.message : '固件写入失败。')
      setFlashLog('写入失败，请检查错误后决定重试或恢复。')
    } finally {
      await flashCandidate.transport.disconnect().catch(() => undefined)
      setFlashCandidate(null)
      setConfirmedTarget(false)
      setFlashing(false)
    }
  }

  function cancelFlashCandidate(): void {
    if (flashCandidate) void flashCandidate.transport.disconnect().catch(() => undefined)
    setFlashCandidate(null)
    setConfirmedTarget(false)
    setFlashLog('目标已取消。')
  }

  const boardOnline = room.online
  async function downloadHealth(): Promise<void> {
    if (!chatRef.current || healthDownloading) return
    setHealthDownloading(true); setHealthNote('正在读取历史记录…')
    try {
      const records = await chatRef.current.healthHistory(count => setHealthNote(`已读取 ${count} 条记录…`))
      if (!records.length) { setHealthNote('暂无已同步的测量历史；请更新开发板固件并联网完成同步。'); return }
      downloadFile(new Blob([healthCsv(records)], { type: 'text/csv;charset=utf-8' }), `血压血糖历史-${new Date().toISOString().slice(0, 10)}.csv`)
      setHealthNote(`已导出 ${records.length} 条测量记录（时间为 UTC）。${room.healthPending ? `板端还有 ${room.healthPending} 条待同步，请稍后再次导出。` : !room.online ? '开发板离线，可能还有未同步记录。' : ''}`)
    } catch (error) { setHealthNote(error instanceof Error ? error.message : '测量记录下载失败') }
    finally { setHealthDownloading(false) }
  }
  async function downloadLedger(): Promise<void> {
    if (!chatRef.current || ledgerDownloading) return
    setLedgerDownloading(true); setLedgerNote('正在读取记账记录…')
    try {
      const records = await chatRef.current.ledgerHistory(count => setLedgerNote(`已读取 ${count} 笔记账…`))
      if (!records.length) { setLedgerNote('暂无已同步的记账记录；请更新开发板固件并联网完成同步。'); return }
      downloadFile(new Blob([ledgerCsv(records)], { type: 'text/csv;charset=utf-8' }), `记账历史-${new Date().toISOString().slice(0, 10)}.csv`)
      setLedgerNote(`已导出 ${records.length} 笔记账（金额为人民币整数元，时间为 UTC）。${room.ledgerPending ? `板端还有 ${room.ledgerPending} 笔待同步，请稍后再次导出。` : !room.online ? '开发板离线，可能还有未同步记录。' : ''}`)
    } catch (error) { setLedgerNote(error instanceof Error ? error.message : '记账记录下载失败') }
    finally { setLedgerDownloading(false) }
  }
  const alarmMinute = currentStatus.voice?.alarm_minute
  const countdownSeconds = currentStatus.voice?.countdown_seconds ?? 0
  const stopwatchSeconds = currentStatus.voice?.stopwatch_seconds
  const stopwatchTime = stopwatchSeconds === undefined ? '等待设备状态' : `${Math.floor(stopwatchSeconds / 3600)}:${String(Math.floor(stopwatchSeconds / 60) % 60).padStart(2, '0')}:${String(stopwatchSeconds % 60).padStart(2, '0')}`
  return <main className="app-shell">
    <div className="workspace">
      <header className="topbar">
        <div className="topbar-brand">
          <div className="brand-mark">E<span /></div>
          <div><h1>EasyInput <span>Studio</span></h1><small>语音时间线</small></div>
        </div>
        <div className="topbar-actions">
          <span className="online-chip" title={boardOnline ? '开发板在线' : '开发板离线'}><i className={boardOnline ? 'online-dot active' : 'online-dot'} />{boardOnline ? `在线${room.via ? ` · ${room.via === 'wifi' ? 'Wi-Fi' : '蓝牙网关'}` : ''}` : '离线'}</span>
        </div>
      </header>
      <div className="connection-line">
        <nav className="main-nav" aria-label="主要页面">
          <button aria-current={activePage === 'voice' ? 'page' : undefined} className={activePage === 'voice' ? 'active' : ''} onClick={() => setActivePage('voice')}><Mic size={18} /><span>语音</span></button>
          <button aria-current={activePage === 'device' ? 'page' : undefined} className={activePage === 'device' ? 'active' : ''} onClick={() => setActivePage('device')}><Settings size={18} /><span>设备</span></button>
        </nav>
        <div className="connection-transports">
          <span className="app-version">v{appVersion}</span>
        </div>
      </div>
      {notice && <div className="notice-stack"><div className="notice notice-error"><X size={15} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="关闭通知"><X size={14} /></button></div></div>}
      <section className="page-content">
        <div className="section-heading">
          <div><p>{activePage === 'voice' ? 'VOICE FIRST' : 'BOARD & CONNECTION'}</p><h2>{activePage === 'voice' ? '听、录、按时间回看' : '连接与设备设置'}</h2></div>
          <span className="page-number">{activePage === 'voice' ? '01' : '02'} <span>/ 02</span></span>
        </div>
        <div className="page-body">
          {activePage === 'voice' && <VoiceChat room={room} board={boardOnline ? currentStatus : null} lights={lights} connection={chatRef.current} busyChanged={setChatBusy} disabled={deviceBusy} />}
          {activePage === 'device' && <article className="panel device-page">
            <div className="device-summary">
              <div><span className="section-kicker">CONNECTION</span><h3>EasyInput V2.0</h3><p>{hello ? `固件 ${hello.firmware}` : '等待开发板状态'}{lastSeenAt ? ` · ${new Date(lastSeenAt).toLocaleTimeString('zh-CN')}` : ''}</p></div>
              <span className={`status-chip ${boardOnline ? 'is-live' : 'is-muted'}`}>{boardOnline ? '在线' : '离线'}</span>
            </div>
            <div className="device-status-grid">
              <div><Bell size={17} /><span>每日闹钟</span><strong>{formatTime(alarmMinute)}</strong><small>{alarmMinute === null || alarmMinute === undefined ? '短按 S3，旋钮调节后静置保存' : '北京时间 · 长按 S3 1.2 秒取消'}</small></div>
              <div><Timer size={17} /><span>倒计时</span><strong>{countdownSeconds ? `${Math.ceil(countdownSeconds / 60)} 分钟` : '未运行'}</strong><small>{countdownSeconds ? 'S1～S7／旋钮取消，S8 独立计时' : '短按 S4，旋钮调整 1～60 分钟'}</small></div>
              <div><Timer size={17} /><span>正计时{currentStatus.voice?.stopwatch_running ? ' · 运行中' : ''}</span><strong>{stopwatchTime}</strong><small>短按 S8 开始／停止；停止后播报总时长，重启归零。数值随设备状态更新。</small></div>
              <div><Radio size={17} /><span>实时监听状态</span><strong>{room.realtimeActive ? '监听中' : room.realtimeEnabled ? '开启中' : '关闭'}</strong><small>在语音页打开或关闭</small></div>
              <div><Download size={17} /><span>血压血糖记录</span><button className="text-button" disabled={!room.connected || healthDownloading || deviceBusy} onClick={() => void downloadHealth()}>{healthDownloading ? '正在下载…' : '下载历史 CSV'}</button><small>{room.healthPending ? `板端还有 ${room.healthPending} 条待同步` : '导出云端已同步的全部历史'}</small></div>
              <div><Download size={17} /><span>记账记录</span><button className="text-button" disabled={!room.connected || ledgerDownloading || deviceBusy} onClick={() => void downloadLedger()}>{ledgerDownloading ? '正在下载…' : '下载记账 CSV'}</button><small>{room.ledgerPending ? `板端还有 ${room.ledgerPending} 笔待同步` : '导出云端已同步的全部记账'}</small></div>
            </div>
            {healthNote && <p className="result-note" role="status">{healthNote}</p>}
            {ledgerNote && <p className="result-note" role="status">{ledgerNote}</p>}
            <details className="setup-section">
              <summary><Wifi size={16} />连接 Wi-Fi 与语音服务<ChevronDown size={15} /></summary>
              <p className="light-note">Wi-Fi：{stateLabel(currentStatus.wifi.state)} · {currentStatus.wifi.ssid || '尚未配置'}；USB：{usbProtocolOnline ? '已连接' : serialConnecting ? '连接中' : '未连接'}；蓝牙：{bleConnecting ? '连接中' : bleConnected ? '已连接' : '未连接'}{bleRetrying ? '（等待自动重连）' : ''}</p>
              <p className="light-note">S6 小智对话、S7 转写和实时监听需开发板 Wi-Fi 直连；蓝牙网关可转发历史语音和状态。首次使用 S6／S7，按播报的验证码在小智官方平台绑定。</p>
              <p className="light-note">手机配网：空闲时长按旋钮 3 秒，连接 EasyInput-Setup- 加设备地址后四位的热点（密码 easyinput），打开 http://192.168.4.1，保存 2.4 GHz Wi-Fi。热点开放 2 分钟；小智验证码与云端配对码用途不同。</p>
              <div className="device-actions">
                <button className="button button-subtle" disabled={deviceBusy} onClick={() => void connectBoard()}>{serialConnecting ? <LoaderCircle className="spin" size={15} /> : <Usb size={15} />}{serialOpen ? '重新选择 USB' : '连接 USB'}</button>
                <button className="button button-subtle" disabled={deviceBusy} onClick={() => void (bleConnected ? bleConnectionRef.current?.disconnect() : bleConnectionRef.current?.connect())}><Bluetooth size={15} />{bleConnected ? '断开蓝牙' : '连接蓝牙'}</button>
                {serialOpen && <button className="text-button" onClick={() => void closeSerial()}>断开 USB</button>}
              </div>
              {(serialError || bleError) && <p className="result-note error">{serialError || bleError}</p>}

              <div className="setup-grid">
                <section>
                  <h4>Wi-Fi</h4>
                  {currentStatus.wifi.configured && !wifiEditing ? <div className="saved-network"><strong>{currentStatus.wifi.ssid || 'Wi-Fi 已保存'}</strong><p>开发板开机后会自动连接。</p><button className="text-button" disabled={!configTransport} onClick={() => setWifiEditing(true)}>更换网络</button></div> : <div className="wifi-form"><label>Wi-Fi 名称<input value={wifiSsid} maxLength={32} disabled={!configTransport || wifiBusy} onChange={(event) => setWifiSsid(event.target.value)} placeholder="2.4 GHz Wi-Fi" /></label><label>Wi-Fi 密码<input type="password" value={wifiPassword} maxLength={63} disabled={!configTransport || wifiBusy} onChange={(event) => setWifiPassword(event.target.value)} placeholder="可留空表示开放网络" /></label><button className="button button-primary" disabled={!configTransport || wifiBusy || !wifiSsid.trim()} onClick={() => void sendConfig('wifi.configure')}>保存并连接</button>{wifiEditing && <button className="text-button" onClick={() => setWifiEditing(false)}>取消</button>}</div>}
                  {wifiResult && <p className={`result-note ${wifiResult.ok ? '' : 'error'}`}>{wifiResult.message}</p>}
                </section>
                <section>
                  <h4>语音服务</h4>
                  <p className="light-note">首次配置云端配对码。已配置后可留空。</p>
                  <div className="wifi-form"><label>配对码<input type="password" value={remoteToken} disabled={!configTransport || cloudBusy} onChange={(event) => setRemoteToken(event.target.value)} placeholder="至少 16 位" /></label><button className="button button-subtle" disabled={!configTransport || cloudBusy || remoteToken.length < 16} onClick={() => void sendConfig('cloud.configure')}>保存语音配置</button></div>
                  {cloudResult && <p className={`result-note ${cloudResult.ok ? '' : 'error'}`}>{cloudResult.message}</p>}
                </section>
              </div>
            </details>

            <details className="setup-section">
              <summary><Download size={16} />固件升级<ChevronDown size={15} /></summary>
              <div className="firmware-current"><span>当前固件</span><strong>{hello?.firmware ?? '未读取'}</strong><span>{manifest ? `已导入 ${manifest.version}` : '尚未导入固件包'}</span></div>
              <p className="light-note">选择包含 firmware.json 和三个镜像的完整固件包目录。识别芯片及设备地址后确认写入；写入期间保持供电。自动进入下载模式失败时，保持开机，短按并松开一次 BOOT 后重试；完成后关机再开机，恢复正常使用。</p>
              <input ref={flashFolderRef} type="file" multiple hidden disabled={deviceBusy} {...{ webkitdirectory: '', directory: '' }} onChange={(event) => void importFirmware(event)} />
              <div className="firmware-actions">
                <button className="button button-subtle" disabled={deviceBusy} onClick={() => flashFolderRef.current?.click()}><FileUp size={15} />{manifest ? '重新选择固件包' : '选择固件包'}</button>
                {manifest && !flashCandidate && <button className="button button-primary" disabled={flashPreparing || flashing} onClick={() => void prepareFlash()}>{flashPreparing ? <LoaderCircle className="spin" size={15} /> : <Usb size={15} />}{flashPreparing ? '识别中' : '识别开发板'}</button>}
              </div>
              {packageError && <p className="result-note error">{packageError}</p>}
              {images.length > 0 && !flashCandidate && <div className="image-list">{images.map((image) => <div className="image-detail" key={image.file}><Check size={15} /><strong>{image.file}</strong><small>{formatAddress(image.address)}</small><span>{formatBytes(image.bytes)}</span></div>)}</div>}
              {flashCandidate && <div className="flush-confirm"><div><span>目标</span><strong>{flashCandidate.chip}</strong><code>{flashCandidate.mac}</code></div><label><input type="checkbox" checked={confirmedTarget} disabled={flashing} onChange={(event) => setConfirmedTarget(event.target.checked)} />确认写入固件 {manifest?.version}</label><div className="device-actions"><button className="text-button" disabled={flashing} onClick={cancelFlashCandidate}>取消</button><button className="button button-primary" disabled={!confirmedTarget || flashing} onClick={() => void flashFirmware()}>{flashing ? '写入中' : '确认烧录'}</button></div></div>}
              {flashProgress > 0 && <div className="flash-progress"><span>{flashProgress}%</span><div><i style={{ width: `${flashProgress}%` }} /></div></div>}
              {flashLog && <p className={`result-note ${flashError ? 'error' : ''}`}>{flashLog}</p>}
              {flashError && <p className="result-note error">{flashError}</p>}
            </details>
          </article>}
        </div>
      </section>
    </div>
  </main>
}
