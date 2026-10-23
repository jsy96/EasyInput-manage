import { BLE_RX_UUID, BLE_SERVICE_UUID, BLE_TX_UUID, PROTOCOL_VERSION } from '@shared/protocol'

const SAVED_DEVICE_KEY = 'easyinput.bluetooth.v1'
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000]
const WRITE_CHUNK_BYTES = 20

type SavedDevice = { id: string; autoConnect: boolean }
type Callbacks = {
  connected(value: boolean): void
  connecting(value: boolean): void
  retrying(value: boolean): void
  notice(message: string): void
  reset(): void
  text(value: string): void
}

function readSavedDevice(): SavedDevice | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_DEVICE_KEY) ?? 'null') as Partial<SavedDevice> | null
    return saved && typeof saved.id === 'string' && typeof saved.autoConnect === 'boolean'
      ? { id: saved.id, autoConnect: saved.autoConnect } : null
  } catch {
    return null
  }
}

/** Browser authorization stays with the browser; only its opaque device ID is saved here. */
export class BluetoothConnection {
  private saved = readSavedDevice()
  private rememberedDevice: EasyInputBluetoothDevice | null = null
  private device: EasyInputBluetoothDevice | null = null
  private tx: EasyInputBluetoothCharacteristic | null = null
  private rx: EasyInputBluetoothCharacteristic | null = null
  private disconnected: EventListener | null = null
  private notification: EventListener | null = null
  private retryTimer: number | null = null
  private retries = 0
  private generation = 0
  private inFlight = false
  private enabled = false
  private disposed = false

  constructor(private readonly callbacks: Callbacks) {}

  get hasSession(): boolean { return this.device !== null }
  get writable(): boolean { return Boolean(this.device?.gatt?.connected && this.rx) }

  start(): void {
    document.addEventListener('visibilitychange', this.onVisible)
    navigator.bluetooth?.addEventListener('availabilitychanged', this.onAvailable)
    if (!this.saved?.autoConnect) return
    this.enabled = true
    void this.attempt(false)
  }

  private onVisible = (): void => {
    if (document.visibilityState === 'visible') this.wake()
  }

  private onAvailable: EventListener = (event) => {
    if ((event as Event & { value?: boolean }).value) this.wake()
  }

  private wake(): void {
    if (!this.enabled || this.hasSession || this.inFlight || this.disposed) return
    this.cancelRetry()
    this.retries = 0
    void this.attempt(false)
  }

  private savePreference(autoConnect: boolean): void {
    const id = this.rememberedDevice?.id ?? this.saved?.id
    if (!id) return
    this.saved = { id, autoConnect }
    try { localStorage.setItem(SAVED_DEVICE_KEY, JSON.stringify(this.saved)) } catch {
      // Restricted storage still permits reconnection during this page session.
    }
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (!this.disposed) this.callbacks.retrying(false)
  }

  private clearSession(disconnect: boolean): void {
    const device = this.device
    if (device && this.disconnected) device.removeEventListener('gattserverdisconnected', this.disconnected)
    if (this.tx && this.notification) this.tx.removeEventListener('characteristicvaluechanged', this.notification)
    this.device = null
    this.tx = null
    this.rx = null
    this.disconnected = null
    this.notification = null
    // disconnect() also cancels a pending GATT connection.
    if (disconnect) device?.gatt?.disconnect()
    if (!this.disposed) {
      this.callbacks.connected(false)
      this.callbacks.reset()
    }
  }

  /** Pause for preview/flashing without changing the user's saved preference. */
  pause(): void {
    this.enabled = false
    this.generation++
    this.cancelRetry()
    this.clearSession(true)
    if (!this.disposed) this.callbacks.connecting(false)
  }

  disconnect(): void {
    this.pause()
    this.savePreference(false)
    this.callbacks.notice('已暂停自动连接，点击连接可恢复。')
  }

  dispose(): void {
    this.disposed = true
    this.pause()
    document.removeEventListener('visibilitychange', this.onVisible)
    navigator.bluetooth?.removeEventListener('availabilitychanged', this.onAvailable)
  }

  async connect(): Promise<void> {
    if (this.inFlight || this.writable || this.disposed) return
    this.enabled = true
    this.retries = 0
    this.cancelRetry()
    await this.attempt(true)
  }

