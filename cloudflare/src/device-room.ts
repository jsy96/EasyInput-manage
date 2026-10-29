import {
  AUDIO_CHUNK, AUDIO_LIMIT, AUDIO_STREAM_WINDOW, CHAT_LIMIT, CHAT_PAGE_SIZE, BOARD_INDEX_PAGE_SIZE, CHAT_VERSION,
  isRealtimePacket, sortMessages, validId, isChatCursor, isChatMessage, compareMessages, isVoiceMessage, CHAT_TEXT_LIMIT,
} from '../../src/shared/chat'
import type { ChatClient, ChatMessage, ChatCursor, ChatPage } from '../../src/shared/chat'
import { isHealthMeasurement } from '../../src/shared/health'
import type { HealthRecord } from '../../src/shared/health'
import { isLedgerEntry, ledgerDay } from '../../src/shared/ledger'
import type { LedgerRecord } from '../../src/shared/ledger'

type Attachment = { role: 'board' | 'browser'; client?: string; name?: string; last?: number; uptime?: number; healthPending?: number; ledgerPending?: number }
type Frame = Record<string, unknown>
type Upload = { id: string; sender: string; name: string; samples: number; next: number; created: number; updated?: number }
const frame = (op: string, data: Frame = {}): Frame => ({ type: 'chat', protocol: CHAT_VERSION, op, ...data })
const MAX_BATCH = 32

