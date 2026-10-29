import {
  AUDIO_BATCH, AUDIO_CHUNK, CHAT_VERSION, CHAT_LIMIT, CHAT_PAGE_SIZE, REALTIME_FRAME_BYTES,
  decodeRealtimePacket, fromBase64, sortMessages, toBase64, isChatMessage, isChatCursor, compareMessages, isVoiceMessage,
} from '@shared/chat'
import type { ChatMessage, RoomState, ChatCursor, ChatPage } from '@shared/chat'
import { emptyRoom } from '@shared/chat'
import { isHealthRecord } from '@shared/health'
import type { HealthRecord } from '@shared/health'
import { isLedgerRecord } from '@shared/ledger'
import type { LedgerRecord } from '@shared/ledger'
type Frame = Record<string, unknown>
export type RealtimeEvent =
  | { type: 'start' }
  | { type: 'packet'; sequence: number; samples: Int16Array }
  | { type: 'chunk'; data: string }
  | { type: 'stop' }
const ID_KEY = 'easyinput.chat.client.v1'
export function clientIdentity(): { id: string; name: string } {
  try { const s = JSON.parse(localStorage.getItem(ID_KEY) ?? 'null') as { id: string; name: string } | null; if (s?.id && s.name) return s } catch { /* initialize */ }
  const s = { id: crypto.randomUUID(), name: `电脑 ${Math.random().toString(36).slice(2, 5).toUpperCase()}` }
  try { localStorage.setItem(ID_KEY, JSON.stringify(s)) } catch { /* per-page identity */ }
  return s
}
export class ChatConnection {
  state: RoomState = { ...emptyRoom }
  gateway = import.meta.env.VITE_CHAT_GATEWAY || 'wss://easy.leige.online'
  device = 'easyinput-v2'
  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private retries = 0
  private lastPong = 0
  private pending = new Map<string, { resolve: (f: Frame) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private realtimeListeners = new Set<(event: RealtimeEvent) => void>()
  private uploadBusy = false
  private historyLoading = false
  private generation = 0
  private pruned = new Set<string>()
  private displayedTexts = new Set<string>()
  private displayingTexts = new Map<string, Promise<void>>()
  readonly identity = clientIdentity()
  constructor(private readonly callbacks: {
    state(s: RoomState): void
    telemetry(text: string): void
    bridge(value: Frame): Promise<void>
    notice(message: string): void
    realtime(event: RealtimeEvent): void
  }) {}
  private update(patch: Partial<RoomState>): void { this.state = { ...this.state, ...patch }; this.callbacks.state(this.state) }
  start(): void { this.stopped = false; this.connect(); window.addEventListener('online', this.wake); document.addEventListener('visibilitychange', this.wake) }
  private wake = (): void => { if (!this.socket && !this.stopped) { if (this.timer) clearTimeout(this.timer); this.connect() } }
  private connect(): void {
    if (this.stopped || this.socket) return
    const query = new URLSearchParams({ role: 'browser', device: this.device, client: this.identity.id, name: this.identity.name })
    const socket = this.socket = new WebSocket(`${this.gateway}/ws?${query}`)
    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) { socket.close(); return }
      this.lastPong = Date.now(); this.retries = 0
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > 15000) { socket.close(); return }
        this.send({ type: 'chat', protocol: CHAT_VERSION, op: 'ping' })
      }, 3000)
    }
    socket.onmessage = (event: MessageEvent) => {
      if (this.stopped || this.socket !== socket) return
      if (event.data instanceof ArrayBuffer) {
        if (event.data.byteLength !== REALTIME_FRAME_BYTES) return
        const packet = decodeRealtimePacket(event.data)
        if (packet) this.emitRealtime({ type: 'packet', sequence: packet.sequence, samples: packet.samples })
        return
      }
      if (typeof event.data !== 'string' || event.data.length > 131072) return
      let v: Frame
      try { v = JSON.parse(event.data) as Frame } catch { return }
      if (v.type === 'bridge') { void this.callbacks.bridge(v.payload as Frame).catch(e => this.callbacks.notice(e instanceof Error ? e.message : '蓝牙网关发送失败')); return }
      if (v.type !== 'chat') { this.callbacks.telemetry(`${event.data}\n`); return }
      if (v.op === 'pong') this.lastPong = Date.now()
      if (v.op === 'snapshot') {
        this.generation++
        this.pruned.clear()
        this.displayedTexts.clear()
        this.displayingTexts.clear()
        this.update({
        connected: true,
        online: Boolean(v.online),
        via: v.via as RoomState['via'],
        messages: sortMessages(v.messages as ChatMessage[]),
        total: Number(v.total ?? (v.messages as ChatMessage[]).length),
        unread: Number(v.unread ?? (v.messages as ChatMessage[]).filter(m => !m.read).length),
        next: isChatCursor(v.next) ? v.next : null,
        clients: v.clients as RoomState['clients'],
        self: v.self as RoomState['self'],
        realtimeEnabled: v.realtimeEnabled === true,
        realtimeActive: v.realtimeActive === true,
        healthPending: typeof v.healthPending === 'number' ? v.healthPending : null,
        ledgerPending: typeof v.ledgerPending === 'number' ? v.ledgerPending : null,
      })
      }
      if (v.op === 'presence') this.update({ online: Boolean(v.online), via: v.via as RoomState['via'], clients: v.clients as RoomState['clients'], healthPending: typeof v.healthPending === 'number' ? v.healthPending : null, ledgerPending: typeof v.ledgerPending === 'number' ? v.ledgerPending : null })
      if (v.op === 'settings') this.update({ realtimeEnabled: v.realtime_enabled === true })
      if (v.op === 'realtime.start') { this.update({ realtimeActive: true }); this.emitRealtime({ type: 'start' }) }
      if (v.op === 'realtime.chunk' && typeof v.data === 'string') this.emitRealtime({ type: 'chunk', data: v.data })
      if (v.op === 'realtime.stop') { this.update({ realtimeActive: false }); this.emitRealtime({ type: 'stop' }) }
      if (v.op === 'message' && isChatMessage(v.message)) {
        const m = v.message
        const loaded = this.state.messages.some(x => x.id === m.id)
        const displayReplay = v.display_required === true && m.kind === 'text' && m.sender === 'board'
        const messages = loaded || v.added === true || displayReplay ? sortMessages([...this.state.messages.filter(x => x.id !== m.id), m]).slice(-CHAT_LIMIT) : this.state.messages
        this.update({ messages, total: Number(v.total ?? this.state.total), unread: Number(v.unread ?? this.state.unread) })
      }
      if (v.op === 'readAll') this.update({ messages: this.state.messages.map(m => ({ ...m, read: true })), unread: 0 })
      if (v.op === 'pruned' && Array.isArray(v.ids)) {
        for (const id of v.ids as string[]) this.pruned.add(id)
        this.update({ messages: this.state.messages.filter(m => !this.pruned.has(m.id)), total: Number(v.total ?? this.state.total), unread: Number(v.unread ?? this.state.unread) })
      }
      if (typeof v.req === 'string') {
        const pending = this.pending.get(v.req)
        if (pending) { clearTimeout(pending.timer); this.pending.delete(v.req); if (v.op === 'error') pending.reject(new Error(String(v.message))); else pending.resolve(v) }
      }
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.generation++
      this.displayedTexts.clear()
      this.displayingTexts.clear()
      this.socket = null; if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null
      this.update({ connected: false, online: false, via: null, healthPending: null, ledgerPending: null })
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('群聊连接中断，请重新发送')) } this.pending.clear()
      if (!this.stopped) this.timer = setTimeout(() => { this.timer = null; this.connect() }, Math.min(30000, 1000 * 2 ** this.retries++))
    }
    socket.onerror = () => socket.close()
  }
  send(v: Frame): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(v)) }
  onRealtime(listener: (event: RealtimeEvent) => void): () => void {
    this.realtimeListeners.add(listener)
    return () => this.realtimeListeners.delete(listener)
  }
  private emitRealtime(event: RealtimeEvent): void {
    this.callbacks.realtime(event)
    for (const listener of this.realtimeListeners) listener(event)
  }
  bridge(payload: Frame): void { this.send({ type: 'gateway', payload }) }
  gatewayOff(): void { this.send({ type: 'chat', protocol: CHAT_VERSION, op: 'gateway.off' }) }
  private request(op: string, data: Frame, timeoutMs = 20000): Promise<Frame> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('正在连接群聊，请稍后重试'))
    const req = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(req); reject(new Error('等待语音传输超时，请重试')) }, timeoutMs)
      this.pending.set(req, { resolve, reject, timer }); this.send({ type: 'chat', protocol: CHAT_VERSION, op, req, ...data })
    })
  }
  textDisplayed(id: string): Promise<void> {
    if (this.stopped || !this.state.connected || !this.state.messages.some(m => m.id === id && m.kind === 'text' && m.sender === 'board')) {
      return Promise.reject(new Error('转写文字尚未载入聊天记录'))
    }
    if (this.displayedTexts.has(id)) return Promise.resolve()
    const pending = this.displayingTexts.get(id)
    if (pending) return pending
    const generation = this.generation
    const receipt = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const ack = await this.request('text.displayed', { id }, 3000)
          if (this.stopped || generation !== this.generation || !this.state.connected) throw new Error('群聊连接已变更')
          if (ack.op !== 'text.displayed' || ack.id !== id) throw new Error('文字送达确认异常')
          this.displayedTexts.add(id)
          return
        } catch (error) {
          if (this.stopped || generation !== this.generation || !this.state.connected || attempt === 2) throw error
        }
      }
    })().finally(() => { if (this.displayingTexts.get(id) === receipt) this.displayingTexts.delete(id) })
    this.displayingTexts.set(id, receipt)
    return receipt
  }
  async upload(bytes: Uint8Array, progress?: (p: number) => void): Promise<void> {
    if (this.uploadBusy) throw new Error('上一条语音仍在发送')
    this.uploadBusy = true
    try {
      const id = crypto.randomUUID()
      const begin = await this.request('begin', { id, samples: bytes.length })
      let next = Number(begin.next) || 0
      while (next * AUDIO_CHUNK < bytes.length) {
        const chunks = Array.from({ length: AUDIO_BATCH }, (_, offset) => {
          const index = next + offset
          if (index * AUDIO_CHUNK >= bytes.length) return null
          return { index, data: toBase64(bytes.subarray(index * AUDIO_CHUNK, (index + 1) * AUDIO_CHUNK)) }
        }).filter((chunk): chunk is { index: number; data: string } => chunk !== null)
        const ack = await this.request('chunks', { id, chunks })
        next = Number(ack.next)
        progress?.(Math.min(99, Math.floor(next * AUDIO_CHUNK / bytes.length * 100)))
      }
      await this.request('commit', { id }); progress?.(100)
    } finally { this.uploadBusy = false }
  }
  async setRealtimeEnabled(enabled: boolean): Promise<void> {
    await this.request('realtime.set', { enabled })
  }
  private async historyPage(before?: ChatCursor, through?: ChatCursor): Promise<ChatPage> {
    const page = await this.request('list', { ...(before ? { before } : {}), ...(through ? { through } : {}) })
    if (!Array.isArray(page.messages) || page.messages.length > CHAT_PAGE_SIZE || !page.messages.every(isChatMessage) ||
      !Number.isInteger(page.total) || Number(page.total) < page.messages.length || Number(page.total) > CHAT_LIMIT ||
      (page.next !== null && !isChatCursor(page.next)) || (page.through !== null && !isChatCursor(page.through))) throw new Error('语音历史响应异常')
    const messages = page.messages as ChatMessage[], next = page.next as ChatCursor | null, upper = page.through as ChatCursor | null
    if ((through && (!upper || compareMessages(upper, through) !== 0)) ||
      messages.some((m, i) => (i > 0 && compareMessages(messages[i - 1], m) >= 0) || (before && compareMessages(m, before) >= 0) || (upper && compareMessages(m, upper) > 0)) ||
      (next && (!messages.length || compareMessages(next, messages[0]) !== 0 || (before && compareMessages(next, before) >= 0)))) throw new Error('语音历史分页未能继续')
    return { messages, next, through: upper, total: Number(page.total) }
  }
  async loadOlder(): Promise<void> {
    if (this.historyLoading || !this.state.next) return
    this.historyLoading = true
    const generation = this.generation
    try {
      const page = await this.historyPage(this.state.next)
      if (generation !== this.generation) throw new Error('语音服务已重新连接，请重新加载历史')
      const messages = new Map(page.messages.filter(m => !this.pruned.has(m.id)).map(m => [m.id, m]))
      // Fresh broadcasts win over metadata downloaded just before a read acknowledgement.
      for (const m of this.state.messages) messages.set(m.id, m)
      this.update({ messages: sortMessages([...messages.values()]), next: page.next })
    } finally { this.historyLoading = false }
  }
  async voiceHistory(progress?: (count: number, total: number) => void): Promise<ChatMessage[]> {
    const generation = this.generation, records: ChatMessage[] = []
    let before: ChatCursor | undefined, through: ChatCursor | undefined, total: number | undefined
    do {
      const page = await this.historyPage(before, through)
      if (generation !== this.generation) throw new Error('语音服务已重新连接，请重新获取历史')
      through ??= page.through ?? undefined
      total ??= page.total
      if (page.messages.some(m => this.pruned.has(m.id))) throw new Error('语音历史在读取期间发生清理，请重试')
      records.push(...page.messages)
      progress?.(records.length, total)
      if (!page.next) break
      before = page.next
    } while (records.length < CHAT_LIMIT)
    if (records.length !== total || new Set(records.map(m => m.id)).size !== records.length) throw new Error('语音历史在读取期间发生清理，请重试')
    return sortMessages(records).filter(isVoiceMessage)
  }
  async healthHistory(progress?: (count: number) => void): Promise<HealthRecord[]> {
    const records: HealthRecord[] = []
    let after = 0, through: number | undefined
    for (;;) {
      const page = await this.request('health.list', { after, ...(through === undefined ? {} : { through }) })
      if (!Array.isArray(page.records) || !page.records.every(isHealthRecord) || !Number.isSafeInteger(page.through) ||
        Number(page.through) < after || (through !== undefined && page.through !== through) ||
        !Number.isSafeInteger(page.next) || Number(page.next) < after || Number(page.next) > Number(page.through) ||
        page.records.length !== Number(page.next) - after || page.records.some((r, i) => r.sequence !== after + i + 1)) throw new Error('测量记录响应异常')
      through = Number(page.through)
      records.push(...page.records)
      progress?.(records.length)
      if (page.next === through) return records
      if (Number(page.next) <= after) throw new Error('测量记录下载未能继续')
      after = Number(page.next)
    }
  }
  async ledgerHistory(progress?: (count: number) => void): Promise<LedgerRecord[]> {
    const records: LedgerRecord[] = [], ids = new Set<string>()
    const generation = this.generation
    let after = 0, through: number | undefined
    for (;;) {
      const page = await this.request('ledger.list', { after, ...(through === undefined ? {} : { through }) })
      if (generation !== this.generation) throw new Error('记账服务已重新连接，请重新下载')
      if (!Array.isArray(page.records) || !page.records.every(isLedgerRecord) || !Number.isSafeInteger(page.through) ||
        Number(page.through) < after || (through !== undefined && page.through !== through) ||
        !Number.isSafeInteger(page.next) || Number(page.next) < after || Number(page.next) > Number(page.through) ||
        page.records.length > 100 || page.records.length !== Number(page.next) - after ||
        page.records.some((r, i) => r.sequence !== after + i + 1 || ids.has(r.id)) ||
        new Set(page.records.map(r => r.id)).size !== page.records.length) throw new Error('记账记录响应异常')
      through = Number(page.through)
      for (const record of page.records) { records.push(record); ids.add(record.id) }
      progress?.(records.length)
      if (page.next === through) return records
      if (Number(page.next) <= after) throw new Error('记账记录下载未能继续')
      after = Number(page.next)
    }
  }
  async download(m: ChatMessage): Promise<Uint8Array> {
    if (!isVoiceMessage(m)) throw new Error('文字消息没有语音文件')
    const out = new Uint8Array(m.samples)
    for (let start = 0; start * AUDIO_CHUNK < m.samples; start += AUDIO_BATCH) {
      const v = await this.request('pullBatch', { id: m.id, index: start, count: AUDIO_BATCH })
      for (const chunk of v.chunks as Array<{ index: number; data: string }>) out.set(fromBase64(chunk.data), chunk.index * AUDIO_CHUNK)
    }
    return out
  }
  dispose(): void {
    this.displayedTexts.clear(); this.displayingTexts.clear()
    this.stopped = true; if (this.timer) clearTimeout(this.timer); if (this.heartbeat) clearInterval(this.heartbeat)
    const socket = this.socket; this.socket = null
    if (socket) { socket.onopen = socket.onclose = socket.onmessage = socket.onerror = null; socket.close() }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('群聊已关闭')) }
    this.pending.clear()
    window.removeEventListener('online', this.wake); document.removeEventListener('visibilitychange', this.wake)
  }
}
