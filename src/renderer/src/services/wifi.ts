import { parseBoardMessage, PROTOCOL_VERSION } from '@shared/protocol'

const SAVED_CONNECTION_KEY = 'easyinput.wifi.v1'
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000]
const DATA_TIMEOUT_MS = 8000

type SavedConnection = { address: string; autoConnect: boolean }
type Callbacks = {
  connected(value: boolean): void
  connecting(value: boolean): void
  retrying(value: boolean): void
  notice(message: string): void
  address(value: string): void
  reset(): void
  text(value: string): void
}

export function normalizeWifiAddress(value: string): string {
  const address = value.trim()
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
    throw new Error('请输入开发板的 IPv4 地址，例如 192.168.1.82。')
  }
  const [a, b] = parts.map(Number)
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254))) {
    throw new Error('请输入开发板在当前局域网中的 IP 地址。')
  }
  return address
}

function readSavedConnection(): SavedConnection | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_CONNECTION_KEY) ?? 'null') as Partial<SavedConnection> | null
    return saved && typeof saved.address === 'string' && typeof saved.autoConnect === 'boolean'
      ? { address: normalizeWifiAddress(saved.address), autoConnect: saved.autoConnect } : null
  } catch {
    return null
  }
}

/** A local-network monitoring connection; Wi-Fi credentials stay on USB/encrypted BLE. */
export class WifiConnection {
  private saved = readSavedConnection()
  private socket: WebSocket | null = null
  private retryTimer: number | null = null
  private dataTimer: number | null = null
  private retries = 0
  private enabled = false
  private disposed = false

  constructor(private readonly callbacks: Callbacks) {}

  get hasSession(): boolean { return this.socket !== null }

  start(): void {
    document.addEventListener('visibilitychange', this.onVisible)
    window.addEventListener('online', this.wake)
    if (this.saved) this.callbacks.address(this.saved.address)
    if (this.saved?.autoConnect) {
      this.enabled = true
      this.attempt()
    }
  }

  private onVisible = (): void => {
    if (document.visibilityState === 'visible') this.wake()
  }

  private wake = (): void => {
    if (!this.enabled || this.hasSession || this.disposed) return
    this.cancelRetry()
    this.retries = 0
    this.attempt()
  }

  private save(address: string, autoConnect: boolean): void {
    this.saved = { address, autoConnect }
    try { localStorage.setItem(SAVED_CONNECTION_KEY, JSON.stringify(this.saved)) } catch {
      // The connection still works when browser storage is unavailable.
    }
  }

  rememberAddress(value: string): void {
    if (this.disposed || this.hasSession) return
    let address: string
    try { address = normalizeWifiAddress(value) } catch { return }
    if (this.saved?.address === address) return
    this.save(address, this.saved?.autoConnect ?? false)
    this.callbacks.address(address)
    if (this.enabled) this.wake()
  }

  connect(value: string): void {
    if (this.disposed) return
    let address: string
    try { address = normalizeWifiAddress(value) } catch (error) {
      this.callbacks.notice((error as Error).message)
      return
    }
    this.pause()
    this.save(address, true)
    this.callbacks.address(address)
    this.enabled = true
    this.retries = 0
    this.attempt(true)
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (!this.disposed) this.callbacks.retrying(false)
  }

  private clearSession(): void {
    if (this.dataTimer !== null) window.clearTimeout(this.dataTimer)
    this.dataTimer = null
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      socket.close()
    }
    if (!this.disposed) {
      this.callbacks.connected(false)
      this.callbacks.connecting(false)
      this.callbacks.reset()
    }
  }

  pause(): void {
    this.enabled = false
    this.cancelRetry()
    this.clearSession()
  }

  disconnect(): void {
    this.pause()
    if (this.saved) this.save(this.saved.address, false)
    this.callbacks.notice('已暂停 Wi-Fi 自动连接，点击连接可恢复。')
  }

  dispose(): void {
    this.disposed = true
    this.pause()
    document.removeEventListener('visibilitychange', this.onVisible)
    window.removeEventListener('online', this.wake)
  }

  private retry(): void {
    if (!this.enabled || this.disposed || this.retryTimer !== null) return
    const delay = RETRY_DELAYS[this.retries]
    this.retries = Math.min(this.retries + 1, RETRY_DELAYS.length - 1)
    this.callbacks.retrying(true)
    this.callbacks.notice(`Wi-Fi 监控暂未连接，${delay / 1000} 秒后重试。请确认同一局域网、板端 IP 和固件 0.1.4 或更新版本。`)
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      this.callbacks.retrying(false)
      this.attempt()
    }, delay)
  }

  private attempt(manual = false): void {
    if (!this.enabled || !this.saved || this.hasSession || this.disposed) return
    if (window.location.protocol === 'https:') {
      this.enabled = false
      this.callbacks.notice('Wi-Fi 直连请使用本机 http://127.0.0.1:5173 页面；HTTPS 网站需要安全代理支持。')
      return
    }
    if (!manual && document.visibilityState !== 'visible') {
      this.callbacks.retrying(true)
      this.callbacks.notice('页面恢复显示后自动连接 Wi-Fi。')
      return
    }
    this.callbacks.connecting(true)
    this.callbacks.notice('')
    this.callbacks.reset()
    let socket: WebSocket
    try {
      socket = new WebSocket(`ws://${this.saved.address}/ws`)
    } catch (error) {
      this.enabled = false
      this.callbacks.connecting(false)
      this.callbacks.notice(error instanceof Error ? error.message : '浏览器无法建立 Wi-Fi 连接。')
      return
    }
    this.socket = socket
    const active = (): boolean => this.socket === socket && this.enabled && !this.disposed
    const recover = (): void => {
      if (!active()) return
      this.clearSession()
      this.retry()
    }
    const armTimeout = (): void => {
      if (this.dataTimer !== null) window.clearTimeout(this.dataTimer)
      this.dataTimer = window.setTimeout(recover, DATA_TIMEOUT_MS)
    }
    let helloReceived = false
    let statusReceived = false
    let connected = false
    armTimeout()
    socket.onopen = () => {
      if (!active()) return
      try {
        socket.send(`${JSON.stringify({ type: 'command', protocol: PROTOCOL_VERSION, action: 'hello.get' })}\n`)
      } catch { recover() }
    }
    socket.onmessage = (event: MessageEvent) => {
      if (!active() || typeof event.data !== 'string' || event.data.length > 32768) return
      const message = parseBoardMessage(event.data.trim())
      if (!message) return
      if (message.type === 'hello') {
        if (message.board !== 'easyinput-v2' || message.chip !== 'ESP32-S3') { recover(); return }
        helloReceived = true
      }
      if (message.type === 'status') {
        statusReceived = true
        if (helloReceived) armTimeout()
      }
      this.callbacks.text(event.data.endsWith('\n') ? event.data : `${event.data}\n`)
      if (!connected && helloReceived && statusReceived) {
        connected = true
        armTimeout()
        this.retries = 0
        this.callbacks.connecting(false)
        this.callbacks.connected(true)
        this.callbacks.notice('')
      }
    }
    socket.onclose = recover
    socket.onerror = recover
  }
}