export class DeviceRoomV2 {
  private realtimeOpen = false
  private historyReady: Promise<void> | null = null
  private history: ChatMessage[] = []
  private revision = 0
  private async loadHistory(): Promise<void> {
    if (!this.historyReady) this.historyReady = this.state.blockConcurrencyWhile(async () => {
      const version = await this.state.storage.get<number>('voice-revision')
      if (version !== undefined) {
        let startAfter: string | undefined
        for (;;) {
          const page = await this.state.storage.list<ChatMessage>({ prefix: 'voice-message:', limit: 1000, ...(startAfter ? { startAfter } : {}) })
          this.history.push(...page.values())
          if (page.size < 1000) break
          startAfter = [...page.keys()].at(-1)!
        }
        this.history = sortMessages(this.history)
        this.revision = version
      } else {
        // Publish the marker and migrated rows atomically. Existing audio stays readable.
        const legacy = await this.state.storage.get<unknown[]>('messages') ?? []
        this.history = sortMessages(legacy.filter(isChatMessage).filter(m => (m as unknown as Frame).cleared !== true))
        await this.state.storage.transaction(async tx => {
          for (let i = 0; i < this.history.length; i += 100) {
            await tx.put(Object.fromEntries(this.history.slice(i, i + 100).map(m => [`voice-message:${m.id}`, m])))
          }
          await tx.put('voice-revision', 0)
          await tx.delete('messages')
        })
      }
    }).catch(error => { this.historyReady = null; this.history = []; throw error })
    await this.historyReady
  }
  private async saveMessages(items: ChatMessage[], extra: Record<string, unknown> = {}, remove: string[] = []): Promise<void> {
    const previous = new Map(this.history.map(m => [m.id, m]))
    const writes: Record<string, unknown> = { ...extra, 'voice-revision': this.revision + 1 }
    for (const m of items) {
      const old = previous.get(m.id)
      if (!old || old.read !== m.read) writes[`voice-message:${m.id}`] = m
      previous.delete(m.id)
    }
    await this.state.storage.transaction(async tx => {
      const entries = Object.entries(writes)
      for (let i = 0; i < entries.length; i += 100) await tx.put(Object.fromEntries(entries.slice(i, i + 100)))
      const removed = [...previous.keys()].map(id => `voice-message:${id}`).concat(remove)
      for (let i = 0; i < removed.length; i += 100) await tx.delete(removed.slice(i, i + 100))
    })
    this.history = sortMessages(items)
    this.revision++
  }
  private page(before?: ChatCursor, through?: ChatCursor): ChatPage {
    const upper = through ?? this.history.at(-1) ?? null
    const eligible = this.history.filter(m => (!upper || compareMessages(m, upper) <= 0) && (!before || compareMessages(m, before) < 0))
    const messages = eligible.slice(-CHAT_PAGE_SIZE)
    return { messages, next: eligible.length > messages.length ? { created: messages[0].created, id: messages[0].id } : null,
      through: upper ? { created: upper.created, id: upper.id } : null, total: this.history.filter(m => !upper || compareMessages(m, upper) <= 0).length }
  }
  private stats(): Frame { return { total: this.history.length, unread: this.history.filter(m => !m.read).length } }
  private async audioChunk(id: string, index: number, clip?: ArrayBuffer): Promise<string> {
    const bytes = clip ?? await this.state.storage.get<ArrayBuffer>(`clip:${id}`)
    if (bytes) return btoa(String.fromCharCode(...new Uint8Array(bytes).subarray(index * AUDIO_CHUNK, (index + 1) * AUDIO_CHUNK)))
    const legacy = await this.state.storage.get<string>(`audio:${id}:${index}`)
    if (!legacy) throw new Error('语音分片不存在')
    return legacy
  }
  constructor(private readonly state: DurableObjectState) {}
  private sockets(): WebSocket[] { return this.state.getWebSockets().filter((s) => s.readyState === 1) }
  private attachment(s: WebSocket): Attachment { return s.deserializeAttachment() as Attachment }
  private send(s: WebSocket, value: Frame): void { try { s.send(JSON.stringify(value)) } catch { /* close callback cleans presence */ } }
  private sendBinary(s: WebSocket, value: ArrayBuffer): void { try { s.send(value) } catch { /* close callback cleans presence */ } }
  private broadcast(value: Frame, browsersOnly = false): void {
    for (const s of this.sockets()) if (!browsersOnly || this.attachment(s).role === 'browser') this.send(s, value)
  }
  private broadcastBinary(value: ArrayBuffer): void {
    for (const s of this.sockets()) if (this.attachment(s).role === 'browser') this.sendBinary(s, value)
  }
  // Persist and broadcast state changes so clients cannot remain stuck on a stale live indicator.
  private async syncRealtime(active: boolean): Promise<void> {
    const stored = await this.state.storage.get<boolean>('realtime_active') ?? false
    if (stored === active && this.realtimeOpen === active) return
    this.realtimeOpen = active
    await this.state.storage.put('realtime_active', active)
    this.broadcast(frame(active ? 'realtime.start' : 'realtime.stop', {}), true)
  }
  private async stopRealtime(): Promise<void> {
    const enabled = await this.state.storage.get<boolean>('realtime_enabled') ?? false
    await this.state.storage.put('realtime_enabled', false)
    await this.state.storage.delete('realtime_requested_at')
    await this.syncRealtime(false)
    if (enabled) {
      this.broadcast(frame('settings', { realtime_enabled: false }), true)
      this.toBoard(frame('settings', { realtime_enabled: false }))
    }
  }
  private route(): { socket: WebSocket; via: 'wifi' | 'ble' } | null {
    const fresh = this.sockets().filter((s) => Date.now() - (this.attachment(s).last ?? 0) < 8000)
    const direct = fresh.find((s) => this.attachment(s).role === 'board')
    const bridge = fresh.find((s) => this.attachment(s).role === 'browser')
    return direct ? { socket: direct, via: 'wifi' } : bridge ? { socket: bridge, via: 'ble' } : null
  }
  private toBoard(value: Frame): void {
    const route = this.route()
    if (route) this.send(route.socket, route.via === 'ble' ? { type: 'bridge', payload: value } : value)
  }
  private async messages(): Promise<ChatMessage[]> {
    await this.loadHistory()
    return this.history.map(m => ({ ...m }))
  }
  private async clients(): Promise<ChatClient[]> { return await this.state.storage.get<ChatClient[]>('clients') ?? [] }
  private async presence(): Promise<void> {
    const route = this.route()
    if (await this.state.storage.get<boolean>('realtime_enabled')) {
      const requested = await this.state.storage.get<number>('realtime_requested_at') ?? 0
      const active = await this.state.storage.get<boolean>('realtime_active') ?? false
      if (route?.via !== 'wifi' || (!active && Date.now() - requested >= 8000)) await this.stopRealtime()
    }
    const clients = (await this.clients()).map((c) => ({ ...c, online: this.sockets().some((s) => this.attachment(s).client === c.id) }))
    const onlineClients = clients.filter((client) => client.online).length
    this.broadcast(frame('presence', { online: !!route, via: route?.via ?? null, clients, healthPending: route ? this.attachment(route.socket).healthPending ?? null : null, ledgerPending: route ? this.attachment(route.socket).ledgerPending ?? null : null }), true)
    this.toBoard(frame('audience', { online_clients: onlineClients }))
  }
  async fetch(request: Request): Promise<Response> {
    await this.loadHistory()
    if (request.method === 'POST' && request.headers.get('X-EasyInput-Clear') === '1') {
      const cleared = await this.state.blockConcurrencyWhile(() => this.clearHistory())
      return Response.json({ ok: true, cleared })
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 })
    const url = new URL(request.url)
    const role = url.searchParams.get('role')
    const id = url.searchParams.get('client')
    if (role !== 'board' && role !== 'browser') return new Response('Invalid role', { status: 400 })
    if (role === 'browser' && !validId(id)) return new Response('Invalid client', { status: 400 })
    let self: ChatClient | undefined
    if (role === 'browser') {
      await this.state.blockConcurrencyWhile(async () => {
        const clients = await this.clients()
        self = clients.find((c) => c.id === id)
        if (!self) {
          if (clients.length >= 128) throw new Error('群客户端名额已满（128）')
          self = { id: id!, name: (url.searchParams.get('name') ?? '').trim().slice(0, 24) || `电脑 ${clients.length + 1}` }
          clients.push(self)
          await this.state.storage.put('clients', clients)
        }
      })
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.state.acceptWebSocket(server)
    server.serializeAttachment({ role, client: self?.id, name: self?.name } satisfies Attachment)
    if (role === 'browser') {
      const route = this.route()
      this.send(server, frame('snapshot', {
        self, ...this.page(), ...this.stats(), clients: await this.clients(), online: !!route, via: route?.via ?? null,
        realtimeEnabled: await this.state.storage.get<boolean>('realtime_enabled') ?? false,
        realtimeActive: await this.state.storage.get<boolean>('realtime_active') ?? false,
        healthPending: route ? this.attachment(route.socket).healthPending ?? null : null,
        ledgerPending: route ? this.attachment(route.socket).ledgerPending ?? null : null,
      }))
      const hello = await this.state.storage.get<Frame>('hello')
      if (hello) this.send(server, hello)
      this.toBoard({ type: 'command', protocol: 2, action: 'hello.get' })
    } else {
      // A socket alone is not proof of board presence; require fresh telemetry.
      this.send(server, { type: 'command', protocol: 2, action: 'hello.get' })
      this.send(server, frame('settings', { realtime_enabled: await this.state.storage.get<boolean>('realtime_enabled') ?? false }))
    }
    await this.presence()
    await this.state.storage.setAlarm(Date.now() + 5000)
    return new Response(null, { status: 101, webSocket: client })
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.loadHistory()
    if (message instanceof ArrayBuffer) {
      if (this.attachment(socket).role !== 'board' || !isRealtimePacket(message)) return
      if (!this.realtimeOpen) this.realtimeOpen = await this.state.storage.get<boolean>('realtime_active') ?? false
      if (!this.realtimeOpen) return
      this.broadcastBinary(message)
      return
    }
    if (message.length > 65536) return
    let value: Frame
    try { value = JSON.parse(message) as Frame } catch { return }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const a = this.attachment(socket)
    if (value.type === 'gateway' && a.role === 'browser') {
      if (value.payload && typeof value.payload === 'object') await this.boardFrame(socket, value.payload as Frame, true)
      return
    }
    if (value.type !== 'chat') {
      if (a.role === 'board') await this.boardFrame(socket, value, false)
      else if (value.type === 'command' && ['hello.get', 'status.get'].includes(String(value.action))) this.toBoard(value)
      return
    }
    try { await this.chat(socket, value, a.role === 'board') } catch (error) {
      this.send(socket, frame('error', { req: value.req, message: error instanceof Error ? error.message : '群聊处理失败' }))
    }
  }
  private async boardFrame(socket: WebSocket, value: Frame, bridge: boolean): Promise<void> {
    if (value.type === 'chat') {
      // Only the selected board transport may produce read/clear/upload acknowledgements.
      const route = this.route()
      if (!bridge || route?.socket === socket) {
        try { await this.chat(socket, value, true) } catch (error) {
          const response = frame('error', { req: value.req, message: error instanceof Error ? error.message : '群聊处理失败' })
          this.send(socket, bridge ? { type: 'bridge', payload: response } : response)
        }
      }
      return
    }
    if (value.protocol !== 2 || !['hello', 'status', 'event', 'result', 'lights'].includes(String(value.type))) return
    const a = this.attachment(socket)
    const voice = value.voice && typeof value.voice === 'object' ? value.voice as Frame : value
    if (value.type === 'status' && typeof value.uptime_ms === 'number' && value.uptime_ms !== a.uptime) {
      a.last = Date.now(); a.uptime = value.uptime_ms
      if (Number.isInteger(voice.health_pending) && Number(voice.health_pending) >= 0 && Number(voice.health_pending) <= 64) a.healthPending = Number(voice.health_pending)
      if (Number.isInteger(voice.ledger_pending) && Number(voice.ledger_pending) >= 0 && Number(voice.ledger_pending) <= 64) a.ledgerPending = Number(voice.ledger_pending)
      socket.serializeAttachment(a)
    }
    const route = this.route()
    if (value.type === 'hello') await this.state.storage.put('hello', value)
    if (route?.socket === socket || value.type === 'hello') this.broadcast(value, true)
    if (a.role === 'board' && !bridge && value.type === 'status' && typeof voice.realtime_active === 'boolean') {
      const enabled = await this.state.storage.get<boolean>('realtime_enabled') ?? false
      const requested = await this.state.storage.get<number>('realtime_requested_at') ?? 0
      if (voice.realtime_active && enabled) await this.syncRealtime(true)
      else if (voice.realtime_active) this.send(socket, frame('settings', { realtime_enabled: false }))
      // Allow telemetry captured just before the start command to drain first.
      else if (Date.now() - requested >= 2000 && await this.state.storage.get<boolean>('realtime_active')) await this.stopRealtime()
    }
    if (value.type === 'status') await this.presence()
  }
  private async chat(socket: WebSocket, v: Frame, board: boolean, locked = false): Promise<void> {
    if (v.protocol !== CHAT_VERSION) return
    if (['begin', 'chunk', 'chunks', 'commit', 'read', 'readAll', 'text.put', 'text.displayed', 'ledger.put', 'ledger.summary'].includes(String(v.op)) && !locked) {
      // Expected upload errors must leave the concurrency gate normally, otherwise the runtime resets the object.
      let failed = false, failure: unknown
      await this.state.blockConcurrencyWhile(async () => {
        try { await this.chat(socket, v, board, true) } catch (error) { failed = true; failure = error }
      })
      if (failed) throw failure
      return
    }
    const a = this.attachment(socket)
    const reply = (op: string, data: Frame = {}): void => {
      const response = frame(op, { req: v.req, ...data })
      this.send(socket, board && a.role === 'browser' ? { type: 'bridge', payload: response } : response)
    }
    const sender = board ? 'board' : a.client!
    const id = v.id
    if (v.op === 'text.displayed') {
      if (board || a.role !== 'browser' || !validId(id)) throw new Error('文字显示回执格式错误')
      const message = this.history.find(m => m.id === id)
      if (message?.kind !== 'text' || message.sender !== 'board') throw new Error('文字消息不存在')
      // A cloud save alone is not a display receipt. Browsers send this only
      // after the chat component has committed the text to its DOM.
      if (await this.state.storage.get<boolean>(`displayed:${id}`) !== true) await this.state.storage.put(`displayed:${id}`, true)
      reply('text.displayed', { id })
      this.toBoard(frame('text.displayed', { id }))
      return
    }
    if (v.op === 'text.put') {
      if (!board || !validId(id) || typeof v.text !== 'string' || !v.text.trim() || v.text.length > CHAT_TEXT_LIMIT ||
        (v.require_display !== undefined && typeof v.require_display !== 'boolean')) throw new Error('转写文字格式错误')
      const items = await this.messages(), existing = items.find(m => m.id === id)
      if (existing) {
        if (existing.kind !== 'text' || existing.text !== v.text.trim()) throw new Error('消息 ID 已占用')
        const displayed = await this.state.storage.get<boolean>(`displayed:${id}`) === true
        reply('text.ack', { id, displayed })
        // Re-deliver retained text when a display receipt was lost or no chat
        // component was mounted for the first broadcast. Keep counts unchanged.
        if (v.require_display === true && !displayed) this.broadcast(frame('message', { message: existing, added: false, display_required: true, ...this.stats() }), true)
        return
      }
      const delivered = await this.state.storage.get<true | 'text'>(`delivered:${id}`)
      if (delivered === 'text') {
        reply('text.ack', { id, displayed: await this.state.storage.get<boolean>(`displayed:${id}`) === true })
        return
      }
      if (delivered) throw new Error('消息 ID 已占用')
      let old: ChatMessage | undefined
      if (items.length >= CHAT_LIMIT) {
        const i = items.findIndex(m => m.sender === 'board' || m.read)
        if (i < 0) throw new Error('群内未读消息已满')
        ;[old] = items.splice(i, 1)
      }
      const m: ChatMessage = { id, sender: 'board', name: '开发板', kind: 'text', text: v.text.trim(), samples: 0,
        created: Math.max(Date.now(), (this.history.at(-1)?.created ?? 0) + 1), read: true }
      items.push(m)
      const remove = old ? [`clip:${old.id}`, ...Array.from({ length: Math.ceil(old.samples / AUDIO_CHUNK) }, (_, i) => `audio:${old!.id}:${i}`)] : []
      await this.saveMessages(items, { [`delivered:${id}`]: 'text' }, remove)
      if (old) this.broadcast(frame('pruned', { ids: [old.id], ...this.stats() }), true)
      reply('text.ack', { id, displayed: false })
      this.broadcast(frame('message', { message: m, added: true, ...this.stats() }), true)
      return
    }
    if (v.op === 'ledger.put') {
      if (!board) throw new Error('只有开发板可以写入记账记录')
      if (!isLedgerEntry(v.record)) throw new Error('记账记录格式错误')
      const input = v.record
      await this.state.storage.transaction(async tx => {
        const previous = await tx.get<number>(`ledger-id:${input.id}`)
        if (previous) return
        const sequence = (await tx.get<number>('ledger-count') ?? 0) + 1
        const record: LedgerRecord = { id: input.id, amount: input.amount, recordedAt: input.recordedAt,
          uptimeMs: input.uptimeMs, receivedAt: Date.now(), sequence }
        await tx.put({ [`ledger:${sequence}`]: record, [`ledger-id:${input.id}`]: sequence, 'ledger-count': sequence })
        if (await tx.get<boolean>('ledger-summary-ready')) {
          const key = input.recordedAt === null ? 'ledger-unknown' : `ledger-day:${ledgerDay(input.recordedAt)}`
          await tx.put(key, (await tx.get<number>(key) ?? 0) + (input.recordedAt === null ? 1 : input.amount))
        }
      })
      reply('ledger.ack', { id: input.id })
      return
    }
    if (v.op === 'ledger.summary' && board) {
      const count = await this.state.storage.get<number>('ledger-count') ?? 0
      if (!(await this.state.storage.get<boolean>('ledger-summary-ready'))) {
        const totals = new Map<string, number>()
        for (let offset = 1; offset <= count; offset += 100) {
          const records = await Promise.all(Array.from({ length: Math.min(100, count - offset + 1) }, (_, i) => this.state.storage.get<LedgerRecord>(`ledger:${offset + i}`)))
          for (const r of records) {
            if (!r) throw new Error('记账历史暂时不可用')
            const key = r.recordedAt === null ? 'ledger-unknown' : `ledger-day:${ledgerDay(r.recordedAt)}`
            totals.set(key, (totals.get(key) ?? 0) + (r.recordedAt === null ? 1 : r.amount))
          }
        }
        // Rebuilding overwrites each bucket, so retries cannot count a record twice.
        const entries = [...totals]
        for (let i = 0; i < entries.length; i += 100) await this.state.storage.put(Object.fromEntries(entries.slice(i, i + 100)))
        await this.state.storage.put('ledger-summary-ready', true)
      }
      const day = ledgerDay(Date.now())
      const totals = await Promise.all([0, 1, 2].map(i => this.state.storage.get<number>(`ledger-day:${day - i}`)))
      const latest = count ? await this.state.storage.get<LedgerRecord>(`ledger:${count}`) : null
      reply('ledger.summary', { day, totals: totals.map(n => n ?? 0), latest: latest?.amount ?? 0,
        unknown: await this.state.storage.get<number>('ledger-unknown') ?? 0 })
      return
    }
    if (v.op === 'ledger.list' && !board) {
      const count = await this.state.storage.get<number>('ledger-count') ?? 0
      const after = v.after ?? 0, through = v.through ?? count
      if (!Number.isSafeInteger(after) || !Number.isSafeInteger(through) || Number(after) < 0 ||
        Number(through) < Number(after) || Number(through) > count) throw new Error('记账记录分页参数错误')
      const next = Math.min(Number(through), Number(after) + 100)
      const records = await Promise.all(Array.from({ length: next - Number(after) }, (_, i) => this.state.storage.get<LedgerRecord>(`ledger:${Number(after) + i + 1}`)))
      if (records.some(r => !r)) throw new Error('记账记录暂时不可用，请稍后重试')
      reply('ledger.list', { records, next, through, complete: next === through })
      return
    }
    if (v.op === 'health.put') {
      if (!board) throw new Error('只有开发板可以写入测量记录')
      if (!isHealthMeasurement(v.record)) throw new Error('测量记录格式错误')
      const input = v.record
      await this.state.blockConcurrencyWhile(async () => {
        const previous = await this.state.storage.get<number>(`health-id:${input.id}`)
        if (!previous) {
          const sequence = (await this.state.storage.get<number>('health-count') ?? 0) + 1
          const record: HealthRecord = { id: input.id, kind: input.kind, value: input.value, measuredAt: input.measuredAt,
            uptimeMs: input.uptimeMs, receivedAt: Date.now(), sequence }
          await this.state.storage.put({ [`health:${sequence}`]: record, [`health-id:${input.id}`]: sequence, 'health-count': sequence })
        }
      })
      reply('health.ack', { id: input.id })
      return
    }
    if (v.op === 'health.list' && !board) {
      const count = await this.state.storage.get<number>('health-count') ?? 0
      const after = v.after ?? 0, through = v.through ?? count
      if (!Number.isSafeInteger(after) || !Number.isSafeInteger(through) || Number(after) < 0 || Number(through) < Number(after) || Number(through) > count) throw new Error('测量记录分页参数错误')
      const next = Math.min(Number(through), Number(after) + 100)
      const records = await Promise.all(Array.from({ length: next - Number(after) }, (_, i) => this.state.storage.get<HealthRecord>(`health:${Number(after) + i + 1}`)))
      if (records.some(r => !r)) throw new Error('测量记录暂时不可用，请稍后重试')
      reply('health.list', { records, next, through, complete: next === through })
      return
    }
    if (v.op === 'ping') { reply('pong', board ? { via: a.role === 'board' ? 'wifi' : 'ble' } : {}); await this.presence(); return }
    if (v.op === 'gateway.off' && !board) { a.last = 0; socket.serializeAttachment(a); await this.presence(); return }
    if (v.op === 'list' && !board) {
      if ((v.before !== undefined && !isChatCursor(v.before)) || (v.through !== undefined && !isChatCursor(v.through))) throw new Error('语音分页参数错误')
      reply('list', this.page(v.before as ChatCursor | undefined, v.through as ChatCursor | undefined) as unknown as Frame)
      return
    }
    if (v.op === 'index' && board) {
      const voices = this.history.filter(isVoiceMessage)
      const offset = v.offset ?? 0
      if (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > CHAT_LIMIT) throw new Error('语音索引参数错误')
      if (v.count === undefined) {
        const m = voices[Number(offset)]
        reply('index', m ? { offset, id: m.id, created: m.created, samples: m.samples, read: m.read } : { offset, end: true })
      } else {
        if (!Number.isInteger(v.count) || Number(v.count) < 1 || Number(v.count) > BOARD_INDEX_PAGE_SIZE) throw new Error('语音索引分页过大')
        if (Number(offset) === 0 && v.ifRevision === this.revision) { reply('index', { unchanged: true, revision: this.revision }); return }
        if (Number(offset) > 0 && v.revision !== this.revision) { reply('index', { restart: true, revision: this.revision }); return }
        const items = voices.slice(Number(offset), Number(offset) + Number(v.count)).map(m => ({ id: m.id, created: m.created, samples: m.samples, read: m.read }))
        const next = Number(offset) + items.length
        reply('index', { items, next, end: next >= voices.length, revision: this.revision })
      }
      return
    }
    if ((v.op === 'pullBatch' || v.op === 'stream') && board === (v.op === 'stream')) {
      if (!validId(id)) return
      const start = Number(v.index), count = v.op === 'stream' ? Math.min(AUDIO_STREAM_WINDOW, Number(v.count) || AUDIO_STREAM_WINDOW) : Math.min(MAX_BATCH, Number(v.count) || MAX_BATCH)
      if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 1) return
      const m = this.history.find(m => m.id === id)
      if (!m || !isVoiceMessage(m)) throw new Error('这条语音不可用')
      const end = Math.min(Math.ceil(m.samples / AUDIO_CHUNK), start + count)
      const clip = await this.state.storage.get<ArrayBuffer>(`clip:${id}`)
      if (v.op === 'pullBatch') {
        const chunks: Array<{ index: number; data: string }> = []
        for (let index = start; index < end; index++) {
          const data = await this.audioChunk(String(id), index, clip)
          if (!data) throw new Error('语音分片不存在')
          chunks.push({ index, data })
        }
        reply('chunks', { id, chunks, next: end, complete: end >= Math.ceil(m.samples / AUDIO_CHUNK) })
      } else {
        for (let index = start; index < end; index++) {
          const data = await this.audioChunk(String(id), index, clip)
          if (!data) throw new Error('语音分片不存在')
          reply('audio', { id, index, data, samples: m.samples })
        }
        reply('streamAck', { id, next: end, complete: end >= Math.ceil(m.samples / AUDIO_CHUNK) })
      }
      return
    }
    if (v.op === 'begin') {
      if (!validId(id) || !Number.isInteger(v.samples) || Number(v.samples) < 1 || Number(v.samples) > AUDIO_LIMIT) throw new Error('语音必须在 20 秒以内')
      const items = await this.messages()
      const existing = items.find((m) => m.id === id)
      if (existing) {
        if (!isVoiceMessage(existing) || existing.sender !== sender) throw new Error('消息 ID 已占用')
        reply('ack', { id, committed: true }); return
      }
      if (board) {
        const delivered = await this.state.storage.get<true | 'text'>(`delivered:${id}`)
        if (delivered === 'text') throw new Error('消息 ID 已占用')
        if (delivered) { reply('ack', { id, committed: true }); return }
      }
      if (items.length >= CHAT_LIMIT && !items.some((m) => m.sender === 'board' || m.read)) throw new Error('已有 5000 条未读留言，请先播放后再发送')
      const key = `upload:${id}`
      let upload = await this.state.storage.get<Upload>(key)
      if (upload && (upload.sender !== sender || upload.samples !== v.samples)) throw new Error('上传信息不一致')
      if (!upload) {
        const pending = await this.state.storage.list<Upload>({ prefix: 'upload:' })
        if ([...pending.values()].filter((u) => u.sender === sender).length >= 2) throw new Error('请先完成上一条语音上传')
        upload = { id, sender, name: board ? '开发板' : a.name!, samples: Number(v.samples), next: 0, created: Date.now() }
        await this.state.storage.put(key, upload)
      }
      upload.updated = Date.now()
      await this.state.storage.put(key, upload)
      reply('ack', { id, next: upload.next }); return
    }
    if (v.op === 'chunk') {
      if (!validId(id) || typeof v.data !== 'string' || v.data.length > AUDIO_CHUNK / 3 * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.data)) throw new Error('语音分片无效')
      const upload = await this.state.storage.get<Upload>(`upload:${id}`)
      if (!upload || upload.sender !== sender) throw new Error('请重新发送语音')
      const index = Number(v.index)
      if (index < upload.next) { reply('ack', { id, next: upload.next }); return }
      const bytes = atob(v.data).length
      const expected = Math.min(AUDIO_CHUNK, upload.samples - index * AUDIO_CHUNK)
      if (index !== upload.next || bytes !== expected || expected < 1) throw new Error('语音分片顺序或长度无效')
      await this.state.storage.put(`audio:${id}:${index}`, v.data)
      upload.next++
      upload.updated = Date.now()
      await this.state.storage.put(`upload:${id}`, upload)
      reply('ack', { id, next: upload.next }); return
    }
    if (v.op === 'chunks') {
      if (!validId(id) || !Array.isArray(v.chunks) || v.chunks.length < 1 || v.chunks.length > MAX_BATCH) throw new Error('语音批次无效')
      const upload = await this.state.storage.get<Upload>(`upload:${id}`)
      if (!upload || upload.sender !== sender) throw new Error('请重新发送语音')
      for (const raw of v.chunks as Frame[]) {
        const index = Number(raw.index), data = raw.data
        if (!Number.isInteger(index) || index !== upload.next || typeof data !== 'string' || data.length > AUDIO_CHUNK / 3 * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('语音批次顺序或内容无效')
        const expected = Math.min(AUDIO_CHUNK, upload.samples - index * AUDIO_CHUNK)
        if (expected < 1 || atob(data).length !== expected) throw new Error('语音批次长度无效')
        await this.state.storage.put(`audio:${id}:${index}`, data)
        upload.next++
      }
      upload.updated = Date.now()
      await this.state.storage.put(`upload:${id}`, upload)
      reply('ack', { id, next: upload.next }); return
    }
    if (v.op === 'commit') {
      if (!validId(id)) return
      const items = await this.messages()
      const existing = items.find(m => m.id === id)
      if (existing && (!isVoiceMessage(existing) || existing.sender !== sender)) throw new Error('消息 ID 已占用')
      if (existing?.sender === sender) { reply('ack', { id, committed: true }); return }
      if (board) {
        const delivered = await this.state.storage.get<true | 'text'>(`delivered:${id}`)
        if (delivered === 'text') throw new Error('消息 ID 已占用')
        if (delivered) { reply('ack', { id, committed: true }); return }
      }
      const upload = await this.state.storage.get<Upload>(`upload:${id}`)
      if (!upload || upload.sender !== sender || upload.next !== Math.ceil(upload.samples / AUDIO_CHUNK)) throw new Error('语音尚未上传完整')
      let old: ChatMessage | undefined
      if (items.length >= CHAT_LIMIT) {
        const expired = items.findIndex(m => m.sender === 'board' || m.read)
        if (expired < 0) throw new Error('群内未读消息已满')
        ;[old] = items.splice(expired, 1)
      }
      const audio = new Uint8Array(upload.samples)
      for (let index = 0; index < upload.next; index++) {
        const data = await this.state.storage.get<string>(`audio:${id}:${index}`)
        if (!data) throw new Error('语音分片不存在')
        audio.set(Uint8Array.from(atob(data), c => c.charCodeAt(0)), index * AUDIO_CHUNK)
      }
      // Keep commit times monotonic so a fixed history cursor excludes later uploads.
      const m: ChatMessage = { id, sender, name: upload.name, samples: upload.samples, created: Math.max(Date.now(), (this.history.at(-1)?.created ?? 0) + 1), read: false }
      items.push(m)
      const remove = [`upload:${id}`, ...Array.from({ length: upload.next }, (_, i) => `audio:${id}:${i}`)]
      if (old) remove.push(`clip:${old.id}`, ...Array.from({ length: Math.ceil(old.samples / AUDIO_CHUNK) }, (_, i) => `audio:${old!.id}:${i}`))
      await this.saveMessages(items, { [`clip:${id}`]: audio.buffer, ...(board ? { [`delivered:${id}`]: true } : {}) }, remove)
      if (old) this.broadcast(frame('pruned', { ids: [old.id], ...this.stats() }), true)
      reply('ack', { id, committed: true })
      this.broadcast(frame('message', { message: m, added: true, ...this.stats() }), true)
      if (sender !== 'board') this.toBoard(frame('item', { id: m.id, created: m.created, samples: m.samples, read: false }))
      return
    }
    if (v.op === 'pull') {
      if (!validId(id) || !Number.isInteger(v.index) || Number(v.index) < 0) return
      const m = this.history.find(m => m.id === id)
      if (!m || Number(v.index) >= Math.ceil(m.samples / AUDIO_CHUNK)) throw new Error('这条语音不可用')
      const data = await this.audioChunk(String(id), Number(v.index))
      if (!data) throw new Error('语音分片不存在')
      reply('audio', { id, index: v.index, data, samples: m.samples }); return
    }
    if (v.op === 'read' && board && validId(id)) {
      const items = await this.messages()
      const m = items.find((m) => m.id === id)
      if (m) { m.read = true; await this.saveMessages(items); this.broadcast(frame('message', { message: m, ...this.stats() }), true) }
      reply('ack', { id }); return
    }
    if (v.op === 'readAll' && board) {
      const items = await this.messages()
      const changed = items.filter((m) => !m.read)
      for (const m of changed) m.read = true
      if (changed.length) {
        await this.saveMessages(items)
        this.broadcast(frame('readAll', this.stats()), true)
      }
      reply('ack', { count: changed.length }); return
    }
    if (v.op === 'realtime.set' && !board) {
      if (typeof v.enabled !== 'boolean') throw new Error('实时麦克风开关必须为布尔值')
      const enabled = v.enabled === true
      if (enabled) {
        if (this.route()?.via !== 'wifi') throw new Error('请先让开发板通过 Wi-Fi 直连语音服务')
        await this.state.storage.put('realtime_enabled', true)
        await this.state.storage.put('realtime_requested_at', Date.now())
        this.broadcast(frame('settings', { realtime_enabled: true }), true)
        this.toBoard(frame('settings', { realtime_enabled: true }))
      } else await this.stopRealtime()
      reply('settings', { realtime_enabled: enabled })
      return
    }
    if (v.op === 'realtime.start' && board) {
      if (a.role !== 'board' || this.route()?.socket !== socket ||
          !(await this.state.storage.get<boolean>('realtime_enabled') ?? false)) throw new Error('实时麦克风未在网页打开，或开发板未通过 Wi-Fi 直连')
      await this.syncRealtime(true)
      reply('ack', { active: true })
      return
    }
    if (v.op === 'realtime.chunk' && board) {
      if (!(await this.state.storage.get<boolean>('realtime_active') ?? false)) return
      if (typeof v.data !== 'string' || v.data.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.data)) return
      this.broadcast(frame('realtime.chunk', { data: v.data }), true)
      return
    }
    if (v.op === 'realtime.stop' && board) {
      if (a.role !== 'board') return
      await this.stopRealtime()
      if (board) reply('ack', { active: false })
      return
    }
  }
  private async deleteChunks(id: string, samples: number): Promise<void> {
    const keys = Array.from({ length: Math.ceil(samples / AUDIO_CHUNK) }, (_, i) => `audio:${id}:${i}`)
    for (let i = 0; i < keys.length; i += 100) await this.state.storage.delete(keys.slice(i, i + 100))
  }
  private async deleteAudio(id: string, samples: number): Promise<void> {
    await this.state.storage.delete(`clip:${id}`)
    await this.deleteChunks(id, samples)
  }
  private async clearHistory(): Promise<number> {
    const messages = await this.messages()
    await this.saveMessages([])
    for (const prefix of ['audio:', 'clip:', 'upload:']) {
      for (;;) {
        const keys = [...(await this.state.storage.list({ prefix, limit: 100 })).keys()]
        if (!keys.length) break
        await this.state.storage.delete(keys)
      }
    }
    for (let i = 0; i < messages.length; i += CHAT_PAGE_SIZE) this.broadcast(frame('pruned', { ids: messages.slice(i, i + CHAT_PAGE_SIZE).map(m => m.id), ...this.stats() }), true)
    return messages.length
  }
  async alarm(): Promise<void> {
    await this.loadHistory()
    const pending = await this.state.storage.list<Upload>({ prefix: 'upload:' })
    for (const [key, upload] of pending) if (Date.now() - (upload.updated ?? upload.created) > 10 * 60 * 1000) {
      if (this.history.some(m => m.id === upload.id)) await this.deleteChunks(upload.id, upload.samples)
      else await this.deleteAudio(upload.id, upload.samples)
      await this.state.storage.delete(key)
    }
    await this.presence()
    if (this.sockets().length || pending.size) await this.state.storage.setAlarm(Date.now() + 5000)
  }
  async webSocketClose(socket?: WebSocket): Promise<void> {
    if (socket) {
      const role = this.attachment(socket).role
      const replacementBoard = this.sockets().some((s) => s !== socket && this.attachment(s).role === 'board')
      if (role === 'board' && !replacementBoard) await this.stopRealtime()
    } else if (!this.route()) {
      await this.stopRealtime()
    }
    await this.presence()
  }
  async webSocketError(socket?: WebSocket): Promise<void> {
    if (socket) {
      const role = this.attachment(socket).role
      const replacementBoard = this.sockets().some((s) => s !== socket && this.attachment(s).role === 'board')
      if (role === 'board' && !replacementBoard) await this.stopRealtime()
    } else if (!this.route()) {
      await this.stopRealtime()
    }
    await this.presence()
  }
}
