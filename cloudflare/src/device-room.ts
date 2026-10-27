import { AUDIO_CHUNK, AUDIO_LIMIT, CHAT_LIMIT, slotForClient, validId } from '../../src/shared/chat'
import type { ChatClient, ChatMessage } from '../../src/shared/chat'

type Attachment = { role: 'board' | 'browser'; client?: string; name?: string; slot?: number; last?: number; uptime?: number }
type Frame = Record<string, unknown>
type Upload = { id: string; sender: string; name: string; slot: number; samples: number; next: number; created: number; updated?: number; text?: string }
const frame = (op: string, data: Frame = {}): Frame => ({ type: 'chat', protocol: 1, op, ...data })

export class DeviceRoom {
  constructor(private readonly state: DurableObjectState) {}
  private sockets(): WebSocket[] { return this.state.getWebSockets().filter((s) => s.readyState === 1) }
  private attachment(s: WebSocket): Attachment { return s.deserializeAttachment() as Attachment }
  private send(s: WebSocket, value: Frame): void { try { s.send(JSON.stringify(value)) } catch { /* close callback cleans presence */ } }
  private broadcast(value: Frame, browsersOnly = false): void {
    for (const s of this.sockets()) if (!browsersOnly || this.attachment(s).role === 'browser') this.send(s, value)
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
  private async messages(): Promise<ChatMessage[]> { return await this.state.storage.get<ChatMessage[]>('messages') ?? [] }
  private async clients(): Promise<ChatClient[]> { return await this.state.storage.get<ChatClient[]>('clients') ?? [] }
  private async presence(): Promise<void> {
    const route = this.route()
    const clients = (await this.clients()).map((c) => ({ ...c, online: this.sockets().some((s) => this.attachment(s).client === c.id) }))
    this.broadcast(frame('presence', { online: !!route, via: route?.via ?? null, clients }), true)
  }
  async fetch(request: Request): Promise<Response> {
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
          self = { id: id!, name: (url.searchParams.get('name') ?? '').trim().slice(0, 24) || `电脑 ${clients.length + 1}`, slot: slotForClient(clients.length) }
          clients.push(self)
          await this.state.storage.put('clients', clients)
        }
      })
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.state.acceptWebSocket(server)
    server.serializeAttachment({ role, client: self?.id, name: self?.name, slot: self?.slot } satisfies Attachment)
    if (role === 'browser') {
      const route = this.route()
      this.send(server, frame('snapshot', { self, messages: await this.messages(), clients: await this.clients(), online: !!route, via: route?.via ?? null }))
      const hello = await this.state.storage.get<Frame>('hello')
      if (hello) this.send(server, hello)
      this.toBoard({ type: 'command', protocol: 2, action: 'hello.get' })
    } else {
      // A socket alone is not proof of board presence; require fresh telemetry.
      this.send(server, { type: 'command', protocol: 2, action: 'hello.get' })
    }
    await this.presence()
    await this.state.storage.setAlarm(Date.now() + 5000)
    return new Response(null, { status: 101, webSocket: client })
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > 65536) return
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
    if (value.protocol !== 2 || !['hello', 'status', 'event', 'result'].includes(String(value.type))) return
    const a = this.attachment(socket)
    if (value.type === 'status' && typeof value.uptime_ms === 'number' && value.uptime_ms !== a.uptime) {
      a.last = Date.now(); a.uptime = value.uptime_ms
      socket.serializeAttachment(a)
    }
    const route = this.route()
    if (value.type === 'hello') await this.state.storage.put('hello', value)
    if (route?.socket === socket || value.type === 'hello') this.broadcast(value, true)
    if (value.type === 'status') await this.presence()
  }
  private async chat(socket: WebSocket, v: Frame, board: boolean): Promise<void> {
    if (v.protocol !== 1) return
    const a = this.attachment(socket)
    const reply = (op: string, data: Frame = {}): void => {
      const response = frame(op, { req: v.req, ...data })
      this.send(socket, board && a.role === 'browser' ? { type: 'bridge', payload: response } : response)
    }
    const sender = board ? 'board' : a.client!
    const id = v.id
    if (v.op === 'ping') { reply('pong', board ? { via: a.role === 'board' ? 'wifi' : 'ble' } : {}); await this.presence(); return }
    if (v.op === 'gateway.off' && !board) { a.last = 0; socket.serializeAttachment(a); await this.presence(); return }
    if (v.op === 'index' && board) {
      const items = (await this.messages()).filter((m) => m.sender !== 'board')
      const offset = Number(v.offset) || 0
      const m = items[offset]
      reply('index', m ? { offset, id: m.id, slot: m.slot, samples: m.samples, read: m.read, cleared: m.cleared } : { offset, end: true })
      return
    }
    if (v.op === 'begin') {
      if (!validId(id) || !Number.isInteger(v.samples) || Number(v.samples) < 1 || Number(v.samples) > AUDIO_LIMIT) throw new Error('语音必须在 1 分钟以内')
      const items = await this.messages()
      const existing = items.find((m) => m.id === id)
      if (existing) {
        if (existing.sender !== sender) throw new Error('消息 ID 已占用')
        reply('ack', { id, committed: true }); return
      }
      if (board && await this.state.storage.get(`delivered:${id}`)) { reply('ack', { id, committed: true }); return }
      if (items.length >= CHAT_LIMIT && !items.some((m) => m.sender === 'board' || m.read)) throw new Error('已有 100 条未读留言，请先播放后再发送')
      const key = `upload:${id}`
      let upload = await this.state.storage.get<Upload>(key)
      if (upload && (upload.sender !== sender || upload.samples !== v.samples)) throw new Error('上传信息不一致')
      if (!upload) {
        const pending = await this.state.storage.list<Upload>({ prefix: 'upload:' })
        if ([...pending.values()].filter((u) => u.sender === sender).length >= 2) throw new Error('请先完成上一条语音上传')
        upload = { id, sender, name: board ? '开发板' : a.name!, slot: board ? -1 : a.slot!, samples: Number(v.samples), next: 0, created: Date.now(), text: typeof v.text === 'string' ? v.text.slice(0, 300) : undefined }
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
    if (v.op === 'commit') {
      if (!validId(id)) return
      const items = await this.messages()
      const existing = items.find((m) => m.id === id)
      if (existing?.sender === sender) { reply('ack', { id, committed: true }); return }
      if (board && await this.state.storage.get(`delivered:${id}`)) { reply('ack', { id, committed: true }); return }
      const upload = await this.state.storage.get<Upload>(`upload:${id}`)
      if (!upload || upload.sender !== sender || upload.next !== Math.ceil(upload.samples / AUDIO_CHUNK)) throw new Error('语音尚未上传完整')
      if (items.length >= CHAT_LIMIT) {
        const expired = items.findIndex((m) => m.sender === 'board' || m.read)
        if (expired < 0) throw new Error('群内未读消息已满')
        const [old] = items.splice(expired, 1)
        await this.deleteAudio(old.id, old.samples)
        this.broadcast(frame('pruned', { ids: [old.id] }), true)
      }
      const m: ChatMessage = { id, sender, name: upload.name, slot: upload.slot, samples: upload.samples, created: Date.now(), text: upload.text, read: false, cleared: false }
      items.push(m)
      await this.state.storage.put('messages', items)
      // Keep a small receipt after audio/history eviction so a rebooted board can
      // retry a lost commit acknowledgement without posting the same recording twice.
      if (board) await this.state.storage.put(`delivered:${id}`, true)
      await this.state.storage.delete(`upload:${id}`)
      reply('ack', { id, committed: true })
      this.broadcast(frame('message', { message: m }), true)
      if (sender !== 'board') this.toBoard(frame('item', { id, slot: m.slot, samples: m.samples, read: false, cleared: false }))
      return
    }
    if (v.op === 'pull') {
      if (!validId(id) || !Number.isInteger(v.index) || Number(v.index) < 0) return
      const m = (await this.messages()).find((m) => m.id === id)
      if (!m || m.cleared || Number(v.index) >= Math.ceil(m.samples / AUDIO_CHUNK)) throw new Error('这条语音已清除或不可用')
      const data = await this.state.storage.get<string>(`audio:${id}:${v.index}`)
      if (!data) throw new Error('语音分片不存在')
      reply('audio', { id, index: v.index, data, samples: m.samples }); return
    }
    if (v.op === 'read' && board && validId(id)) {
      const items = await this.messages()
      const m = items.find((m) => m.id === id && m.sender !== 'board')
      if (m && !m.cleared) { m.read = true; await this.state.storage.put('messages', items); this.broadcast(frame('message', { message: m }), true) }
      reply('ack', { id }); return
    }
    if (v.op === 'clear' && board && Number.isInteger(v.slot) && Number(v.slot) >= 0 && Number(v.slot) < 5) {
      const items = await this.messages()
      const cleared = items.filter((m) => m.sender !== 'board' && m.slot === v.slot && m.read && !m.cleared)
      for (const m of cleared) { m.cleared = true; await this.deleteAudio(m.id, m.samples) }
      await this.state.storage.put('messages', items)
      this.broadcast(frame('cleared', { ids: cleared.map((m) => m.id) }), true)
      reply('cleared', { slot: v.slot, ids: cleared.map((m) => m.id) }); return
    }
  }
  private async deleteAudio(id: string, samples: number): Promise<void> {
    const keys = Array.from({ length: Math.ceil(samples / AUDIO_CHUNK) }, (_, i) => `audio:${id}:${i}`)
    for (let i = 0; i < keys.length; i += 100) await this.state.storage.delete(keys.slice(i, i + 100))
  }
  async alarm(): Promise<void> {
    const pending = await this.state.storage.list<Upload>({ prefix: 'upload:' })
    for (const [key, upload] of pending) if (Date.now() - (upload.updated ?? upload.created) > 10 * 60 * 1000) {
      await this.deleteAudio(upload.id, upload.samples)
      await this.state.storage.delete(key)
    }
    await this.presence()
    if (this.sockets().length || pending.size) await this.state.storage.setAlarm(Date.now() + 5000)
  }
  async webSocketClose(): Promise<void> { await this.presence() }
  async webSocketError(): Promise<void> { await this.presence() }
}
