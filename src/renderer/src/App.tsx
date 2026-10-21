import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowDownToLine, Bluetooth, Check, ChevronDown, CircleHelp, Cpu, Download,
  FileUp, HardDrive, Headphones, Lightbulb, Link2, LoaderCircle, Mic, Monitor,
  RotateCw, Usb, Wifi, X, Zap,
} from 'lucide-react'
import { ESPLoader, Transport } from 'esptool-js'
import type { BoardHello, BoardResult, BoardStatus, InputEvent } from '@shared/protocol'
import { describeInputEvent, parseBoardMessage, PROTOCOL_VERSION } from '@shared/protocol'

const FLASH_BYTES = 16 * 1024 * 1024

type FirmwareImageSpec = { file: string; address: number; bytes: number; sha256: string }
type FirmwareManifest = {
  format: string
  formatVersion: number
  board: string
  chip: string
  version: string
  flash: { size: '16MB'; mode: 'dio' | 'qio' | 'dout' | 'qout'; frequency: '80m' | '60m' | '48m' | '40m' | '30m' | '26m' | '24m' | '20m' | '16m' | '15m' | '12m'; eraseAll: false }
  images: FirmwareImageSpec[]
}
type LoadedImage = FirmwareImageSpec & { data: Uint8Array }
type BoardEventRow = InputEvent & { receivedAt: string; rowId: number }
type FlashCandidate = { loader: ESPLoader; transport: Transport; chip: string; mac: string }
type LocalAddress = { name: string; address: string; family: string; netmask: string; mac: string }

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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

function wifiDisconnectReason(code?: number): string {
  const reasons: Record<number, string> = {
    1: '未指定原因', 2: '认证超时', 15: '4 向握手超时', 200: '信标超时 / 信号不稳',
    201: '未找到该 Wi-Fi', 202: '认证失败 / 密码可能错误', 203: '接入点拒绝关联',
    204: '安全握手超时', 210: '没有兼容安全方式的网络', 211: '安全模式不符合设置', 212: '信号低于连接阈值',
  }
  if (code === undefined) return '等待板端诊断'
  return code === 0 ? '无最近断线原因' : `${reasons[code] ?? '其他断线原因'}（代码 ${code}）`
}

function wifiSignalLevel(rssi?: number): number {
  if (rssi === undefined) return 0
  if (rssi >= -55) return 4
  if (rssi >= -67) return 3
  if (rssi >= -78) return 2
  if (rssi >= -90) return 1
  return 0
}

function stateLabel(state?: string): string {
  const labels: Record<string, string> = {
    unknown: '等待数据', disabled: '未启用', disconnected: '未连接', connecting: '连接中',
    connected: '已连接', advertising: '广播中', off: '关闭', on: '开启',
    unavailable: '不可用', idle: '待机', playing: '播放中', active: '采集中',
  }
  return state ? labels[state] ?? state : '等待数据'
}

function stateClass(state?: string): string {
  if (state === 'connected' || state === 'advertising' || state === 'active' || state === 'playing' || state === 'on') return 'is-live'
  if (state === 'connecting') return 'is-warn'
  return 'is-muted'
}

function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours ? `${hours} 小时 ${minutes} 分` : minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
}

function formatAddress(address: number): string {
  return `0x${address.toString(16).padStart(6, '0').toUpperCase()}`
}

async function digestHex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data)
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validateManifest(value: unknown): FirmwareManifest {
  if (!value || typeof value !== 'object') throw new Error('固件清单不是有效对象。')
  const manifest = value as Partial<FirmwareManifest>
  if (manifest.format !== 'easyinput-firmware' || manifest.formatVersion !== 1) throw new Error('固件包格式不受支持。')
  if (manifest.board !== 'easyinput-v2' || manifest.chip !== 'esp32s3') throw new Error('固件包目标不是 EasyInput V2 / ESP32-S3。')
  if (
    typeof manifest.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(manifest.version) ||
    !Array.isArray(manifest.images) || manifest.images.length !== 3
  ) throw new Error('固件清单缺少有效版本或镜像。')
  const flash = manifest.flash as FirmwareManifest['flash'] | undefined
  if (
    !flash || flash.size !== '16MB' || flash.eraseAll !== false ||
    !['dio', 'qio', 'dout', 'qout'].includes(flash.mode) ||
    !['80m', '60m', '48m', '40m', '30m', '26m', '24m', '20m', '16m', '15m', '12m'].includes(flash.frequency)
  ) throw new Error('固件清单中的 Flash 参数不支持或包含整片擦除。')

  const images = manifest.images as FirmwareImageSpec[]
  const sorted = [...images].sort((a, b) => a.address - b.address)
  const allowedOffsets = new Set([0x0, 0x8000, 0x10000])
  const filenames = new Set<string>()
  let previousEnd = -1
  for (const image of sorted) {
    if (
      !image || typeof image !== 'object' ||
      typeof image.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.bin$/i.test(image.file) || filenames.has(image.file) ||
      !Number.isInteger(image.address) || image.address < 0 ||
      !allowedOffsets.has(image.address) ||
      !Number.isInteger(image.bytes) || image.bytes <= 0 ||
      image.address + image.bytes > FLASH_BYTES ||
      !/^[a-f\d]{64}$/i.test(image.sha256)
    ) throw new Error('固件清单包含无效镜像信息。')
    filenames.add(image.file)
    if (image.address < previousEnd) throw new Error('固件镜像地址重叠。')
    previousEnd = image.address + image.bytes
  }
  const offsets = new Set(images.map((image) => image.address))
  if (![0x0, 0x8000, 0x10000].every((address) => offsets.has(address))) throw new Error('固件包必须包含 bootloader、分区表和应用镜像。')
  return manifest as FirmwareManifest
}

