import { useEffect, useRef, useState } from 'react'
import { version as appVersion } from '../../../package.json'
import { registerSW } from 'virtual:pwa-register'
import {
  Activity, ArrowLeft, ArrowRight, Bluetooth, Check, ChevronDown, Cpu, Download,
  FileUp, HardDrive, Headphones, Lightbulb, LoaderCircle, Mic, Monitor,
  RotateCw, SlidersHorizontal, Usb, Wifi, X, Zap,
} from 'lucide-react'
import { ESPLoader, Transport } from 'esptool-js'
import { BluetoothConnection } from './services/bluetooth'
import { readSavedRemote, WifiConnection } from './services/wifi'
import { BoardConnections } from '@shared/connections'
import type { BoardTransport } from '@shared/connections'
import type { BoardHello, BoardMessage, BoardResult, BoardStatus, InputEvent, LightCommand, AudioCommand, PixelSetting } from '@shared/protocol'
import { describeInputEvent, commandResultMatches, pixelIsLit, PROTOCOL_VERSION } from '@shared/protocol'

const FLASH_BYTES = 16 * 1024 * 1024
const pages = [
  { id: 'overview', label: '总览', title: '设备总览', caption: '一眼了解你的设备', icon: Monitor },
  { id: 'control', label: '控制', title: '随心控制', caption: '灯光与声音，触手可及', icon: SlidersHorizontal },
  { id: 'network', label: '网络', title: '保持连接', caption: '管理网络与无线监控', icon: Wifi },
  { id: 'system', label: '系统', title: '运行状态', caption: '设备资源，清晰可见', icon: Cpu },
  { id: 'firmware', label: '固件', title: '固件管理', caption: '让设备保持更新', icon: Download },
] as const
type Page = typeof pages[number]['id']