  private retry(): void {
    if (!this.enabled || this.disposed || this.retryTimer !== null) return
    const delay = RETRY_DELAYS[this.retries]
    this.retries = Math.min(this.retries + 1, RETRY_DELAYS.length - 1)
    this.callbacks.notice(`蓝牙暂未连接，${delay / 1000} 秒后自动重试。`)
    this.callbacks.retrying(true)
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      this.callbacks.retrying(false)
      void this.attempt(false)
    }, delay)
  }

  recover(): void {
    this.clearSession(true)
    if (!this.inFlight) this.retry()
  }

  private async attempt(manual: boolean): Promise<void> {
    if (!this.enabled || this.inFlight || this.writable || this.disposed) return
    if (!manual && document.visibilityState !== 'visible') {
      this.callbacks.retrying(true)
      this.callbacks.notice('页面恢复显示后自动连接蓝牙。')
      return
    }
    const bluetooth = navigator.bluetooth
    if (!bluetooth) {
      this.callbacks.notice('此浏览器不支持蓝牙连接，请使用支持 Web Bluetooth 的 Chrome 或 Edge。')
      return
    }
    this.inFlight = true
    const generation = ++this.generation
    const active = (): boolean => generation === this.generation && this.enabled && !this.disposed
    const check = (): void => { if (!active()) throw new DOMException('连接已取消', 'AbortError') }
    this.callbacks.connecting(true)
    this.callbacks.notice('')
    let retry = false
    let selecting = false
    let attemptDevice: EasyInputBluetoothDevice | null = null
    try {
      let device = this.rememberedDevice
      if (!device && this.saved && bluetooth.getDevices) {
        const devices = await bluetooth.getDevices()
        check()
        device = devices.find((candidate) => candidate.id === this.saved?.id) ?? null
      }
      if (!device) {
        if (!manual) {
          this.enabled = false
          this.callbacks.notice(bluetooth.getDevices
            ? '已保存设备的授权不可用，请点击连接重新选择设备。'
            : '此浏览器需要点击连接才能恢复蓝牙授权。')
          return
        }
        selecting = true
        device = await bluetooth.requestDevice({
          filters: [{ namePrefix: 'EasyInput' }],
          optionalServices: [BLE_SERVICE_UUID],
        })
        selecting = false
        check()
      }
      this.rememberedDevice = device
      this.savePreference(true)
      const server = device.gatt
      if (!server) throw new Error('所选设备不支持 GATT 连接。')
      this.device = device
      attemptDevice = device
      this.callbacks.reset()
      this.disconnected = () => {
        if (!active() || this.device !== device) return
        this.clearSession(false)
        if (!this.inFlight) this.retry()
      }
      device.addEventListener('gattserverdisconnected', this.disconnected)
      const connectedServer = await server.connect()
      check()
      const service = await connectedServer.getPrimaryService(BLE_SERVICE_UUID)
      check()
      const tx = await service.getCharacteristic(BLE_TX_UUID)
      check()
      const rx = await service.getCharacteristic(BLE_RX_UUID)
      check()
      if (this.device !== device || !server.connected) throw new Error('蓝牙连接已断开。')
      const decoder = new TextDecoder()
      this.tx = tx
      this.rx = rx
      this.notification = () => {
        if (!active() || this.device !== device || !tx.value) return
        const { buffer, byteOffset, byteLength } = tx.value
        this.callbacks.text(decoder.decode(new Uint8Array(buffer, byteOffset, byteLength), { stream: true }))
      }
      tx.addEventListener('characteristicvaluechanged', this.notification)
      await tx.startNotifications()
      check()
      // A bonded peer may restore its subscription before the page starts listening.
      await this.write(new TextEncoder().encode(`${JSON.stringify({ type: 'command', protocol: PROTOCOL_VERSION, action: 'hello.get' })}\n`))
      check()
      if (this.device !== device || !server.connected) throw new Error('蓝牙连接已断开。')
      this.retries = 0
      this.callbacks.connected(true)
      this.callbacks.notice(bluetooth.getDevices ? '' : '本次断线会自动重连；重新打开页面时可能仍需点击连接。')
    } catch (error) {
      if (!active()) return
      this.clearSession(true)
      const name = error instanceof DOMException ? error.name : ''
      if (selecting && name === 'NotFoundError') {
        this.enabled = false
      } else if (name === 'SecurityError' || name === 'NotAllowedError' || name === 'NotFoundError') {
        this.enabled = false
        this.rememberedDevice = null
        this.callbacks.notice('蓝牙授权或服务不可用，请点击“重新选择设备”并确认系统配对。')
      } else {
        retry = true
        this.callbacks.notice(error instanceof Error ? error.message : '蓝牙连接失败。')
      }
    } finally {
      // A late native completion must not reopen a canceled or disposed session.
      if (generation !== this.generation || this.disposed) attemptDevice?.gatt?.disconnect()
      this.inFlight = false
      if (active()) this.callbacks.connecting(false)
      // Permission errors disable automatic retries but must still clear the spinner.
      else if (generation === this.generation && !this.disposed) this.callbacks.connecting(false)
    }
    if (retry && active()) this.retry()
  }

  async selectDevice(): Promise<void> {
    if (this.inFlight || this.disposed) return
    this.pause()
    this.savePreference(false)
    this.rememberedDevice = null
    this.saved = null
    await this.connect()
  }

  async write(frame: Uint8Array): Promise<void> {
    const device = this.device
    const rx = this.rx
    const generation = this.generation
    if (!device?.gatt?.connected || !rx) throw new Error('蓝牙命令通道已断开。')
    for (let offset = 0; offset < frame.length; offset += WRITE_CHUNK_BYTES) {
      if (generation !== this.generation || this.device !== device || !device.gatt.connected) throw new Error('蓝牙命令通道已断开。')
      const chunk = frame.slice(offset, offset + WRITE_CHUNK_BYTES)
      try { await rx.writeValueWithResponse(chunk) } finally { chunk.fill(0) }
    }
  }
}