export default function App(): React.JSX.Element {
  const [serialOpen, setSerialOpen] = useState(false)
  const [serialError, setSerialError] = useState('')
  const [lastSeen, setLastSeen] = useState('')
  const [lastSeenAt, setLastSeenAt] = useState<number | null>(null)
  const [clock, setClock] = useState(Date.now())
  const [hello, setHello] = useState<BoardHello | null>(null)
  const [status, setStatus] = useState<BoardStatus | null>(null)
  const [wifiResult, setWifiResult] = useState<BoardResult | null>(null)
  const [wifiSsid, setWifiSsid] = useState('')
  const [wifiPassword, setWifiPassword] = useState('')
  const [wifiBusy, setWifiBusy] = useState(false)
  const [bleNotice, setBleNotice] = useState('')
  const [localAddresses, setLocalAddresses] = useState<LocalAddress[]>([])
  const [desktopWallpaper, setDesktopWallpaper] = useState<string | null>(null)
  const [events, setEvents] = useState<BoardEventRow[]>([])
  const [demoMode, setDemoMode] = useState(false)
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
  const portRef = useRef<SerialPort | null>(null)
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  const readTaskRef = useRef<Promise<void> | null>(null)
  const flashFolderRef = useRef<HTMLInputElement | null>(null)
  const wifiSsidRef = useRef<HTMLInputElement | null>(null)
  const eventCounter = useRef(0)

  const appVersion = window.easyinputDesktop?.version ?? '0.1.0'
  const currentStatus = status ?? emptyStatus
  const protocolOnline = Boolean(serialOpen && hello && status && lastSeenAt !== null && clock - lastSeenAt < 3000)
  const usbLabel = !serialOpen ? '未连接' : protocolOnline ? '通信正常' : '串口已打开 · 等待板端协议'
  const usbStateClass = !serialOpen ? 'is-muted' : protocolOnline ? 'is-live' : 'is-warn'
  const micLevel = Math.max(0, Math.min(100, Math.round(((currentStatus.microphone.rms ?? 0) / 32768) * 100)))

  const latestEvents = useMemo(() => events.slice(0, 28), [events])

  useEffect(() => {
    if (!demoMode) return
    setHello({ type: 'hello', protocol: PROTOCOL_VERSION, board: 'easyinput-v2', chip: 'ESP32-S3', firmware: '0.1.0-demo', uptime_ms: 8352000 })
    setStatus({
      type: 'status', protocol: PROTOCOL_VERSION, uptime_ms: 8352000,
      wifi: { state: 'connected', ssid: 'Studio-WiFi', rssi: -48, channel: 6, configured: true, ip: '192.168.1.82', netmask: '255.255.255.0', gateway: '192.168.1.1', dns: '192.168.1.1', disconnect_code: 0, disconnects: 1, retries: 1 },
      ble: { state: 'advertising', name: 'EasyInput' },
      peripherals: { shared_rail: 'on' },
      lights: { status_led: 'on', pixels: ['on', 'off', 'on', 'off', 'off'] },
      speaker: { state: 'idle', volume: 45 },
      microphone: { state: 'active', rms: 5700, vad: true },
      cpu: { frequency_mhz: 160, usage_percent: [18, 11], temperature_c: 43.5 },
      memory: {
        internal: { total_bytes: 328000, free_bytes: 176000, minimum_free_bytes: 148000, largest_block_bytes: 132000 },
        psram: { total_bytes: 8388608, free_bytes: 8120000, largest_block_bytes: 8000000 },
      },
      storage: {
        flash: { state: 'ready', total_bytes: 16777216, unallocated_bytes: 12582912, read_bytes_per_second: 4096, write_bytes_per_second: 0, erase_bytes_per_second: 0 },
        partitions: [
          { label: 'nvs', address: 0x9000, size_bytes: 24576, type: 1, subtype: 2 },
          { label: 'phy_init', address: 0xf000, size_bytes: 4096, type: 1, subtype: 1 },
          { label: 'factory', address: 0x10000, size_bytes: 4128768, type: 0, subtype: 0 },
        ],
        app: { state: 'running', partition_bytes: 4128768, image_bytes: 985456, free_bytes: 3143312 },
        nvs: { state: 'ready', total_bytes: 24576, used_entries: 41, free_entries: 715, total_entries: 756 },
      },
      power: { battery_mv: 4010, external_power: true, charging: true },
    })
    setLastSeen(new Date().toLocaleTimeString('zh-CN'))
    setLastSeenAt(Date.now())
    setEvents([
      { type: 'event', protocol: PROTOCOL_VERSION, source: 'key', key: 'S3', action: 'down', uptime_ms: 8351500, receivedAt: '演示', rowId: 1 },
      { type: 'event', protocol: PROTOCOL_VERSION, source: 'encoder', action: 'rotate', delta: 1, uptime_ms: 8350900, receivedAt: '演示', rowId: 2 },
      { type: 'event', protocol: PROTOCOL_VERSION, source: 'microphone', action: 'vad_start', vad: true, uptime_ms: 8350200, receivedAt: '演示', rowId: 3 },
      { type: 'event', protocol: PROTOCOL_VERSION, source: 'encoder', action: 'down', uptime_ms: 8349500, receivedAt: '演示', rowId: 4 },
    ])
  }, [demoMode])

  useEffect(() => {
    let active = true
    void window.easyinputDesktop?.getDesktopWallpaper().then(({ dataUrl }) => {
      if (active && dataUrl) setDesktopWallpaper(dataUrl)
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    const refresh = async (): Promise<void> => {
      try {
        const addresses = await window.easyinputDesktop?.getNetworkAddresses()
        if (active && addresses) setLocalAddresses(addresses)
      } catch {
        if (active) setLocalAddresses([])
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (!serialOpen) return
    const timer = window.setInterval(() => setClock(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [serialOpen])

  async function closeSerial(): Promise<void> {
    const port = portRef.current
    const reader = readerRef.current
    if (!port) return
    try {
      if (reader) await reader.cancel()
      await readTaskRef.current?.catch(() => undefined)
      if (port.readable?.locked === false || !readerRef.current) await port.close()
    } catch {
      // A USB unplug can close the Web Serial port before the UI sees it.
    }
    readerRef.current = null
    readTaskRef.current = null
    portRef.current = null
    setSerialOpen(false)
    setHello(null)
    setStatus(null)
  }

  async function readSerial(port: SerialPort): Promise<void> {
    if (!port.readable) return
    const reader = port.readable.getReader()
    readerRef.current = reader
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const message = parseBoardMessage(line.trim())
          if (!message) continue
          setLastSeen(new Date().toLocaleTimeString('zh-CN'))
          setLastSeenAt(Date.now())
          if (message.type === 'hello') setHello(message)
          if (message.type === 'status') setStatus(message)
          if (message.type === 'result') {
            setWifiResult(message)
            setWifiBusy(false)
            if (message.action === 'wifi.configure') setWifiPassword('')
          }
          if (message.type === 'event') {
            const row: BoardEventRow = { ...message, receivedAt: new Date().toLocaleTimeString('zh-CN'), rowId: ++eventCounter.current }
            setEvents((previous) => [row, ...previous].slice(0, 80))
          }
        }
      }
    } catch (error) {
      if (portRef.current === port) setSerialError(error instanceof Error ? error.message : 'USB 串口读取失败。')
    } finally {
      reader.releaseLock()
      if (readerRef.current === reader) readerRef.current = null
      if (portRef.current === port) {
        portRef.current = null
        setSerialOpen(false)
        setHello(null)
        setStatus(null)
      }
    }
  }

  async function connectBoard(): Promise<void> {
    setSerialError('')
    setDemoMode(false)
    if (!('serial' in navigator)) {
      setSerialError('当前桌面内核未提供 Web Serial API。')
      return
    }
    try {
      if (portRef.current) await closeSerial()
      const port = await navigator.serial.requestPort()
      await port.open({ baudRate: 115200, bufferSize: 65536 })
      portRef.current = port
      setSerialOpen(true)
      setHello(null)
      setStatus(null)
      setEvents([])
      setLastSeen('')
      setLastSeenAt(null)
      readTaskRef.current = readSerial(port)
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法打开 USB 串口。'
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        setSerialError('未选择串口。请选择列表中的 EasyInput 开发板；如果列表为空，请检查 USB 数据线和开发板供电。')
      } else if (!message.toLowerCase().includes('cancel')) {
        setSerialError(message)
      }
    }
  }

  async function toggleDemoMode(): Promise<void> {
    if (demoMode) {
      setDemoMode(false)
      setHello(null)
      setStatus(null)
      setEvents([])
      setLastSeen('')
      setLastSeenAt(null)
      return
    }
    if (portRef.current) await closeSerial()
    setDemoMode(true)
  }

  async function sendWifiCommand(action: 'wifi.configure' | 'wifi.clear'): Promise<void> {
    const port = portRef.current
    if (!port?.writable || !protocolOnline || wifiBusy) return
    if (action === 'wifi.configure') {
      const ssid = wifiSsid
      const password = wifiPassword
      const passwordBytes = new TextEncoder().encode(password).byteLength
      if (!ssid || new TextEncoder().encode(ssid).byteLength > 32 || (passwordBytes > 0 && (passwordBytes < 8 || passwordBytes > 63))) {
        setWifiResult({ type: 'result', protocol: PROTOCOL_VERSION, action, ok: false, message: '请检查 SSID 和密码长度。' })
        return
      }
    }
    setWifiBusy(true)
    setWifiResult(null)
    try {
      const command: Record<string, unknown> = { type: 'command', protocol: PROTOCOL_VERSION, action }
      if (action === 'wifi.configure') {
        command.ssid = wifiSsid
        command.password = wifiPassword
      }
      const frame = new TextEncoder().encode(`${JSON.stringify(command)}\n`)
      let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
      try {
        writer = port.writable.getWriter()
        await writer.write(frame)
      } finally {
        writer?.releaseLock()
        frame.fill(0)
        if (action === 'wifi.configure') command.password = ''
      }
      if (action === 'wifi.configure') setWifiPassword('')
      window.setTimeout(() => setWifiBusy(false), 12000)
    } catch {
      setWifiBusy(false)
      setWifiPassword('')
      setWifiResult({ type: 'result', protocol: PROTOCOL_VERSION, action, ok: false, message: 'USB 命令发送失败，请确认串口仍连接。' })
    }
  }

  function focusWifiConfiguration(): void {
    if (currentStatus.wifi.ssid) setWifiSsid(currentStatus.wifi.ssid)
    document.getElementById('wifi-config')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => wifiSsidRef.current?.focus(), 350)
  }

  function showBleConnectionNotice(): void {
    setBleNotice('当前固件只进行 BLE 广播，没有为 Studio 提供可连接的 GATT 服务，因此暂时不能建立蓝牙连接。')
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
        if ((await digestHex(data)).toLowerCase() !== spec.sha256.toLowerCase()) throw new Error(`${spec.file} 校验失败，文件可能损坏。`)
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
    setFlashLog('请保持开发板开机，短按并松开 BOOT 后再选择下载端口。')
    setFlashCandidate(null)
    setConfirmedTarget(false)
    setFlashPreparing(true)
    let transport: Transport | null = null
    try {
      await closeSerial()
      setDemoMode(false)
      setHello(null)
      setStatus(null)
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
      const chip = await loader.main('no_reset')
      if (!chip.toLowerCase().includes('esp32-s3')) throw new Error(`识别到 ${chip}，固件要求 ESP32-S3。`)
      const mac = await loader.chip.readMac(loader)
      setFlashCandidate({ loader, transport, chip, mac })
      setFlashLog('芯片与设备地址已读取，请检查目标信息并确认写入。')
    } catch (error) {
      if (transport) await transport.disconnect().catch(() => undefined)
      setFlashError(error instanceof Error ? error.message : '连接下载端口失败。')
      setFlashLog('连接未完成。请检查数据线和下载模式，再由你决定是否重试。')
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
        reportProgress: (_index, written, _fileTotal) => {
          const completedPriorImages = images.slice(0, _index).reduce((sum, image) => sum + image.bytes, 0)
          setFlashProgress(Math.min(100, Math.round(((completedPriorImages + written) / totalBytes) * 100)))
        },
      })
      setFlashProgress(100)
      setFlashLog('镜像写入完成。请关机再开机回到正常运行模式，然后重新连接查看板端状态。')
    } catch (error) {
      setFlashError(error instanceof Error ? error.message : '固件写入失败。')
      setFlashLog('写入失败。保留当前下载模式，检查错误后再决定恢复或重试。')
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
    setFlashLog('目标已取消，板子仍保持当前启动模式。')
  }

  const wifiExtra = currentStatus.wifi.ssid
    ? `${currentStatus.wifi.ssid}${currentStatus.wifi.state === 'connected' && typeof currentStatus.wifi.rssi === 'number' ? ` · ${currentStatus.wifi.rssi} dBm` : currentStatus.wifi.state === 'connecting' ? ' · 正在连接' : ' · 已保存'}`
    : currentStatus.wifi.configured === false
      ? '尚未配置网络'
      : currentStatus.wifi.state === 'connected' && typeof currentStatus.wifi.rssi === 'number'
      ? `${currentStatus.wifi.rssi} dBm`
      : '由板端固件上报'

  return (
    <main className="app-shell" style={desktopWallpaper ? ({ '--desktop-wallpaper': `url("${desktopWallpaper}")` } as React.CSSProperties) : undefined}>
      <aside className="side-rail">
        <div className="brand-mark"><span className="brand-key">E</span><span className="brand-dot" /></div>
        <div className="rail-rule" />
        <button className="rail-button active" aria-label="设备总览"><Monitor size={18} /></button>
        <button className="rail-button" aria-label="固件管理" onClick={() => document.getElementById('firmware-panel')?.scrollIntoView({ behavior: 'smooth' })}><Download size={18} /></button>
        <button className="rail-button" aria-label="输入事件" onClick={() => document.getElementById('events-panel')?.scrollIntoView({ behavior: 'smooth' })}><Activity size={18} /></button>
        <div className="rail-bottom"><CircleHelp size={17} /></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <div className="eyebrow">DEVICE CONTROL CENTER <span className="eyebrow-line" /></div>
            <h1>EasyInput <span>Studio</span></h1>
          </div>
          <div className="topbar-actions">
            <button className="text-button demo-toggle" onClick={() => void toggleDemoMode()}>
              {demoMode ? <Check size={15} /> : <Activity size={15} />}
              {demoMode ? '退出演示' : '预览界面'}
            </button>
            <button className={`button ${serialOpen ? 'button-subtle' : 'button-primary'}`} onClick={() => serialOpen ? void closeSerial() : void connectBoard()}>
              <Usb size={16} /> {serialOpen ? '断开 USB' : '连接开发板'}
            </button>
          </div>
        </header>

        {serialError && <div className="notice notice-error"><X size={16} /><span>{serialError}</span><button onClick={() => setSerialError('')} aria-label="关闭"><X size={14} /></button></div>}

        <div className="page-content">
          <div className="section-heading">
            <div>
              <div className="section-kicker">硬件监控 / 实时遥测</div>
              <h2>设备总览</h2>
            </div>
            <div className="live-clock"><span className={`pulse-dot ${protocolOnline ? 'pulse-on' : ''}`} />{demoMode ? '演示数据' : lastSeen ? `最近数据 ${lastSeen}` : '等待设备数据'}</div>
          </div>

          <div className="device-strip panel">
            <div className="device-avatar"><Cpu size={25} strokeWidth={1.7} /></div>
            <div className="device-identity">
              <div className="device-name">{hello?.board === 'easyinput-v2' ? 'EasyInput V2.0' : 'EasyInput V2.0'} <span className="version-pill">V2</span></div>
              <div className="device-meta"><span>{hello?.chip ?? 'ESP32-S3R8'}</span><i /> <span>AI Keyboard V2.1</span> <i /> <span>固件 {hello?.firmware ?? '未读取'}</span></div>
            </div>
            <div className="device-runtime"><span>运行时长</span><strong>{status ? formatDuration(status.uptime_ms) : '—'}</strong></div>
            <div className="device-divider" />
            <div className="usb-summary">
              <div className="usb-icon"><Usb size={17} /></div>
              <div><span>USB-C / 原生串口</span><strong className={usbStateClass}>{usbLabel}</strong></div>
            </div>
            {!serialOpen && <button className="icon-button connect-small" onClick={() => void connectBoard()} aria-label="连接开发板"><Link2 size={17} /></button>}
          </div>

          <article className="firmware-card panel" id="firmware-panel">
            <div className="panel-heading">
              <div><div className="section-kicker">FIRMWARE MANAGER</div><h3>固件管理</h3></div>
              <div className="firmware-hex"><ArrowDownToLine size={17} /></div>
            </div>
            <div className="firmware-current">
              <div className="firmware-ring"><Cpu size={19} /></div>
              <div><small>板载固件</small><strong>{hello?.firmware ?? '未读取'}</strong></div>
              <span className={`firmware-tag ${hello ? 'tag-ready' : ''}`}>{hello ? '运行中' : '待连接'}</span>
            </div>
            <div className="firmware-layout">
              <div className="firmware-package">
                <div className="package-title"><span>本地固件包</span>{manifest && <span className="package-ready"><Check size={12} />已校验</span>}</div>
                <div className={`package-drop ${manifest ? 'package-loaded' : ''}`} onClick={() => flashFolderRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') flashFolderRef.current?.click() }}>
                  <input ref={flashFolderRef} type="file" multiple hidden {...{ webkitdirectory: '', directory: '' }} onChange={(event) => void importFirmware(event)} />
                  <span className="upload-icon">{manifest ? <Check size={17} /> : <FileUp size={17} />}</span>
                  <span className="drop-copy"><strong>{manifest ? `版本 ${manifest.version}` : '导入固件包目录'}</strong><small>{manifest ? `${images.length} 个镜像 · SHA-256 已验证` : '选择包含 firmware.json 与镜像文件的目录'}</small></span>
                  <ChevronDown size={15} className="drop-chevron" />
                </div>
                {packageError && <div className="inline-error">{packageError}</div>}
                {manifest && <div className="image-list">{images.map((image) => <div className="image-row" key={image.file}><span>{image.file}</span><code>{formatAddress(image.address)}</code><small>{(image.bytes / 1024).toFixed(0)} KB</small></div>)}</div>}
              </div>
              <div className="firmware-flash">
                {flashProgress > 0 && <div className="flash-progress-wrap"><div className="flash-progress-label"><span>{flashing ? '正在烧录' : '烧录进度'}</span><strong>{flashProgress}%</strong></div><div className="flash-progress"><i style={{ width: `${flashProgress}%` }} /></div></div>}
                {flashLog && <div className="flash-log"><span className={flashError ? 'log-error' : ''}>{flashLog}</span></div>}
                {flashError && <div className="inline-error">{flashError}</div>}
                {flashCandidate ? (
                  <div className="flash-confirm">
                    <div className="target-heading"><span className="target-check"><Check size={15} /></span><div><small>已验证烧录目标</small><strong>{flashCandidate.chip}</strong></div></div>
                    <div className="target-details"><span>设备 MAC</span><code>{flashCandidate.mac}</code></div>
                    <div className="target-details"><span>目标固件</span><code>{manifest?.version}</code></div>
                    <label className="confirm-check"><input type="checkbox" checked={confirmedTarget} onChange={(event) => setConfirmedTarget(event.target.checked)} /><span>确认将以上固件写入这台设备</span></label>
                    <div className="flash-confirm-actions"><button className="text-button" onClick={cancelFlashCandidate}>取消</button><button className="button button-primary flash-button" disabled={!confirmedTarget || flashing} onClick={() => void flashFirmware()}>{flashing ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}确认烧录</button></div>
                  </div>
                ) : (
                  <button className="button button-primary flash-button full-button" disabled={!manifest || flashPreparing || flashing} onClick={() => void prepareFlash()}>
                    {flashPreparing ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
                    {flashPreparing ? '正在识别芯片…' : '进入下载模式并识别设备'}
                  </button>
                )}
                <div className="flash-footnote"><span className="footnote-icon">i</span><span>仅写入清单列出的镜像，不擦除整片 Flash。烧录后按板上电源开关关机再开机。</span></div>
              </div>
            </div>
          </article>

          <div className="dashboard-grid">
            <div className="status-column">
              <div className="status-grid">
                <article className="status-card panel">
                  <div className="card-topline"><div className="card-icon wifi-icon"><Wifi size={18} /></div><button className="card-connect-button" onClick={focusWifiConfiguration}>连接</button></div>
                  <div className="card-label">Wi-Fi</div>
                  <div className="status-value-row"><strong className={stateClass(currentStatus.wifi.state)}>{stateLabel(currentStatus.wifi.state)}</strong><span className="status-dash" /></div>
                  <div className="card-foot"><span>{wifiExtra}{currentStatus.wifi.state === 'connected' && currentStatus.wifi.channel ? ` · 信道 ${currentStatus.wifi.channel}` : ''}</span>{currentStatus.wifi.state === 'connected' && typeof currentStatus.wifi.rssi === 'number' && <span className="signal-bars" aria-label={`信号强度 ${currentStatus.wifi.rssi} dBm`}>{[1, 2, 3, 4].map((level) => <i key={level} className={wifiSignalLevel(currentStatus.wifi.rssi) >= level ? '' : 'signal-muted'} />)}</span>}</div>
                </article>
                <article className="status-card panel">
                  <div className="card-topline"><div className="card-icon bluetooth-icon"><Bluetooth size={17} /></div><button className="card-connect-button" onClick={showBleConnectionNotice}>连接</button></div>
                  <div className="card-label">Bluetooth LE</div>
                  <div className="status-value-row"><strong className={stateClass(currentStatus.ble.state)}>{stateLabel(currentStatus.ble.state)}</strong><span className="status-dash" /></div>
                  <div className="card-foot"><span>{currentStatus.ble.name ?? (currentStatus.ble.peers !== undefined ? `${currentStatus.ble.peers} 个连接` : '由板端固件上报')}</span><span className="bluetooth-wave"><i /><i /><i /></span></div>
                  {bleNotice && <p className="ble-notice">{bleNotice}</p>}
                </article>
              </div>

              <article className="peripheral-card panel">
                <div className="panel-heading">
                  <div><div className="section-kicker">OUTPUTS</div><h3>灯光与电源</h3></div>
                  <span className={`status-chip ${stateClass(currentStatus.peripherals.shared_rail)}`}>{currentStatus.peripherals.shared_rail === 'on' ? '外设电源已开' : currentStatus.peripherals.shared_rail === 'off' ? '共享电源关闭' : '等待数据'}</span>
                </div>
                <div className="led-row">
                  <div className="led-title"><span className="led-symbol"><Lightbulb size={16} /></span><div><strong>WS2812 灯带</strong><small>5 颗串联 · GPIO12</small></div></div>
                  <div className="pixel-list" aria-label="五颗灯珠状态">
                    {Array.from({ length: 5 }, (_, index) => {
                      const pixelState = currentStatus.lights.pixels[index] ?? 'unknown'
                      return <span key={index} className={`pixel ${pixelState === 'on' ? 'pixel-on' : ''} ${pixelState === 'unknown' ? 'pixel-unknown' : ''}`} />
                    })}
                  </div>
                </div>
                <div className="led-row led-row-last">
                  <div className="led-title"><span className="green-indicator"><i /></span><div><strong>状态指示灯</strong><small>GPIO42 · PWM</small></div></div>
                  <div className="status-inline"><span className={`tiny-dot ${currentStatus.lights.status_led === 'on' ? 'tiny-dot-on' : ''}`} />{stateLabel(currentStatus.lights.status_led)}</div>
                </div>
                <div className="power-note"><span className="power-line" />GPIO8 控制灯、麦克风与扬声器共享电源</div>
              </article>

              <article className="audio-card panel">
                <div className="panel-heading">
                  <div><div className="section-kicker">AUDIO I/O</div><h3>音频设备</h3></div>
                  <span className="audio-state"><span className={`pulse-dot ${currentStatus.microphone.state === 'active' ? 'pulse-on' : ''}`} />{stateLabel(currentStatus.microphone.state)}</span>
                </div>
                <div className="audio-devices">
                  <div className="audio-device">
                    <div className="audio-device-name"><span className="audio-icon"><Mic size={16} /></span><div><strong>麦克风</strong><small>输入 · I²S</small></div></div>
                    <div className="meter-wrap"><div className="meter"><i style={{ width: `${micLevel}%` }} /></div><span>{micLevel}%</span></div>
                  </div>
                  <div className="audio-device speaker-device">
                    <div className="audio-device-name"><span className="audio-icon speaker-icon"><Headphones size={16} /></span><div><strong>扬声器</strong><small>输出 · MAX98357A</small></div></div>
                    <span className={`speaker-status ${stateClass(currentStatus.speaker.state)}`}>{stateLabel(currentStatus.speaker.state)}</span>
                  </div>
                </div>
                <div className="audio-foot"><span><span className={`tiny-dot ${currentStatus.microphone.vad ? 'tiny-dot-on' : ''}`} />语音活动 {currentStatus.microphone.vad ? '检测中' : '未检测'}</span><span>{typeof currentStatus.speaker.volume === 'number' ? `音量 ${currentStatus.speaker.volume}%` : '音频状态由固件上报'}</span></div>
                {(currentStatus.peripherals.shared_rail === 'off' || currentStatus.microphone.state === 'unavailable' || currentStatus.speaker.state === 'unavailable') && <p className="audio-protection-note">固件保护：GPIO8 是灯光、麦克风和扬声器的共享电源，目前保持关闭；完成共享电源时序验证后，固件才会启用音频设备。</p>}
              </article>
            </div>

            <div className="right-column">
              <article className="events-card panel" id="events-panel">
                <div className="panel-heading events-heading">
                  <div><div className="section-kicker">INPUT STREAM</div><h3>实时输入事件 <span className="count-pill">{events.length}</span></h3></div>
                  <div className="event-live"><span className={`pulse-dot ${protocolOnline || demoMode ? 'pulse-on' : ''}`} />{protocolOnline || demoMode ? 'LIVE' : '等待输入'}</div>
                </div>
                <div className="event-filter-row"><span>来源</span><span className="filter-chip"><span className="filter-dot key-dot" />按键</span><span className="filter-chip"><span className="filter-dot encoder-dot" />旋钮</span><span className="filter-chip"><span className="filter-dot mic-dot" />麦克风</span><button className="clear-events" onClick={() => setEvents([])}>清空</button></div>
                <div className="event-list">
                  {latestEvents.length === 0 ? (
                    <div className="empty-events"><div className="empty-wave"><Activity size={21} /></div><strong>等待开发板输入</strong><span>按键、旋钮与麦克风事件会实时出现在这里</span><div className="key-hint"><kbd>S1</kbd><kbd>S2</kbd><kbd>S3</kbd><span>…</span><kbd>S8</kbd><span className="hint-sep" /> <RotateCw size={13} /> 旋钮</div></div>
                  ) : latestEvents.map((event) => (
                    <div className="event-row" key={event.rowId}>
                      <div className={`event-source-icon ${event.source}`}>
                        {event.source === 'key' ? <span>{event.key?.replace('S', '') ?? 'K'}</span> : event.source === 'encoder' ? <RotateCw size={15} /> : <Mic size={15} />}
                      </div>
                      <div className="event-copy"><strong>{describeInputEvent(event)}</strong><span>{event.source === 'key' ? '物理按键' : event.source === 'encoder' ? '旋转编码器' : 'I²S 麦克风'}</span></div>
                      <time>{event.receivedAt}</time>
                      <span className="event-arrow">↗</span>
                    </div>
                  ))}
                </div>
                <div className="events-footer"><span><span className="footer-led" />协议版本 {hello?.protocol ?? PROTOCOL_VERSION}</span><span>接收 {events.length} 条</span></div>
              </article>

              <div className="usb-tip"><span className="tip-icon"><Usb size={15} /></span><span>当前板只有一个原生 USB-C。需要烧录时，开机状态短按并松开 BOOT 进入下载模式。</span></div>
            </div>
          </div>

          <section className="diagnostics-grid" aria-label="设备资源和网络诊断">
            <article className="diagnostic-card panel">
              <div className="panel-heading">
                <div><div className="section-kicker">SYSTEM TELEMETRY</div><h3>性能、内存与存储</h3></div>
                <span className="diagnostic-chip">{currentStatus.cpu.frequency_mhz || '—'} MHz</span>
              </div>
              <div className="metric-section">
                <div className="metric-section-heading"><Cpu size={14} /><strong>CPU</strong><span>{currentStatus.cpu.temperature_c !== undefined ? `${currentStatus.cpu.temperature_c.toFixed(1)}°C 芯片温度` : '芯片温度不可用'}</span></div>
                <div className="cpu-core-list">
                  {currentStatus.cpu.usage_percent.map((usage, index) => <div className="cpu-core" key={index}><span>核心 {index}</span><div className="metric-bar"><i style={{ width: `${Math.min(100, Math.max(0, usage))}%` }} /></div><strong>{usage.toFixed(0)}%</strong></div>)}
                  {currentStatus.cpu.usage_percent.length === 0 && <span className="metric-empty">等待 CPU 采样</span>}
                </div>
              </div>
              <div className="metric-section">
                <div className="metric-section-heading"><Zap size={14} /><strong>RAM / PSRAM</strong><span>空闲 / 总量 · 最大连续块</span></div>
                <div className="resource-list">
                  <div><span>内部 RAM</span><strong>{formatBytes(currentStatus.memory.internal.free_bytes)} / {formatBytes(currentStatus.memory.internal.total_bytes)}</strong><small>最低空闲 {formatBytes(currentStatus.memory.internal.minimum_free_bytes)} · 最大块 {formatBytes(currentStatus.memory.internal.largest_block_bytes)}</small></div>
                  <div><span>外置 PSRAM</span><strong>{formatBytes(currentStatus.memory.psram.free_bytes)} / {formatBytes(currentStatus.memory.psram.total_bytes)}</strong><small>最大连续块 {formatBytes(currentStatus.memory.psram.largest_block_bytes)}</small></div>
                </div>
              </div>
              <div className="metric-section">
                <div className="metric-section-heading"><HardDrive size={14} /><strong>Flash 存储</strong><span>{formatBytes(currentStatus.storage.flash.total_bytes)} 总容量</span></div>
                <div className="storage-summary"><span>Flash 状态<strong>{currentStatus.storage.flash.state === 'ready' ? '正常' : '等待数据'} · 末尾空闲 {formatBytes(currentStatus.storage.flash.unallocated_bytes)}</strong></span><span>运行分区<strong>{currentStatus.storage.app.state === 'running' ? '运行中' : '等待数据'} · 可用 {formatBytes(currentStatus.storage.app.free_bytes)} / {formatBytes(currentStatus.storage.app.partition_bytes)}</strong></span><span>NVS {formatBytes(currentStatus.storage.nvs.total_bytes)} · {currentStatus.storage.nvs.state === 'ready' ? '正常' : '不可用'}<strong>剩余 {currentStatus.storage.nvs.free_entries} / {currentStatus.storage.nvs.total_entries} 项</strong></span></div>
                <div className="flash-rates"><span>读 {formatRate(currentStatus.storage.flash.read_bytes_per_second)}</span><span>写 {formatRate(currentStatus.storage.flash.write_bytes_per_second)}</span><span>擦除 {formatRate(currentStatus.storage.flash.erase_bytes_per_second)}</span></div>
                <div className="partition-list">
                  {currentStatus.storage.partitions.map((partition) => <div className="partition-row" key={`${partition.label}-${partition.address}`}><span>{partition.label}</span><code>0x{partition.address.toString(16).toUpperCase()}</code><strong>{formatBytes(partition.size_bytes)}</strong></div>)}
                  {currentStatus.storage.partitions.length === 0 && <span className="metric-empty">等待分区信息</span>}
                </div>
                <p className="metric-footnote">Flash 速率统计 ESP-IDF Flash API 调用；CPU 使用率按各核心空闲时间估算。</p>
              </div>
            </article>

            <div className="network-column">
              <article className="diagnostic-card panel">
                <div className="panel-heading">
                  <div><div className="section-kicker">WI-FI DIAGNOSTICS</div><h3>Wi-Fi 连接诊断</h3></div>
                  <span className={`diagnostic-chip ${stateClass(currentStatus.wifi.state)}`}>{stateLabel(currentStatus.wifi.state)}</span>
                </div>
                <div className="network-details">
                  <div><span>SSID</span><strong>{currentStatus.wifi.ssid ?? (currentStatus.wifi.configured ? '正在获取…' : '尚未配置')}</strong></div>
                  <div><span>IP 地址</span><strong>{currentStatus.wifi.ip ?? '—'}</strong></div>
                  <div><span>子网掩码</span><strong>{currentStatus.wifi.netmask ?? '—'}</strong></div>
                  <div><span>网关 / DNS</span><strong>{[currentStatus.wifi.gateway, currentStatus.wifi.dns].filter(Boolean).join(' / ') || '—'}</strong></div>
                  <div><span>信号 / 信道</span><strong>{currentStatus.wifi.state === 'connected' && currentStatus.wifi.rssi !== undefined ? `${currentStatus.wifi.rssi} dBm` : '—'}{currentStatus.wifi.state === 'connected' && currentStatus.wifi.channel ? ` / ${currentStatus.wifi.channel}` : ''}</strong></div>
                  <div><span>重连 / 断线次数</span><strong>{currentStatus.wifi.retries ?? '—'} / {currentStatus.wifi.disconnects ?? '—'}</strong></div>
                  <div className="network-reason"><span>最近断线原因</span><strong>{wifiDisconnectReason(currentStatus.wifi.disconnect_code)}</strong></div>
                </div>
                <form className="wifi-config" id="wifi-config" onSubmit={(event) => { event.preventDefault(); void sendWifiCommand('wifi.configure') }}>
                  <div className="metric-section-heading"><Wifi size={14} /><strong>配置 Wi-Fi</strong></div>
                  <label>网络名称 (SSID)<input ref={wifiSsidRef} autoComplete="off" maxLength={32} value={wifiSsid} onChange={(event) => setWifiSsid(event.target.value)} placeholder="输入 2.4 GHz Wi-Fi 名称" /></label>
                  <label>密码<input autoComplete="new-password" maxLength={63} type="password" value={wifiPassword} onChange={(event) => setWifiPassword(event.target.value)} placeholder="WPA 密码；开放网络留空" /></label>
                  <div className="wifi-actions"><button className="button button-primary" type="submit" disabled={!protocolOnline || wifiBusy}>{wifiBusy ? <LoaderCircle size={14} className="spin" /> : <Wifi size={14} />}保存并连接</button><button className="text-button" type="button" disabled={!protocolOnline || wifiBusy || !currentStatus.wifi.configured} onClick={() => void sendWifiCommand('wifi.clear')}>清除配置</button></div>
                  {wifiResult && <p className={wifiResult.ok ? 'wifi-result' : 'wifi-result error'}>{wifiResult.message ?? (wifiResult.ok ? '操作完成。' : '操作失败。')}</p>}
                  <p className="metric-footnote">密码经 USB 发送并保存在开发板未加密的 NVS 中。界面不会回显密码；请仅在可信的本地 USB 连接上配网。</p>
                </form>
              </article>

              <article className="diagnostic-card panel host-network-card">
                <div className="panel-heading"><div><div className="section-kicker">HOST NETWORK</div><h3>本机网络地址</h3></div><Monitor size={16} className="host-network-icon" /></div>
                <div className="host-address-list">
                  {localAddresses.map((address) => <div className="host-address" key={`${address.name}-${address.address}`}><div><strong>{address.name}</strong><span>{address.family} · {address.address} · 掩码 {address.netmask}</span></div><code>{address.mac}</code></div>)}
                  {localAddresses.length === 0 && <span className="metric-empty">未发现已连接的网络接口</span>}
                </div>
              </article>

              <article className="diagnostic-card panel power-diagnostic-card">
                <div className="panel-heading"><div><div className="section-kicker">POWER</div><h3>供电状态</h3></div><Zap size={16} className="host-network-icon" /></div>
                <div className="power-details"><span>电池电压<strong>{currentStatus.power.battery_mv !== undefined ? `${(currentStatus.power.battery_mv / 1000).toFixed(3)} V` : '不可用'}</strong></span><span>外部供电<strong>{currentStatus.power.external_power === undefined ? '等待数据' : currentStatus.power.external_power ? '已连接' : '未连接'}</strong></span><span>充电状态<strong>{currentStatus.power.charging === undefined ? '未知' : currentStatus.power.charging ? '正在充电' : '未充电'}</strong></span></div>
                <p className="metric-footnote">当前按硬件电源检测脚与 ADC 电压上报；板上没有电量计，故不估算剩余百分比。</p>
              </article>
            </div>
          </section>

          <footer className="app-footer"><span>EasyInput V2.0 <span className="footer-separator">/</span> PCB AI Keyboard V2.1</span><span>本机应用 · v{appVersion}</span></footer>
        </div>
      </section>
    </main>
  )
}
