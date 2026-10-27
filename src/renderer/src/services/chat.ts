import { AUDIO_CHUNK, fromBase64, toBase64 } from '@shared/chat'
import type { ChatMessage, RoomState } from '@shared/chat'
import { emptyRoom } from '@shared/chat'
type Frame = Record<string, unknown>
const ID_KEY = 'easyinput.chat.client.v1'
export function clientIdentity(): { id: string; name: string } {
  try { const s = JSON.parse(localStorage.getItem(ID_KEY) ?? 'null') as { id: string; name: string } | null; if (s?.id && s.name) return s } catch { /* initialize */ }
  const s = { id: crypto.randomUUID(), name: `电脑 ${Math.random().toString(36).slice(2, 5).toUpperCase()}` }
  try { localStorage.setItem(ID_KEY, JSON.stringify(s)) } catch { /* per-page identity */ }
  return s
}
export class ChatConnection {
  state: RoomState = { ...emptyRoom }
  gateway = 'wss://easy.leige.online'
  device = 'easyinput-v2'
  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private retries = 0
  private lastPong = 0
  private pending = new Map<string, { resolve: (f: Frame) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private uploadBusy = false
  readonly identity = clientIdentity()
  constructor(private readonly callbacks: { state(s: RoomState): void; telemetry(text: string): void; bridge(value: Frame): Promise<void>; notice(message: string): void }) {}
  private update(patch: Partial<RoomState>): void { this.state = { ...this.state, ...patch }; this.callbacks.state(this.state) }
  start(): void { this.stopped = false; this.connect(); window.addEventListener('online', this.wake); document.addEventListener('visibilitychange', this.wake) }
  private wake = (): void => { if (!this.socket && !this.stopped) { if (this.timer) clearTimeout(this.timer); this.connect() } }
  private connect(): void {
    if (this.stopped || this.socket) return
    const query = new URLSearchParams({ role: 'browser', device: this.device, client: this.identity.id, name: this.identity.name })
    const socket = this.socket = new WebSocket(`${this.gateway}/ws?${query}`)
    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) { socket.close(); return }
      this.lastPong = Date.now(); this.retries = 0
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > 15000) { socket.close(); return }
        this.send({ type: 'chat', protocol: 1, op: 'ping' })
      }, 3000)
    }
    socket.onmessage = (event: MessageEvent) => {
      if (this.stopped || this.socket !== socket) return
      if (typeof event.data !== 'string' || event.data.length > 131072) return
      let v: Frame
      try { v = JSON.parse(event.data) as Frame } catch { return }
      if (v.type === 'bridge') { void this.callbacks.bridge(v.payload as Frame).catch(e => this.callbacks.notice(e instanceof Error ? e.message : '蓝牙网关发送失败')); return }
      if (v.type !== 'chat') { this.callbacks.telemetry(`${event.data}\n`); return }
      if (v.op === 'pong') this.lastPong = Date.now()
      if (v.op === 'snapshot') this.update({ connected: true, online: Boolean(v.online), via: v.via as RoomState['via'], messages: v.messages as ChatMessage[], clients: v.clients as RoomState['clients'], self: v.self as RoomState['self'] })
      if (v.op === 'presence') this.update({ online: Boolean(v.online), via: v.via as RoomState['via'], clients: v.clients as RoomState['clients'] })
      if (v.op === 'message') {
        const m = v.message as ChatMessage
        this.update({ messages: [...this.state.messages.filter(x => x.id !== m.id), m].sort((a, b) => a.created - b.created).slice(-100) })
      }
      if (v.op === 'pruned') this.update({ messages: this.state.messages.filter(m => !(v.ids as string[]).includes(m.id)) })
      if (v.op === 'cleared') this.update({ messages: this.state.messages.map(m => (v.ids as string[]).includes(m.id) ? { ...m, cleared: true } : m) })
      if (typeof v.req === 'string') {
        const pending = this.pending.get(v.req)
        if (pending) { clearTimeout(pending.timer); this.pending.delete(v.req); if (v.op === 'error') pending.reject(new Error(String(v.message))); else pending.resolve(v) }
      }
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null; if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null
      this.update({ connected: false, online: false, via: null })
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('群聊连接中断，请重新发送')) } this.pending.clear()
      if (!this.stopped) this.timer = setTimeout(() => { this.timer = null; this.connect() }, Math.min(30000, 1000 * 2 ** this.retries++))
    }
    socket.onerror = () => socket.close()
  }
  send(v: Frame): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(v)) }
  bridge(payload: Frame): void { this.send({ type: 'gateway', payload }) }
  gatewayOff(): void { this.send({ type: 'chat', protocol: 1, op: 'gateway.off' }) }
  private request(op: string, data: Frame): Promise<Frame> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('正在连接群聊，请稍后重试'))
    const req = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req); reject(new Error('等待语音传输超时，请重试')) }, 20000)
      this.pending.set(req, { resolve, reject, timer }); this.send({ type: 'chat', protocol: 1, op, req, ...data })
    })
  }
  async upload(bytes: Uint8Array, text?: string, progress?: (p: number) => void): Promise<void> {
    if (this.uploadBusy) throw new Error('上一条语音仍在发送')
    this.uploadBusy = true
    try {
      const id = crypto.randomUUID()
      const begin = await this.request('begin', { id, samples: bytes.length, text })
      for (let i = Number(begin.next) || 0; i * AUDIO_CHUNK < bytes.length; i++) {
        await this.request('chunk', { id, index: i, data: toBase64(bytes.subarray(i * AUDIO_CHUNK, (i + 1) * AUDIO_CHUNK)) })
        progress?.(Math.min(99, Math.floor((i + 1) * AUDIO_CHUNK / bytes.length * 100)))
      }
      await this.request('commit', { id }); progress?.(100)
    } finally { this.uploadBusy = false }
  }
  async download(m: ChatMessage): Promise<Uint8Array> {
    const out = new Uint8Array(m.samples)
    for (let i = 0; i * AUDIO_CHUNK < m.samples; i++) {
      const v = await this.request('pull', { id: m.id, index: i })
      out.set(fromBase64(String(v.data)), i * AUDIO_CHUNK)
    }
    return out
  }
  dispose(): void {
    this.stopped = true; if (this.timer) clearTimeout(this.timer); if (this.heartbeat) clearInterval(this.heartbeat)
    const socket = this.socket; this.socket = null
    if (socket) { socket.onopen = socket.onclose = socket.onmessage = socket.onerror = null; socket.close() }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('群聊已关闭')) }
    this.pending.clear()
    window.removeEventListener('online', this.wake); document.removeEventListener('visibilitychange', this.wake)
  }
}