function Pagination({ page, count, onChange }: { page: number; count: number; onChange: (page: number) => void }): React.JSX.Element {
  return <nav className="pagination" aria-label="列表分页">
    <button className="page-button" disabled={page === 0} onClick={() => onChange(page - 1)} aria-label="上一页"><ArrowLeft size={16} /></button>
    <span>第 <strong>{page + 1}</strong> / {count} 页</span>
    <button className="page-button" disabled={page >= count - 1} onClick={() => onChange(page + 1)} aria-label="下一页"><ArrowRight size={16} /></button>
  </nav>
}

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
  const [activePage, setActivePage] = useState<Page>('overview')
  const [overviewTab, setOverviewTab] = useState('device')
  const [controlTab, setControlTab] = useState('pixels')
  const [systemTab, setSystemTab] = useState('performance')
  const [eventPage, setEventPage] = useState(0)
  const [partitionPage, setPartitionPage] = useState(0)
  const [eventRows, setEventRows] = useState(3)
  const [partitionRows, setPartitionRows] = useState(4)
  const eventListRef = useRef<HTMLDivElement | null>(null)
  const partitionListRef = useRef<HTMLDivElement | null>(null)
  const [serialOpen, setSerialOpen] = useState(false)
  const [serialConnecting, setSerialConnecting] = useState(false)
  const [serialError, setSerialError] = useState('')
  const [demoLastSeen, setDemoLastSeen] = useState('')
  const [demoLastSeenAt, setDemoLastSeenAt] = useState<number | null>(null)
  const [clock, setClock] = useState(Date.now())
  const [demoHello, setDemoHello] = useState<BoardHello | null>(null)
  const [demoStatus, setDemoStatus] = useState<BoardStatus | null>(null)
  const [, refreshConnections] = useState(0)
  const [wifiResult, setWifiResult] = useState<BoardResult | null>(null)
  const [wifiSsid, setWifiSsid] = useState('')
  const [wifiPassword, setWifiPassword] = useState('')
  const [wifiEditing, setWifiEditing] = useState(false)
  const [wifiBusy, setWifiBusy] = useState(false)
  const [outputBusy, setOutputBusy] = useState(false)
  const [lightResult, setLightResult] = useState<BoardResult | null>(null)
  const [audioResult, setAudioResult] = useState<BoardResult | null>(null)
  const [selectedPixel, setSelectedPixel] = useState(0)
  const [pixelDraft, setPixelDraft] = useState<PixelSetting>({ color: '#ffffff', brightness: 20, on: true })
  const [pixelDirty, setPixelDirty] = useState(false)
  const [indicatorDraft, setIndicatorDraft] = useState(0)
  const [indicatorDirty, setIndicatorDirty] = useState(false)
  const [bleConnected, setBleConnected] = useState(false)
  const [bleConnecting, setBleConnecting] = useState(false)
  const [bleRetrying, setBleRetrying] = useState(false)
  const [bleError, setBleError] = useState('')
  const [wifiMonitorConnected, setWifiMonitorConnected] = useState(false)
  const [wifiMonitorConnecting, setWifiMonitorConnecting] = useState(false)
  const [wifiMonitorRetrying, setWifiMonitorRetrying] = useState(false)
  const [wifiMonitorError, setWifiMonitorError] = useState('')
  const [wifiAddress, setWifiAddress] = useState('')
  const [savedRemote] = useState(readSavedRemote)
  const [remoteGateway, setRemoteGateway] = useState(() => savedRemote?.gateway ?? '')
  const [remoteDevice, setRemoteDevice] = useState(() => savedRemote?.device ?? 'easyinput-v2')
  const [remoteToken, setRemoteToken] = useState(() => savedRemote?.token ?? '')
  const [cloudBusy, setCloudBusy] = useState(false)
  const [cloudResult, setCloudResult] = useState<BoardResult | null>(null)
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
  const [updateWaiting, setUpdateWaiting] = useState(false)
  const [confirmedTarget, setConfirmedTarget] = useState(false)
  const portRef = useRef<SerialPort | null>(null)
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  const readTaskRef = useRef<Promise<void> | null>(null)
  const bleConnectionRef = useRef<BluetoothConnection | null>(null)
  const wifiConnectionRef = useRef<WifiConnection | null>(null)
  const serialConnectRequestRef = useRef(false)
  const connectionsRef = useRef(new BoardConnections())
  const pendingWifiActionRef = useRef<string | null>(null)
  const pendingWifiTransportRef = useRef<BoardTransport | null>(null)
  const wifiTimeoutRef = useRef<number | null>(null)
  const pendingOutputRef = useRef<{ action: string; requestId: string } | null>(null)
  const outputTimeoutRef = useRef<number | null>(null)
  const demoToneTimerRef = useRef<number | null>(null)
  const flashFolderRef = useRef<HTMLInputElement | null>(null)
  const wifiSsidRef = useRef<HTMLInputElement | null>(null)
  const eventCounter = useRef(0)
  const updateSWRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null)
  const updateStartedRef = useRef(false)

  const activeConnection = connectionsRef.current.current(clock)
  const hello = demoMode ? demoHello : activeConnection?.session.hello ?? null
  const status = demoMode ? demoStatus : activeConnection?.session.status ?? null
  const lastSeenAt = demoMode ? demoLastSeenAt : activeConnection?.session.lastSeenAt ?? null
  const lastSeen = demoMode ? demoLastSeen : lastSeenAt === null ? '' : new Date(lastSeenAt).toLocaleTimeString('zh-CN')
  const currentStatus = status ?? emptyStatus
  const dataTransportOpen = serialOpen || bleConnected || wifiMonitorConnected || wifiMonitorConnecting
  const deviceBusy = flashing || flashPreparing || flashCandidate !== null
  const updateBlocked = dataTransportOpen || serialConnecting || bleConnecting || wifiBusy || outputBusy || flashing || flashPreparing || flashCandidate !== null
  const usbProtocolOnline = serialOpen && connectionsRef.current.isOnline('usb', clock)
  const bleProtocolOnline = bleConnected && connectionsRef.current.isOnline('ble', clock)
  const wifiProtocolOnline = wifiMonitorConnected && connectionsRef.current.isOnline('wifi', clock)
  const wifiConfigOnline = usbProtocolOnline || bleProtocolOnline
  const protocolOnline = wifiConfigOnline || wifiProtocolOnline
  const usbLabel = !serialOpen ? '未连接' : usbProtocolOnline ? '通信正常' : '串口已打开 · 等待板端协议'
  const usbStateClass = !serialOpen ? 'is-muted' : usbProtocolOnline ? 'is-live' : 'is-warn'
  const bleLabel = bleConnecting ? '连接中' : bleRetrying ? '等待自动重连' : bleConnected ? bleProtocolOnline ? '已连接' : '已连接 · 等待数据' : demoMode ? stateLabel(currentStatus.ble.state) : '未连接'
  const bleStateClass = bleConnecting || bleRetrying || (bleConnected && !bleProtocolOnline) ? 'is-warn'
    : bleConnected ? 'is-live' : demoMode ? stateClass(currentStatus.ble.state) : 'is-muted'
  const recentMic = currentStatus.microphone.state === 'active' ? events.find((event) => event.source === 'microphone' && event.uptime_ms >= currentStatus.uptime_ms && event.uptime_ms - currentStatus.uptime_ms < 2500) : undefined
  const micLevel = Math.max(0, Math.min(100, Math.round(((recentMic?.rms ?? currentStatus.microphone.rms ?? 0) / 32768) * 100)))
  const micVad = recentMic?.vad ?? currentStatus.microphone.vad
  const lightControl = currentStatus.lights.control
  const lightsEditable = Boolean(lightControl?.ready && (demoMode || wifiConfigOnline) && !deviceBusy && !wifiBusy && !outputBusy)
  const audioEditable = Boolean(currentStatus.audio?.ready && (demoMode || wifiConfigOnline) && !deviceBusy && !wifiBusy && !outputBusy)
  const selectedSetting = lightControl?.pixels[selectedPixel]

  const eventPageCount = Math.max(1, Math.ceil(events.length / eventRows))
  const currentEventPage = Math.min(eventPage, eventPageCount - 1)
  const visibleEvents = events.slice(currentEventPage * eventRows, (currentEventPage + 1) * eventRows)
  const partitionPageCount = Math.max(1, Math.ceil(currentStatus.storage.partitions.length / partitionRows))
  const currentPartitionPage = Math.min(partitionPage, partitionPageCount - 1)
  const visiblePartitions = currentStatus.storage.partitions.slice(currentPartitionPage * partitionRows, (currentPartitionPage + 1) * partitionRows)

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === eventListRef.current) setEventRows(Math.max(1, Math.floor(entry.contentRect.height / 58)))
        if (entry.target === partitionListRef.current) setPartitionRows(Math.max(1, Math.floor(entry.contentRect.height / 48)))
      }
    })
    if (eventListRef.current) observer.observe(eventListRef.current)
    if (partitionListRef.current) observer.observe(partitionListRef.current)
    return () => observer.disconnect()
  }, [activePage, overviewTab, systemTab])

  useEffect(() => {
    if (!pixelDirty && selectedSetting) setPixelDraft({ ...selectedSetting })
  }, [selectedPixel, selectedSetting?.color, selectedSetting?.brightness, selectedSetting?.on, pixelDirty])

  useEffect(() => {
    if (!indicatorDirty && lightControl) setIndicatorDraft(lightControl.status_led_brightness)
  }, [lightControl?.status_led_brightness, indicatorDirty])

  useEffect(() => () => {
    if (outputTimeoutRef.current !== null) window.clearTimeout(outputTimeoutRef.current)
    if (demoToneTimerRef.current !== null) window.clearTimeout(demoToneTimerRef.current)
  }, [])

  useEffect(() => {
    const connection = new BluetoothConnection({
      connected: setBleConnected,
      connecting: setBleConnecting,
      retrying: setBleRetrying,
      notice: setBleError,
      reset: () => resetTransport('ble'),
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
    const connection = new WifiConnection({
      connected: setWifiMonitorConnected,
      connecting: setWifiMonitorConnecting,
      retrying: setWifiMonitorRetrying,
      notice: setWifiMonitorError,
      address: setWifiAddress,
      reset: () => resetTransport('wifi'),
      text: (text) => handleProtocolText('wifi', text),
    })
    wifiConnectionRef.current = connection
    connection.start()
    return () => {
      connection.dispose()
      if (wifiConnectionRef.current === connection) wifiConnectionRef.current = null
    }
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
    if (!updateWaiting || updateBlocked || updateStartedRef.current) return
    const updateSW = updateSWRef.current
    if (!updateSW) return
    updateStartedRef.current = true
    void updateSW(true).catch(() => { updateStartedRef.current = false })
  }, [updateBlocked, updateWaiting])

  useEffect(() => {
    if (!demoMode) return
    setDemoHello({ type: 'hello', protocol: PROTOCOL_VERSION, board: 'easyinput-v2', chip: 'ESP32-S3', firmware: '0.1.0-demo', uptime_ms: 8352000 })
    setDemoStatus({
      type: 'status', protocol: PROTOCOL_VERSION, uptime_ms: 8352000,
      wifi: { state: 'connected', ssid: 'Studio-WiFi', rssi: -48, channel: 6, configured: true, ip: '192.168.1.82', netmask: '255.255.255.0', gateway: '192.168.1.1', dns: '192.168.1.1', disconnect_code: 0, disconnects: 1, retries: 1 },
      ble: { state: 'advertising', name: 'EasyInput' },
      peripherals: { shared_rail: 'on' },
      lights: {
        status_led: 'on', pixels: ['on', 'off', 'on', 'off', 'off'],
        control: { ready: true, status_led_brightness: 20, pixels: Array.from({ length: 5 }, (_, index) => ({ color: index === 2 ? '#49aaff' : '#ffffff', brightness: 20, on: index === 0 || index === 2 })) },
      },
      audio: { ready: true, sample_rate_hz: 16000 },
      speaker: { state: 'idle', volume: 10 },
      microphone: { state: 'idle', rms: 0, vad: false },
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
    setDemoLastSeen(new Date().toLocaleTimeString('zh-CN'))
    setDemoLastSeenAt(Date.now())
    setEvents([
      { type: 'event', protocol: PROTOCOL_VERSION, source: 'key', key: 'S3', action: 'down', uptime_ms: 8351500, receivedAt: '演示', rowId: 1 },
      { type: 'event', protocol: PROTOCOL_VERSION, source: 'encoder', action: 'rotate', delta: 1, uptime_ms: 8350900, receivedAt: '演示', rowId: 2 },
      { type: 'event', protocol: PROTOCOL_VERSION, source: 'microphone', action: 'vad_start', vad: true, uptime_ms: 8350200, receivedAt: '演示', rowId: 3 },
      { type: 'event', protocol: PROTOCOL_VERSION, source: 'encoder', action: 'down', uptime_ms: 8349500, receivedAt: '演示', rowId: 4 },
    ])
  }, [demoMode])

  useEffect(() => {
    if (!dataTransportOpen) return
    const timer = window.setInterval(() => setClock(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [dataTransportOpen])

  function finishWifiCommand(): void {
    if (wifiTimeoutRef.current !== null) window.clearTimeout(wifiTimeoutRef.current)
    wifiTimeoutRef.current = null
    pendingWifiActionRef.current = null
    pendingWifiTransportRef.current = null
    setWifiBusy(false)
  }

  function clearConnectionData(): void {
    connectionsRef.current.reset()
    refreshConnections((previous) => previous + 1)
    setDemoHello(null)
    setDemoStatus(null)
    setWifiResult(null)
    setWifiEditing(false)
    setWifiPassword('')
    finishWifiCommand()
    finishOutputCommand()
    setLightResult(null)
    setAudioResult(null)
    if (demoToneTimerRef.current !== null) window.clearTimeout(demoToneTimerRef.current)
    setPixelDirty(false)
    setIndicatorDirty(false)
    setDemoLastSeen('')
    setDemoLastSeenAt(null)
    setEvents([])
  }

  function resetTransport(transport: BoardTransport): void {
    connectionsRef.current.reset(transport)
    if (pendingWifiTransportRef.current === transport) pendingWifiTransportRef.current = connectionsRef.current.commandTransport(Date.now())
    refreshConnections((previous) => previous + 1)
    if (!portRef.current && !bleConnectionRef.current?.hasSession && !wifiConnectionRef.current?.hasSession) clearConnectionData()
  }

  function handleBoardMessage(transport: BoardTransport, message: BoardMessage): void {
    if (transport !== 'wifi' && message.type === 'status' && message.wifi.state === 'connected' && message.wifi.ip) {
      wifiConnectionRef.current?.rememberAddress(message.wifi.ip)
    }
    if (message.type === 'result' && commandResultMatches(message, pendingOutputRef.current)) {
      if (message.action.startsWith('audio.')) setAudioResult(message)
      else setLightResult(message)
      if (message.ok && !message.action.startsWith('audio.')) {
        if (message.action !== 'lights.status.set') setPixelDirty(false)
        if (message.action === 'lights.status.set') setIndicatorDirty(false)
      }
      finishOutputCommand()
    }
    if (message.type === 'result' && message.action === pendingWifiActionRef.current && transport === pendingWifiTransportRef.current) {
      setWifiResult(message)
      finishWifiCommand()
      if (message.action === 'wifi.configure') {
        setWifiPassword('')
        if (message.ok) setWifiEditing(false)
      }
      if (message.action === 'wifi.clear' && message.ok) {
        setWifiSsid('')
        setWifiPassword('')
        setWifiEditing(false)
      }
    }
    if (message.type === 'result' && (message.action === 'cloud.configure' || message.action === 'cloud.clear')) {
      setCloudResult(message)
      setCloudBusy(false)
      if (message.ok && message.action === 'cloud.configure') setRemoteToken('')
    }
    if (message.type === 'event') {
      const row: BoardEventRow = { ...message, receivedAt: new Date().toLocaleTimeString('zh-CN'), rowId: ++eventCounter.current }
      setEvents((previous) => [row, ...previous].slice(0, 80))
    }
  }

  function handleProtocolText(transport: BoardTransport, text: string): void {
    const now = Date.now()
    const messages = connectionsRef.current.receive(transport, text, now)
    for (const message of messages) handleBoardMessage(transport, message)
    if (messages.length === 0) return
    setClock(now)
    refreshConnections((previous) => previous + 1)
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
    } catch {
      // A USB unplug can close the Web Serial port before the UI sees it.
    }
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
        if (done) break
        if (portRef.current !== port) break
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
    setDemoMode(false)
    if (!('serial' in navigator)) {
      setSerialError('此浏览器不支持 Web Serial API，请使用最新版 Chrome 或 Edge。')
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
      } finally {
        writer.releaseLock()
      }
    } catch (error) {
      if (portRef.current) await closeSerial()
      const message = error instanceof Error ? error.message : '无法打开 USB 串口。'
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        setSerialError('未选择串口。请选择列表中的 EasyInput 开发板；如果列表为空，请检查 USB 数据线和开发板供电。')
      } else if (!message.toLowerCase().includes('cancel')) {
        setSerialError(message)
      }
    } finally {
      serialConnectRequestRef.current = false
      setSerialConnecting(false)
    }
  }

  function disconnectBle(): void {
    bleConnectionRef.current?.disconnect()
  }

  async function connectBle(selectDevice = false): Promise<void> {
    setDemoMode(false)
    if (selectDevice) await bleConnectionRef.current?.selectDevice()
    else await bleConnectionRef.current?.connect()
  }

  function connectWifiMonitor(): void {
    setDemoMode(false)
    wifiConnectionRef.current?.connect(wifiAddress)
  }

  function connectRemoteMonitor(): void {
    setDemoMode(false)
    wifiConnectionRef.current?.connectRemote(remoteGateway, remoteDevice, remoteToken)
  }

  function disconnectRemoteMonitor(): void {
    wifiConnectionRef.current?.disconnectRemote()
  }

  async function toggleDemoMode(): Promise<void> {
    if (demoMode) {
      setDemoMode(false)
      setDemoHello(null)
      setDemoStatus(null)
      setEvents([])
      setDemoLastSeen('')
      setDemoLastSeenAt(null)
      return
    }
    bleConnectionRef.current?.pause()
    wifiConnectionRef.current?.pause()
    if (portRef.current) await closeSerial()
    setDemoMode(true)
  }

  async function sendWifiCommand(action: 'wifi.configure' | 'wifi.clear' | 'wifi.connect_saved'): Promise<void> {
    const port = portRef.current
    const transport = connectionsRef.current.commandTransport(Date.now())
    const useBle = transport === 'ble'
    if (!transport || (!useBle && !port?.writable) || (useBle && !bleConnectionRef.current?.writable) || deviceBusy || pendingWifiActionRef.current || pendingOutputRef.current) return
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
    pendingWifiActionRef.current = action
    pendingWifiTransportRef.current = transport
    wifiTimeoutRef.current = window.setTimeout(() => {
      finishWifiCommand()
      setWifiResult({ type: 'result', protocol: PROTOCOL_VERSION, action, ok: false, message: '等待开发板响应超时，请检查连接和板端 Wi-Fi 状态后重试。' })
    }, 12000)
    try {
      const command: Record<string, unknown> = { type: 'command', protocol: PROTOCOL_VERSION, action }
      if (action === 'wifi.configure') {
        command.ssid = wifiSsid
        command.password = wifiPassword
      }
      const frame = new TextEncoder().encode(`${JSON.stringify(command)}\n`)
      try {
        if (useBle) {
          const connection = bleConnectionRef.current
          if (!connection) throw new Error('蓝牙命令通道已断开。')
          await connection.write(frame)
        } else {
          const writer = port?.writable?.getWriter()
          if (!writer) throw new Error('USB 串口已断开。')
          try {
            await writer.write(frame)
          } finally {
            writer.releaseLock()
          }
        }
      } finally {
        frame.fill(0)
        if (action === 'wifi.configure') command.password = ''
      }
      if (action === 'wifi.configure') setWifiPassword('')
    } catch {
      if (useBle) bleConnectionRef.current?.recover()
      else await closeSerial()
      finishWifiCommand()
      if (action === 'wifi.configure') setWifiPassword('')
      setWifiResult({ type: 'result', protocol: PROTOCOL_VERSION, action, ok: false, message: useBle ? '蓝牙命令发送失败，请确认连接仍有效。' : 'USB 命令发送失败，请确认串口仍连接。' })
    }
  }

  async function sendCloudCommand(action: 'cloud.configure' | 'cloud.clear'): Promise<void> {
    const port = portRef.current
    const transport = connectionsRef.current.commandTransport(Date.now())
    const useBle = transport === 'ble'
    if (!transport || (!useBle && !port?.writable) || (useBle && !bleConnectionRef.current?.writable) || deviceBusy || cloudBusy) return
    if (action === 'cloud.configure' && (!remoteGateway.trim() || !remoteDevice.trim() || remoteToken.trim().length < 16)) {
      setCloudResult({ type: 'result', protocol: PROTOCOL_VERSION, action, ok: false, message: '请填写 WSS 网关、设备 ID 和至少 16 位令牌。' })
      return
    }
    setCloudBusy(true)
    setCloudResult(null)
    const command: Record<string, unknown> = { type: 'command', protocol: PROTOCOL_VERSION, action }
    if (action === 'cloud.configure') Object.assign(command, { gateway: remoteGateway.trim(), device: remoteDevice.trim(), token: remoteToken })
    const frame = new TextEncoder().encode(`${JSON.stringify(command)}\n`)
    try {
      if (useBle) await bleConnectionRef.current!.write(frame)
      else {
        const writer = port!.writable!.getWriter()
        try { await writer.write(frame) } finally { writer.releaseLock() }
      }
      if (action === 'cloud.configure') setRemoteToken('')
    } catch {
      setCloudResult({ type: 'result', protocol: PROTOCOL_VERSION, action, ok: false, message: '云端配置发送失败，请保持 USB 或加密蓝牙连接。' })
    } finally {
      frame.fill(0)
      command.token = ''
      setCloudBusy(false)
    }
  }

  function finishOutputCommand(): void {
    if (outputTimeoutRef.current !== null) window.clearTimeout(outputTimeoutRef.current)
    outputTimeoutRef.current = null
    pendingOutputRef.current = null
    setOutputBusy(false)
  }

  async function sendOutputCommand(command: LightCommand | AudioCommand): Promise<void> {
    const isAudio = command.action.startsWith('audio.')
    if (!(isAudio ? audioEditable : lightsEditable) || pendingOutputRef.current || pendingWifiActionRef.current) return
    const showResult = isAudio ? setAudioResult : setLightResult
    showResult(null)
    if (demoMode) {
      setDemoStatus((previous) => {
        if (!previous?.lights.control) return previous
        const next = structuredClone(previous)
        const control = next.lights.control!
        if (command.action === 'lights.pixel.set') control.pixels[command.index] = { color: command.color, brightness: command.brightness, on: command.on }
        if (command.action === 'lights.all.set') control.pixels = control.pixels.map(() => ({ color: command.color, brightness: command.brightness, on: command.on }))
        if (command.action === 'lights.off') control.pixels.forEach((pixel) => { pixel.on = false })
        if (command.action === 'lights.status.set') control.status_led_brightness = command.brightness
        if (command.action === 'peripherals.power.set') {
          next.peripherals.shared_rail = command.on ? 'on' : 'off'
          if (!command.on) {
            control.pixels.forEach((pixel) => { pixel.on = false })
            next.microphone = { state: 'idle', rms: 0, vad: false }
            next.speaker.state = 'idle'
          }
        } else if (command.action !== 'lights.status.set' && control.pixels.some(pixelIsLit)) next.peripherals.shared_rail = 'on'
        if (command.action === 'audio.microphone.set') {
          next.microphone = { state: command.on ? 'active' : 'idle', rms: command.on ? 900 : 0, vad: command.on }
          if (command.on) next.peripherals.shared_rail = 'on'
        }
        if (command.action === 'audio.speaker.test') {
          next.speaker = { state: 'playing', volume: command.volume }
          next.peripherals.shared_rail = 'on'
        }
        if (command.action === 'audio.speaker.stop') next.speaker.state = 'idle'
        next.lights.pixels = control.pixels.map((pixel) => next.peripherals.shared_rail === 'on' && pixelIsLit(pixel) ? 'on' : 'off')
        next.lights.status_led = control.status_led_brightness > 0 ? 'on' : 'off'
        return next
      })
      if (command.action === 'audio.speaker.test' || command.action === 'audio.speaker.stop' || (command.action === 'peripherals.power.set' && !command.on)) {
        if (demoToneTimerRef.current !== null) window.clearTimeout(demoToneTimerRef.current)
        if (command.action === 'audio.speaker.test') demoToneTimerRef.current = window.setTimeout(() => {
          setDemoStatus((previous) => previous ? { ...previous, speaker: { ...previous.speaker, state: 'idle' } } : previous)
        }, 1000)
      }
      if (!isAudio) { setPixelDirty(false); setIndicatorDirty(false) }
      showResult({ type: 'result', protocol: PROTOCOL_VERSION, action: command.action, ok: true, message: '演示设置已更新。' })
      return
    }
    const transport = connectionsRef.current.commandTransport(Date.now())
    if (!transport) return
    const requestId = crypto.randomUUID()
    pendingOutputRef.current = { action: command.action, requestId }
    setOutputBusy(true)
    outputTimeoutRef.current = window.setTimeout(() => {
      finishOutputCommand()
      showResult({ type: 'result', protocol: PROTOCOL_VERSION, action: command.action, ok: false, message: '等待响应超时，设置可能已生效，请查看最新状态后重试。' })
    }, 12000)
    try {
      const frame = new TextEncoder().encode(`${JSON.stringify({ type: 'command', protocol: PROTOCOL_VERSION, ...command, request_id: requestId })}\n`)
      if (transport === 'ble') {
        const connection = bleConnectionRef.current
        if (!connection?.writable) throw new Error('蓝牙命令通道已断开。')
        await connection.write(frame)
      } else {
        const writer = portRef.current?.writable?.getWriter()
        if (!writer) throw new Error('USB 命令通道已断开。')
        try { await writer.write(frame) } finally { writer.releaseLock() }
      }
    } catch {
      // Do not replay an uncertain write through another transport.
      if (pendingOutputRef.current?.requestId !== requestId) return
      finishOutputCommand()
      showResult({ type: 'result', protocol: PROTOCOL_VERSION, action: command.action, ok: false, message: '发送失败，设置可能已生效，请检查连接和最新状态后重试。' })
      if (transport === 'ble') bleConnectionRef.current?.recover()
    }
  }

  function focusWifiConfiguration(): void {
    setActivePage('network')
    setWifiEditing(true)
    setWifiResult(null)
    setWifiPassword('')
    if (currentStatus.wifi.ssid) setWifiSsid(currentStatus.wifi.ssid)
    window.setTimeout(() => wifiSsidRef.current?.focus({ preventScroll: true }), 0)
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
    setFlashLog('请保持开发板开机，选择 ESP32 USB 端口后会自动进入下载模式。')
    setFlashCandidate(null)
    setConfirmedTarget(false)
    setFlashPreparing(true)
    let transport: Transport | null = null
    try {
      bleConnectionRef.current?.pause()
      wifiConnectionRef.current?.pause()
      await closeSerial()
      clearConnectionData()
      setDemoMode(false)
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
      setFlashLog('芯片与设备地址已读取，请检查目标信息并确认写入。')
    } catch (error) {
      if (transport) await transport.disconnect().catch(() => undefined)
      setFlashError(error instanceof Error ? error.message : '连接下载端口失败。')
      setFlashLog('自动连接未完成。请保持开发板开机，短按并松开 BOOT，然后重试并选择 ESP32 下载端口。')
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
    ? `${currentStatus.wifi.ssid}${currentStatus.wifi.state === 'connected' && typeof currentStatus.wifi.rssi === 'number' ? ` · ${currentStatus.wifi.rssi} dBm` : currentStatus.wifi.state === 'connecting' ? (currentStatus.wifi.retries ? ` · 重试 ${currentStatus.wifi.retries} 次` : ' · 正在连接') : ' · 已保存'}`
    : currentStatus.wifi.configured === false
      ? '尚未配置网络'
      : currentStatus.wifi.state === 'connected' && typeof currentStatus.wifi.rssi === 'number'
      ? `${currentStatus.wifi.rssi} dBm`
      : '由板端固件上报'
  const wifiRetrying = currentStatus.wifi.state === 'connecting' && (currentStatus.wifi.retries ?? 0) > 0
  const wifiStatusLabel = wifiRetrying ? `重试中 · ${currentStatus.wifi.retries} 次` : stateLabel(currentStatus.wifi.state)
  const wifiMonitorLabel = wifiMonitorConnecting ? '连接中' : wifiMonitorRetrying ? '等待自动重连'
    : wifiProtocolOnline ? '通信正常' : wifiMonitorConnected ? '等待数据' : '未连接'
  const wifiMonitorActive = wifiMonitorConnected || wifiMonitorConnecting || wifiMonitorRetrying
  const transportLabel = activeConnection?.transport === 'usb' ? 'USB' : activeConnection?.transport === 'wifi' ? 'Wi-Fi' : '蓝牙'

  const page = pages.find((item) => item.id === activePage)!
  const sectionTabs = {
    overview: { value: overviewTab, select: setOverviewTab, items: [['device', '设备状态'], ['events', '输入事件']] },
    control: { value: controlTab, select: setControlTab, items: [['pixels', '彩色灯带'], ['power', '指示灯与电源'], ['audio', '音频设备']] },
    network: { value: 'all', select: () => undefined, items: [] },
    system: { value: systemTab, select: setSystemTab, items: [['performance', '性能与内存'], ['storage', '存储状态'], ['partitions', '分区列表']] },
    firmware: { value: 'all', select: () => undefined, items: [] },
  }[activePage]
  const lightNote = demoMode ? '演示模式：操作仅更新预览。' : !lightControl ? hello ? '需要 0.1.5 或更新固件，请先升级开发板。' : '连接 USB 或蓝牙后可控制灯光。' : !lightControl.ready ? `灯光驱动不可用：${lightControl.error ?? '请重启开发板后重试'}。` : !wifiConfigOnline ? '控制灯光请连接 USB 或蓝牙。' : '点击应用后生效，状态以设备回报为准。'

  return (
    <main className="app-shell">
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-brand">
            <div className="brand-mark">E<span /></div>
            <h1>EasyInput <span>Studio</span></h1>
          </div>
          <div className="topbar-actions">
            <button className={`text-button demo-toggle ${demoMode ? 'demo-active' : ''}`} disabled={bleConnecting || serialConnecting || deviceBusy} onClick={() => void toggleDemoMode()}>
              {demoMode ? <Check size={15} /> : <Activity size={15} />}{demoMode ? '退出演示' : '演示'}
            </button>
            <button className={`button ${serialOpen ? 'button-subtle' : 'button-primary'}`} disabled={serialConnecting || deviceBusy} onClick={() => serialOpen ? void closeSerial() : void connectBoard()}>
              {serialConnecting ? <LoaderCircle size={16} className="spin" /> : <Usb size={16} />}{serialConnecting ? '连接中' : serialOpen ? '断开 USB' : '连接 USB'}
            </button>
            <button className="button button-subtle desktop-action" disabled={deviceBusy} onClick={() => {
              if (wifiMonitorActive) wifiConnectionRef.current?.disconnect()
              else if (wifiAddress.trim()) connectWifiMonitor()
              else setActivePage('network')
            }}>
              {wifiMonitorConnecting || wifiMonitorRetrying ? <LoaderCircle size={16} className="spin" /> : <Wifi size={16} />}
              {wifiMonitorConnecting || wifiMonitorRetrying ? '取消重连' : wifiMonitorConnected ? '断开 Wi-Fi' : '连接 Wi-Fi'}
            </button>
          </div>
        </header>

        <nav className="main-nav" aria-label="主要页面">{pages.map(({ id, label, icon: Icon }) => <button key={id} aria-current={activePage === id ? 'page' : undefined} className={activePage === id ? 'active' : ''} onClick={() => setActivePage(id)}><span className="nav-icon"><Icon size={18} strokeWidth={activePage === id ? 2 : 1.7} />{id === 'firmware' && (flashing || flashPreparing) && <i />}</span><span>{label}</span></button>)}</nav>

        <div className="connection-line">
          <span className="connection-summary"><span className={`pulse-dot ${protocolOnline || demoMode ? 'pulse-on' : ''}`} />{demoMode ? '演示模式' : protocolOnline ? `${transportLabel} · 实时连接` : dataTransportOpen ? '已连接 · 等待数据' : '等待连接设备'}</span>
          <span className="connection-transports"><span className={usbStateClass} title={usbLabel}>USB</span><span className={bleStateClass}>BLE</span><span className={wifiProtocolOnline ? 'is-live' : 'is-muted'}>Wi-Fi</span><span className="app-version">v{appVersion}</span></span>
        </div>

        <div className="notice-stack" aria-live="polite">
          {serialError && <div className="notice notice-error"><X size={16} /><span>{serialError}</span><button onClick={() => setSerialError('')} aria-label="关闭提示"><X size={16} /></button></div>}
          {updateWaiting && updateBlocked && <div className="notice notice-update"><RotateCw size={15} /><span>新版本已就绪，设备操作结束后会自动更新。</span></div>}
        </div>

        <section className="page-content" aria-labelledby="page-title">
          <div className="section-heading"><div><p>{page.caption}</p><h2 id="page-title">{page.title}</h2></div><span className="page-number">0{pages.indexOf(page) + 1}<span> / 05</span></span></div>
          {sectionTabs.items.length > 0 && <nav className="subnav" aria-label={`${page.label}分页`}>
            {sectionTabs.items.map(([id, label]) => <button key={id} aria-pressed={sectionTabs.value === id} className={sectionTabs.value === id ? 'selected' : ''} onClick={() => sectionTabs.select(id)}>{label}{id === 'events' && events.length > 0 && <span className="tab-count">{events.length}</span>}</button>)}
          </nav>}

          <div className="page-body" key={`${activePage}-${sectionTabs.value}`}>
            {activePage === 'overview' && overviewTab === 'device' && <div className="overview-layout">
              <article className="device-hero">
                <div className="hero-top"><span className="hero-badge"><Cpu size={13} /> YOUR DEVICE</span><span className="version-pill">V2.0</span></div>
                <div className="hero-title"><div><h3>EasyInput</h3><p>{hello?.chip ?? 'ESP32-S3R8'}<span>·</span>AI Keyboard V2.1</p></div><div className="device-avatar"><Cpu size={34} strokeWidth={1.35} /></div></div>
                <div className="hero-footer"><span>固件 <strong>{hello?.firmware ?? '未读取'}</strong></span><span>运行 <strong>{status ? formatDuration(status.uptime_ms) : '—'}</strong></span></div>
              </article>
              <div className="status-grid">
                <article className="status-card panel"><div className="card-topline"><span className="card-icon wifi-icon"><Wifi size={17} /></span><button className="card-connect-button" onClick={() => setActivePage('network')}>详情 <ArrowRight size={12} /></button></div><span className="card-label">Wi-Fi</span><strong className={`status-value ${stateClass(currentStatus.wifi.state)}`}>{wifiStatusLabel}</strong><p className="card-foot">{wifiExtra}</p></article>
                <article className="status-card panel"><div className="card-topline"><span className="card-icon bluetooth-icon"><Bluetooth size={17} /></span><button className="card-connect-button" disabled={deviceBusy} onClick={() => { if (bleConnected || bleConnecting || bleRetrying) disconnectBle(); else void connectBle() }}>{bleConnecting || bleRetrying ? '取消' : bleConnected ? '断开' : '连接'}</button></div><span className="card-label">Bluetooth LE</span><strong className={`status-value ${bleStateClass}`}>{bleLabel}</strong><p className="card-foot">{currentStatus.ble.name ?? 'EasyInput'}{bleError ? ' · 请查看网络页' : ''}</p></article>
              </div>
              <article className="power-summary panel"><div className="summary-heading"><Zap size={15} /><strong>供电状态</strong><span>{currentStatus.power.charging === undefined ? '等待数据' : currentStatus.power.charging ? '正在充电' : '未充电'}</span></div><div className="power-details"><div><span>电池电压</span><strong>{currentStatus.power.battery_mv !== undefined ? `${(currentStatus.power.battery_mv / 1000).toFixed(3)} V` : '不可用'}</strong></div><div><span>外部供电</span><strong>{currentStatus.power.external_power === undefined ? '等待数据' : currentStatus.power.external_power ? '已连接' : '未连接'}</strong></div><div><span>外设电源</span><strong>{stateLabel(currentStatus.peripherals.shared_rail)}</strong></div></div></article>
              <div className="overview-foot"><span className="pulse-dot" />{demoMode ? '当前显示演示数据' : lastSeen ? `最近数据 ${lastSeen}` : '点击右上角 USB 或蓝牙连接设备'}<button onClick={() => { setOverviewTab('events'); setEventPage(0) }}>查看输入 <ArrowRight size={13} /></button></div>
            </div>}

            {activePage === 'overview' && overviewTab === 'events' && <article className="panel list-panel events-card">
              <div className="panel-heading"><div><span className="section-kicker">INPUT STREAM</span><h3>实时输入事件 <span className="count-pill">{events.length}</span></h3></div><button className="text-button" onClick={() => { setEvents([]); setEventPage(0) }}>清空</button></div>
              <div className="event-filter-row"><span><i className="filter-dot key-dot" />按键</span><span><i className="filter-dot encoder-dot" />旋钮</span><span><i className="filter-dot mic-dot" />麦克风</span><span className="event-live"><span className={`pulse-dot ${protocolOnline || demoMode ? 'pulse-on' : ''}`} />{protocolOnline || demoMode ? 'LIVE' : '等待输入'}</span></div>
              <div className="paginated-list event-list" ref={eventListRef}>
                {visibleEvents.length === 0 ? <div className="empty-state"><Activity size={30} strokeWidth={1.3} /><strong>等待你的第一次输入</strong><p>按下按键或转动旋钮<br />设备事件将在这里实时显示</p><span className="key-hint"><kbd>S1</kbd><kbd>S2</kbd><kbd>S3</kbd><span>…</span><kbd>S8</kbd></span></div> : visibleEvents.map((event) => <div className="event-row" key={event.rowId}><div className={`event-source-icon ${event.source}`}>{event.source === 'key' ? <span>{event.key?.replace('S', '') ?? 'K'}</span> : event.source === 'encoder' ? <RotateCw size={16} /> : <Mic size={16} />}</div><div className="event-copy"><strong>{describeInputEvent(event)}</strong><span>{event.source === 'key' ? '物理按键' : event.source === 'encoder' ? '旋转编码器' : 'I²S 麦克风'}</span></div><time>{event.receivedAt}</time></div>)}
              </div>
              <Pagination page={currentEventPage} count={eventPageCount} onChange={setEventPage} />
            </article>}

            {activePage === 'control' && controlTab === 'pixels' && <article className="panel control-card">
              <div className="panel-heading"><div><span className="section-kicker">MAKE IT GLOW</span><h3>给灯光一点颜色</h3></div><span className="card-icon light-icon"><Lightbulb size={19} /></span></div>
              <div className="led-row"><div><strong>WS2812 灯带</strong><small>选择一颗灯珠进行调整</small></div><div className="pixel-list" role="group" aria-label="选择灯珠">{Array.from({ length: 5 }, (_, index) => {
                const pixelState = currentStatus.lights.pixels[index] ?? 'unknown'
                const setting = lightControl?.pixels[index]
                return <button key={index} className={`pixel-select ${selectedPixel === index ? 'selected' : ''}`} aria-label={`第 ${index + 1} 颗灯，${stateLabel(pixelState)}`} aria-pressed={selectedPixel === index} disabled={outputBusy || deviceBusy} onClick={() => { setSelectedPixel(index); setPixelDirty(false) }}><span className={`pixel ${pixelState === 'unknown' ? 'pixel-unknown' : ''}`} style={pixelState === 'on' && setting ? { background: setting.color, borderColor: setting.color, boxShadow: `0 0 10px ${setting.color}`, opacity: Math.max(0.25, setting.brightness / 100) } : undefined} /><small>{index + 1}</small></button>
              })}</div></div>
              <fieldset className="light-editor" disabled={!lightsEditable}><legend>第 {selectedPixel + 1} 颗灯</legend><div className="light-setting-row"><label className="light-color">颜色<input type="color" aria-label="灯珠颜色" value={pixelDraft.color.toLowerCase()} onChange={(event) => { setPixelDraft({ ...pixelDraft, color: event.target.value }); setPixelDirty(true) }} /></label><span className="light-color-code">{pixelDraft.color.toUpperCase()}</span><label className="light-switch"><input type="checkbox" checked={pixelDraft.on} onChange={(event) => { setPixelDraft({ ...pixelDraft, on: event.target.checked }); setPixelDirty(true) }} />开启</label></div><label className="light-brightness">亮度<input aria-label="灯珠亮度" type="range" min="0" max="100" value={pixelDraft.brightness} onChange={(event) => { setPixelDraft({ ...pixelDraft, brightness: Number(event.target.value) }); setPixelDirty(true) }} /><output>{pixelDraft.brightness}%</output></label><div className="light-actions"><button className="button button-primary" onClick={() => void sendOutputCommand({ action: 'lights.pixel.set', index: selectedPixel, ...pixelDraft })}>应用此灯</button><button className="button button-subtle" onClick={() => void sendOutputCommand({ action: 'lights.all.set', ...pixelDraft })}>应用到全部</button><button className="text-button" onClick={() => void sendOutputCommand({ action: 'lights.off' })}>全灭</button></div></fieldset>
              <p className="light-note">{lightNote}</p>{outputBusy && !pendingOutputRef.current?.action.startsWith('audio.') && <p className="result-note" role="status">正在应用设置…</p>}{lightResult && <p className={`result-note ${lightResult.ok ? '' : 'error'}`} role="status">{lightResult.message}</p>}
              <div className="panel-bottom-note"><Zap size={13} />点亮时自动供电，全部熄灭后保留供电。</div>
            </article>}

            {activePage === 'control' && controlTab === 'power' && <article className="panel control-card">
              <div className="panel-heading"><div><span className="section-kicker">LIGHT & POWER</span><h3>指示灯与共享电源</h3></div><span className="card-icon wifi-icon"><Zap size={18} /></span></div>
              <div className="led-row"><div><strong>状态指示灯</strong><small>调整开关与亮度</small></div><button className="button button-subtle" disabled={!lightsEditable} onClick={() => void sendOutputCommand({ action: 'lights.status.set', brightness: currentStatus.lights.status_led === 'on' ? 0 : indicatorDraft || 20 })}><span className={`tiny-dot ${currentStatus.lights.status_led === 'on' ? 'tiny-dot-on' : ''}`} />{stateLabel(currentStatus.lights.status_led)}</button></div>
              <fieldset className="indicator-editor" disabled={!lightsEditable}><label className="light-brightness">亮度<input aria-label="状态指示灯亮度" type="range" min="0" max="100" value={indicatorDraft} onChange={(event) => { setIndicatorDraft(Number(event.target.value)); setIndicatorDirty(true) }} /><output>{indicatorDraft}%</output></label><button className="button button-subtle" onClick={() => void sendOutputCommand({ action: 'lights.status.set', brightness: indicatorDraft })}>应用亮度</button></fieldset>
              <div className="power-control"><div><strong>共享外设电源</strong><small>{stateLabel(currentStatus.peripherals.shared_rail)}</small></div><button className="button button-primary" disabled={!lightsEditable} onClick={() => void sendOutputCommand({ action: 'peripherals.power.set', on: currentStatus.peripherals.shared_rail !== 'on' })}>{currentStatus.peripherals.shared_rail === 'on' ? '关闭电源' : '开启电源'}</button></div>
              <p className="light-note">{lightNote}</p>{outputBusy && !pendingOutputRef.current?.action.startsWith('audio.') && <p className="result-note" role="status">正在应用设置…</p>}{lightResult && <p className={`result-note ${lightResult.ok ? '' : 'error'}`} role="status">{lightResult.message}</p>}
              <div className="panel-bottom-note"><Zap size={14} />共享电源同时供给灯带、麦克风与扬声器；关闭会停止音频。</div>
            </article>}

            {activePage === 'control' && controlTab === 'audio' && <article className="panel audio-card">
              <div className="panel-heading"><div><span className="section-kicker">SOUND CHECK</span><h3>听见设备的声音</h3></div><span className="status-chip">{stateLabel(currentStatus.microphone.state)}</span></div>
              <div className="audio-devices"><div className="audio-device"><div className="audio-device-name"><span className="card-icon mic-icon"><Mic size={19} /></span><div><strong>麦克风</strong><small>音频输入</small></div><span className="device-state">{stateLabel(currentStatus.microphone.state)}</span></div><div className="meter-wrap"><div className="metric-bar"><i style={{ width: `${micLevel}%` }} /></div><span>{micLevel}%</span></div><button className="button button-subtle" disabled={!audioEditable} onClick={() => void sendOutputCommand({ action: 'audio.microphone.set', on: currentStatus.microphone.state !== 'active' })}>{currentStatus.microphone.state === 'active' ? '停止采集' : '开始采集'}</button></div>
              <div className="audio-device"><div className="audio-device-name"><span className="card-icon bluetooth-icon"><Headphones size={19} /></span><div><strong>扬声器</strong><small>测试音量 10%</small></div><span className={`device-state ${stateClass(currentStatus.speaker.state)}`}>{stateLabel(currentStatus.speaker.state)}</span></div><button className="button button-subtle" disabled={!audioEditable} onClick={() => void sendOutputCommand(currentStatus.speaker.state === 'playing' ? { action: 'audio.speaker.stop' } : { action: 'audio.speaker.test', volume: 10 })}>{currentStatus.speaker.state === 'playing' ? '停止播放' : '播放测试音'}</button></div></div>
              <p className="audio-foot"><span className={`tiny-dot ${micVad ? 'tiny-dot-on' : ''}`} />语音活动：{micVad ? '检测中' : '未检测'}<span>{typeof currentStatus.speaker.volume === 'number' ? `音量 ${currentStatus.speaker.volume}%` : ''}</span></p>
              <p className="light-note">{demoMode ? '演示模式：测试音约 1 秒后结束。' : !currentStatus.audio ? hello ? '需要 0.1.6 或更新固件，请先升级。' : '连接开发板后可查看音频状态。' : !currentStatus.audio.ready ? '音频驱动未就绪，请检查电源后重试。' : !wifiConfigOnline ? '控制音频请连接 USB 或蓝牙。' : '采集与播放时自动供电；测试音约 1 秒。'}</p>
              {(currentStatus.microphone.error || currentStatus.speaker.error) && <p className="result-note error">{currentStatus.microphone.error ? `麦克风：${currentStatus.microphone.error}。` : ''}{currentStatus.speaker.error ? `扬声器：${currentStatus.speaker.error}。` : ''}</p>}{outputBusy && pendingOutputRef.current?.action.startsWith('audio.') && <p className="result-note" role="status">正在应用音频设置…</p>}{audioResult && <p className={`result-note ${audioResult.ok ? '' : 'error'}`} role="status">{audioResult.message}</p>}
            </article>}

            {activePage === 'network' && <article className="panel network-card">
              <div className="panel-heading"><div><span className="section-kicker">NETWORK CONTROL</span><h3>网络与连接</h3></div><span className={`status-chip ${stateClass(currentStatus.wifi.state)}`}>{wifiStatusLabel}</span></div>
              <div className="network-action-grid">
                <section className="network-action-block"><div className="network-action-heading"><Wifi size={16} /><strong>{wifiEditing ? '更换 Wi-Fi 网络' : 'Wi-Fi 设置'}</strong></div>
                  {currentStatus.wifi.configured && !wifiEditing && <div className="saved-network"><span className="card-icon wifi-icon"><Check size={20} /></span><strong>{currentStatus.wifi.ssid ?? '已保存网络'}</strong><p>开机与断线后会自动连接<br />无需重复输入密码</p><div className="wifi-actions">{currentStatus.wifi.state !== 'connected' && <button className="button button-primary" type="button" disabled={!wifiConfigOnline || deviceBusy || wifiBusy || currentStatus.wifi.state === 'connecting'} onClick={() => void sendWifiCommand('wifi.connect_saved')}>{wifiBusy || currentStatus.wifi.state === 'connecting' ? <LoaderCircle size={14} className="spin" /> : <RotateCw size={14} />}{currentStatus.wifi.state === 'connecting' ? '自动连接中' : '使用已保存网络'}</button>}<button className="button button-subtle" disabled={!wifiConfigOnline || deviceBusy || wifiBusy} onClick={focusWifiConfiguration}>更换网络</button><button className="text-button" disabled={!wifiConfigOnline || deviceBusy || wifiBusy} onClick={() => void sendWifiCommand('wifi.clear')}>清除配置</button></div></div>}
                  {(wifiEditing || currentStatus.wifi.configured !== true) && <form className="wifi-form" onSubmit={(event) => { event.preventDefault(); void sendWifiCommand('wifi.configure') }}><label>网络名称 (SSID)<input ref={wifiSsidRef} disabled={!wifiConfigOnline || deviceBusy || wifiBusy} autoComplete="off" maxLength={32} value={wifiSsid} onChange={(event) => setWifiSsid(event.target.value)} placeholder="输入 2.4 GHz Wi-Fi 名称" /></label><label>密码<input disabled={!wifiConfigOnline || deviceBusy || wifiBusy} autoComplete="new-password" maxLength={63} type="password" value={wifiPassword} onChange={(event) => setWifiPassword(event.target.value)} placeholder="开放网络可留空" /></label><div className="wifi-actions"><button className="button button-primary" type="submit" disabled={!wifiConfigOnline || deviceBusy || wifiBusy || !wifiSsid.trim()}>{wifiBusy ? <LoaderCircle size={14} className="spin" /> : <Wifi size={14} />}保存并自动连接</button>{currentStatus.wifi.configured && <button className="text-button" type="button" disabled={wifiBusy} onClick={() => { setWifiEditing(false); setWifiPassword('') }}>取消</button>}</div></form>}
                  {wifiResult && <p className={`result-note ${wifiResult.ok ? '' : 'error'}`} role="status">{wifiResult.message ?? (wifiResult.ok ? '操作完成。' : '操作失败。')}</p>}
                </section>
                <section className="network-action-block"><div className="network-action-heading"><Monitor size={16} /><strong>无线监控</strong><span className={`status-chip ${wifiProtocolOnline ? 'is-live' : wifiMonitorActive ? 'is-warn' : 'is-muted'}`} role="status">{wifiMonitorLabel}</span></div>
                  <form className="wifi-form" onSubmit={(event) => { event.preventDefault(); connectWifiMonitor() }}><label>开发板 IP 地址<input aria-label="开发板 IP 地址" disabled={deviceBusy || wifiMonitorActive} autoComplete="off" inputMode="decimal" maxLength={15} value={wifiAddress} onChange={(event) => setWifiAddress(event.target.value)} placeholder="例如 192.168.1.82" /></label><div className="wifi-actions">{wifiMonitorActive ? <button className="button button-subtle" type="button" disabled={deviceBusy} onClick={() => wifiConnectionRef.current?.disconnect()}>{wifiMonitorConnected ? '断开 Wi-Fi 监控' : '取消重连'}</button> : <button className="button button-primary" type="submit" disabled={deviceBusy || !wifiAddress.trim()}><Wifi size={15} />连接 Wi-Fi 监控</button>}</div></form>
                  <p className="light-note">手机或电脑与开发板需在同一局域网。通过 USB 或蓝牙读取 IP 后自动填入。</p>{wifiMonitorError && <p className="result-note warn" role="status">{wifiMonitorError}</p>}
                  <div className="remote-agent-section"><div className="summary-heading"><Monitor size={16} /><strong>公网直连监控</strong><span className={wifiProtocolOnline ? 'is-live' : 'is-muted'}>{wifiProtocolOnline && remoteGateway ? '已连接' : '未连接'}</span></div><form className="wifi-form" onSubmit={(event) => { event.preventDefault(); connectRemoteMonitor() }}><label>Cloudflare WSS 网关<input value={remoteGateway} onChange={(event) => setRemoteGateway(event.target.value)} placeholder="wss://xxx.workers.dev" /></label><label>设备 ID<input value={remoteDevice} onChange={(event) => setRemoteDevice(event.target.value)} placeholder="easyinput-v2" /></label><label>配对令牌<input type="password" value={remoteToken} onChange={(event) => setRemoteToken(event.target.value)} placeholder="至少 16 位" /></label><div className="wifi-actions"><button className="button button-subtle" type="button" disabled={cloudBusy || !wifiConfigOnline} onClick={() => void sendCloudCommand('cloud.configure')}>保存到开发板</button>{wifiMonitorActive && remoteGateway ? <button className="button button-subtle" type="button" onClick={disconnectRemoteMonitor}>断开公网监控</button> : <button className="button button-primary" type="submit" disabled={deviceBusy || !remoteGateway.trim() || !remoteToken.trim()}>连接公网监控</button>}</div></form><p className="light-note">先通过 USB 或加密蓝牙保存配置，开发板随后会自行连接 Cloudflare；不再需要电脑 Agent。</p>{cloudResult && <p className={`result-note ${cloudResult.ok ? '' : 'error'}`}>{cloudResult.message}</p>}</div>
                  <div className="bluetooth-section"><div className="summary-heading"><Bluetooth size={16} /><strong>蓝牙连接</strong><span className={bleStateClass}>{bleLabel}</span></div><div className="wifi-actions"><button className="button button-subtle" disabled={deviceBusy} onClick={() => { if (bleConnected || bleConnecting || bleRetrying) disconnectBle(); else void connectBle() }}>{bleConnected ? '断开蓝牙' : bleConnecting || bleRetrying ? '取消重连' : '连接蓝牙'}</button>{!bleConnected && !bleConnecting && <button className="text-button" disabled={deviceBusy} onClick={() => void connectBle(true)}>重新选择设备</button>}</div>{bleError && <p className="result-note warn">{bleError}</p>}</div>
                </section>
              </div>
              <div className="network-status-section"><div className="network-status-heading"><span>当前 Wi-Fi 状态</span>{wifiRetrying && <span className="is-warn">开发板正在自动重试连接</span>}</div><div className="network-details"><div><span>网络名称</span><strong>{currentStatus.wifi.ssid ?? (currentStatus.wifi.configured ? '正在获取…' : '尚未配置')}</strong></div><div><span>IP 地址</span><strong>{currentStatus.wifi.ip ?? '—'}</strong></div><div><span>子网掩码</span><strong>{currentStatus.wifi.netmask ?? '—'}</strong></div><div><span>网关</span><strong>{currentStatus.wifi.gateway ?? '—'}</strong></div><div><span>DNS</span><strong>{currentStatus.wifi.dns ?? '—'}</strong></div><div><span>信号 / 信道</span><strong>{currentStatus.wifi.state === 'connected' && currentStatus.wifi.rssi !== undefined ? `${currentStatus.wifi.rssi} dBm` : '—'}{currentStatus.wifi.state === 'connected' && currentStatus.wifi.channel ? ` / ${currentStatus.wifi.channel}` : ''}</strong></div><div><span>重连 / 断线次数</span><strong>{currentStatus.wifi.retries ?? '—'} / {currentStatus.wifi.disconnects ?? '—'}</strong></div><div><span>最近断线原因</span><strong>{wifiDisconnectReason(currentStatus.wifi.disconnect_code)}</strong></div></div></div>
              <div className="panel-bottom-note"><Usb size={14} />网络设置通过 USB 或蓝牙修改，Wi-Fi 连接仅用于监控。</div>
            </article>}

            {activePage === 'system' && systemTab === 'performance' && <article className="panel system-card">
              <div className="panel-heading"><div><span className="section-kicker">SYSTEM TELEMETRY</span><h3>性能与内存</h3></div><span className="status-chip">{currentStatus.cpu.frequency_mhz || '—'} MHz</span></div>
              <div className="metric-section"><div className="metric-section-heading"><Cpu size={15} /><strong>CPU</strong><span>{currentStatus.cpu.temperature_c !== undefined ? `${currentStatus.cpu.temperature_c.toFixed(1)} °C` : '温度不可用'}</span></div><div className="cpu-core-list">{currentStatus.cpu.usage_percent.map((usage, index) => <div className="cpu-core" key={index}><span>核心 {index}</span><div className="metric-bar"><i style={{ width: `${Math.min(100, Math.max(0, usage))}%` }} /></div><strong>{usage.toFixed(0)}%</strong></div>)}{currentStatus.cpu.usage_percent.length === 0 && <span className="metric-empty">等待 CPU 采样</span>}</div></div>
              <div className="metric-section"><div className="metric-section-heading"><Zap size={15} /><strong>内存</strong><span>空闲 / 总量</span></div><div className="resource-list"><div><span>内部 RAM</span><strong>{formatBytes(currentStatus.memory.internal.free_bytes)} <small>/ {formatBytes(currentStatus.memory.internal.total_bytes)}</small></strong><p>最低空闲 {formatBytes(currentStatus.memory.internal.minimum_free_bytes)}<br />最大连续块 {formatBytes(currentStatus.memory.internal.largest_block_bytes)}</p></div><div><span>外置 PSRAM</span><strong>{formatBytes(currentStatus.memory.psram.free_bytes)} <small>/ {formatBytes(currentStatus.memory.psram.total_bytes)}</small></strong><p>最大连续块<br />{formatBytes(currentStatus.memory.psram.largest_block_bytes)}</p></div></div></div>
              <div className="panel-bottom-note"><Activity size={14} />CPU 使用率根据各核心空闲时间估算。</div>
            </article>}

            {activePage === 'system' && systemTab === 'storage' && <article className="panel system-card">
              <div className="panel-heading"><div><span className="section-kicker">STORAGE HEALTH</span><h3>存储状态</h3></div><HardDrive size={20} className="heading-icon" /></div>
              <div className="storage-list"><div><span>Flash 总容量<small>{currentStatus.storage.flash.state === 'ready' ? '运行正常' : '等待数据'}</small></span><strong>{formatBytes(currentStatus.storage.flash.total_bytes)}<small>末尾空闲 {formatBytes(currentStatus.storage.flash.unallocated_bytes)}</small></strong></div><div><span>运行分区<small>{currentStatus.storage.app.state === 'running' ? '运行中' : '等待数据'}</small></span><strong>{formatBytes(currentStatus.storage.app.free_bytes)}<small>可用 / 共 {formatBytes(currentStatus.storage.app.partition_bytes)}</small></strong></div><div><span>NVS 配置存储<small>{formatBytes(currentStatus.storage.nvs.total_bytes)} · {currentStatus.storage.nvs.state === 'ready' ? '正常' : '不可用'}</small></span><strong>{currentStatus.storage.nvs.free_entries} / {currentStatus.storage.nvs.total_entries}<small>剩余条目 / 总条目</small></strong></div></div>
              <div className="flash-rates"><div><span>读取</span><strong>{formatRate(currentStatus.storage.flash.read_bytes_per_second)}</strong></div><div><span>写入</span><strong>{formatRate(currentStatus.storage.flash.write_bytes_per_second)}</strong></div><div><span>擦除</span><strong>{formatRate(currentStatus.storage.flash.erase_bytes_per_second)}</strong></div></div><div className="panel-bottom-note"><HardDrive size={14} />速率统计设备 Flash API 的调用。</div>
            </article>}

            {activePage === 'system' && systemTab === 'partitions' && <article className="panel list-panel">
              <div className="panel-heading"><div><span className="section-kicker">PARTITION MAP</span><h3>Flash 分区 <span className="count-pill">{currentStatus.storage.partitions.length}</span></h3></div><HardDrive size={20} className="heading-icon" /></div>
              <div className="partition-table-heading"><span>分区名称</span><span>地址</span><span>大小</span></div><div className="paginated-list partition-list" ref={partitionListRef}>{visiblePartitions.length === 0 ? <div className="empty-state"><HardDrive size={30} strokeWidth={1.3} /><strong>等待分区信息</strong><p>连接设备后自动读取</p></div> : visiblePartitions.map((partition) => <div className="partition-row" key={`${partition.label}-${partition.address}`}><span>{partition.label}</span><code>0x{partition.address.toString(16).toUpperCase()}</code><strong>{formatBytes(partition.size_bytes)}</strong></div>)}</div><Pagination page={currentPartitionPage} count={partitionPageCount} onChange={setPartitionPage} />
            </article>}

            {activePage === 'firmware' && <article className="panel firmware-card">
              <div className="panel-heading"><div><span className="section-kicker">FIRMWARE UPDATE</span><h3>固件包与设备烧录</h3></div><span className="status-chip">{manifest ? `v${manifest.version}` : '未导入固件'}</span></div>
              <div className="firmware-current"><Cpu size={24} /><div><span>板载固件</span><strong>{hello?.firmware ?? '未读取'}</strong></div><span className={`status-chip ${hello ? 'is-live' : 'is-muted'}`}>{hello ? '运行中' : '待连接'}</span></div>
              <div className="firmware-action-grid">
                <section className="firmware-action-block"><div className="network-action-heading"><FileUp size={16} /><strong>选择固件包</strong></div>
                  <input ref={flashFolderRef} type="file" multiple hidden disabled={deviceBusy} {...{ webkitdirectory: '', directory: '' }} onChange={(event) => void importFirmware(event)} />
                  <button className={`package-drop ${manifest ? 'package-loaded' : ''}`} disabled={deviceBusy} onClick={() => flashFolderRef.current?.click()}><span className="upload-icon">{manifest ? <Check size={24} /> : <FileUp size={24} />}</span><strong>{manifest ? `版本 ${manifest.version}` : '选择本地固件包'}</strong><small>{manifest ? `${images.length} 个镜像 · SHA-256 已校验` : '选择包含 firmware.json 与镜像的目录'}</small><span className="package-link">{manifest ? '重新选择' : '导入目录'} <ChevronDown size={14} /></span></button>
                  {packageError && <p className="result-note error" role="alert">{packageError}</p>}
                </section>
                <section className="firmware-action-block"><div className="network-action-heading"><Download size={16} /><strong>设备烧录</strong><span className={`status-chip ${flashing ? 'is-warn' : flashProgress === 100 ? 'is-live' : 'is-muted'}`}>{flashing ? '正在烧录' : flashProgress === 100 ? '已完成' : manifest ? '待连接设备' : '等待固件包'}</span></div>
                  {!manifest && <div className="flash-empty"><FileUp size={30} strokeWidth={1.3} /><strong>先准备好固件包</strong><p>导入并校验成功后即可连接设备</p></div>}
                  {flashProgress > 0 && <div className="flash-progress-wrap"><div className="flash-progress-label"><span>{flashing ? '正在烧录' : '烧录进度'}</span><strong>{flashProgress}%</strong></div><div className="metric-bar"><i style={{ width: `${flashProgress}%` }} /></div></div>}
                  {flashCandidate ? <div className="flash-confirm"><div className="target-heading"><span className="card-icon wifi-icon"><Check size={18} /></span><div><span>已验证烧录目标</span><strong>{flashCandidate.chip}</strong></div></div><div className="target-details"><span>设备 MAC</span><code>{flashCandidate.mac}</code></div><div className="target-details"><span>目标固件</span><code>{manifest?.version}</code></div><label className="confirm-check"><input type="checkbox" checked={confirmedTarget} disabled={flashing} onChange={(event) => setConfirmedTarget(event.target.checked)} /><span>确认将以上固件写入这台设备</span></label><div className="flash-confirm-actions"><button className="text-button" disabled={flashing} onClick={cancelFlashCandidate}>取消</button><button className="button button-primary" disabled={!confirmedTarget || flashing} onClick={() => void flashFirmware()}>{flashing ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}确认烧录</button></div></div> : manifest && <div className="flash-ready"><span className="card-icon wifi-icon"><Usb size={24} /></span><strong>连接你的 EasyInput</strong><p>保持开发板开机，短按并松开 BOOT<br />选择 ESP32 下载端口</p><button className="button button-primary full-button" disabled={flashPreparing || flashing || serialConnecting || bleConnecting || wifiBusy} onClick={() => void prepareFlash()}>{flashPreparing ? <LoaderCircle size={15} className="spin" /> : <Usb size={15} />}{flashPreparing ? '正在识别芯片…' : '连接并识别设备'}</button></div>}
                  {flashLog && <p className={`flash-log ${flashError ? 'error' : ''}`} role="status">{flashLog}</p>}{flashError && <p className="result-note error" role="alert">{flashError}</p>}
                </section>
              </div>
              <section className="firmware-images"><div className="network-action-heading"><Check size={16} /><strong>已校验镜像清单</strong><span className="status-chip">{images.length} 个镜像</span></div>{manifest ? <><p className="light-note">版本 {manifest.version} · 所有镜像已通过 SHA-256 校验</p><div className="image-list">{images.map((image) => <div className="image-detail" key={image.file}><span className="card-icon wifi-icon"><Check size={18} /></span><div><strong>{image.file}</strong><small>写入地址 {formatAddress(image.address)}</small></div><span>{formatBytes(image.bytes)}</span></div>)}</div></> : <p className="light-note">导入固件包后显示镜像文件、写入地址和大小。</p>}</section>
              <div className="panel-bottom-note"><Usb size={14} />仅写入固件包内镜像，保留其他分区。烧录后关机再开机。</div>
            </article>}
          </div>
        </section>

      </div>
    </main>
  )
}
