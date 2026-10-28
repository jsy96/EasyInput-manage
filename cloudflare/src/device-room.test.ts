import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRoomV2 } from './device-room'
import { CHAT_VERSION, REALTIME_FRAME_SAMPLES, encodeRealtimePacket } from '../../src/shared/chat'
class Socket {
  readyState = 1
  attachment: unknown
  frames: Record<string, unknown>[] = []
  binaryFrames: Uint8Array[] = []
  send(value: string | ArrayBuffer): void {
    if (typeof value === 'string') this.frames.push(JSON.parse(value) as Record<string, unknown>)
    else this.binaryFrames.push(new Uint8Array(value).slice())
  }
  serializeAttachment(a: unknown): void { this.attachment = structuredClone(a) }
  deserializeAttachment(): unknown { return this.attachment }
}
class Store {
  values = new Map<string, unknown>()
  get = vi.fn(async <T>(key: string): Promise<T | undefined> => structuredClone(this.values.get(key)) as T | undefined)
  put = vi.fn(async (key: string, value: unknown) => { this.values.set(key, structuredClone(value)) })
  delete = vi.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key) })
  list = vi.fn(async ({ prefix }: { prefix: string }) => new Map([...this.values].filter(([k]) => k.startsWith(prefix))))
  setAlarm = vi.fn(async () => {})
}
let store: Store, sockets: Socket[], room: DeviceRoomV2
const chat = async (s: Socket, op: string, data: Record<string, unknown> = {}): Promise<void> => room.webSocketMessage(s as unknown as WebSocket, JSON.stringify({ type: 'chat', protocol: CHAT_VERSION, op, req: op, ...data }))
function socket(role = 'browser', client = 'client'): Socket {
  const s = new Socket(); s.serializeAttachment({ role, client, name: client }); sockets.push(s); return s
}
async function upload(s: Socket, id: string): Promise<void> {
  await chat(s, 'begin', { id, samples: 900 })
  await chat(s, 'chunk', { id, index: 0, data: btoa(String.fromCharCode(...new Uint8Array(768).fill(255))) })
  await chat(s, 'chunk', { id, index: 1, data: btoa(String.fromCharCode(...new Uint8Array(132).fill(128))) })
  await chat(s, 'commit', { id })
}
beforeEach(() => {
  store = new Store(); sockets = []
  room = new DeviceRoomV2({ storage: store, getWebSockets: () => sockets, acceptWebSocket: (s: Socket) => sockets.push(s), blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn() } as unknown as DurableObjectState)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('shared voice room', () => {
  it('registers stable identities without per-computer playback slots', async () => {
    vi.stubGlobal('WebSocketPair', class { 0 = new Socket(); 1 = new Socket() })
    vi.stubGlobal('Response', class { status: number; constructor(_body: unknown, init: { status: number }) { this.status = init.status } })
    for (let i = 0; i < 7; i++) {
      await room.fetch(new Request(`https://room.internal/ws?role=browser&client=computer-${i}&name=Computer-${i}`, { headers: { Upgrade: 'websocket' } }))
      expect(sockets.at(-1)?.frames[0]).toMatchObject({ op: 'snapshot', self: { id: `computer-${i}` } })
    }
    await room.fetch(new Request('https://room.internal/ws?role=browser&client=computer-0', { headers: { Upgrade: 'websocket' } }))
    expect(sockets.at(-1)?.frames[0]).toMatchObject({ self: { id: 'computer-0' } })
    expect((store.values.get('clients') as unknown[])).toHaveLength(7)
  })
  it('stores complete audio and broadcasts it to every browser while the board is offline', async () => {
    const one = socket(), two = socket('browser','second')
    await upload(one, 'voice-1')
    expect(one.frames.some(f => f.op === 'message')).toBe(true)
    expect(two.frames.some(f => f.op === 'message')).toBe(true)
    await chat(two, 'pull', { id: 'voice-1', index: 1 })
    expect(atob(String(two.frames.at(-1)?.data))).toHaveLength(132)
    await chat(two, 'ping')
    expect(two.frames.at(-1)).toMatchObject({ op: 'presence', online: false, via: null })
  })
  it('accepts batched browser uploads and serves batched downloads', async () => {
    const browser = socket(), board = socket('board')
    await chat(browser, 'begin', { id: 'batch-audio', samples: 900 })
    await chat(browser, 'chunks', { id: 'batch-audio', chunks: [
      { index: 0, data: btoa('a'.repeat(768)) },
      { index: 1, data: btoa('b'.repeat(132)) },
    ] })
    await chat(browser, 'commit', { id: 'batch-audio' })
    await chat(browser, 'pullBatch', { id: 'batch-audio', index: 0, count: 16 })
    expect(browser.frames.filter(f => f.op === 'chunks').at(-1)).toMatchObject({ next: 2, complete: true })
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'chat', protocol: CHAT_VERSION, op: 'stream', req: 'stream-1', id: 'batch-audio', index: 0, count: 8 }))
    expect(board.frames.filter(f => f.op === 'audio')).toHaveLength(2)
    expect(board.frames.filter(f => f.op === 'streamAck').at(-1)).toMatchObject({ next: 2, complete: true })
  })
  it('marks a played item read without deleting shared timeline audio', async () => {
    const browser = socket(), board = socket('board')
    await upload(browser, 'read-one'); await upload(browser, 'unread-two')
    await chat(board, 'read', { id: 'read-one' })
    const messages = store.values.get('messages') as { id: string; read: boolean }[]
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'read-one', read: true }), expect.objectContaining({ id: 'unread-two', read: false })]))
    expect(store.values.has('audio:read-one:0')).toBe(true)
    expect(store.values.has('audio:unread-two:0')).toBe(true)
    await chat(board, 'index', { offset: 1 })
    expect(board.frames.at(-1)).toMatchObject({ op: 'index', id: 'unread-two', read: false })
  })
  it('marks every unread item read for the board without deleting audio', async () => {
    const browser = socket(), board = socket('board')
    await upload(browser, 'bulk-read-one'); await upload(browser, 'bulk-read-two')
    await chat(board, 'read', { id: 'bulk-read-one' })
    await chat(board, 'readAll')
    const messages = store.values.get('messages') as { id: string; read: boolean }[]
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bulk-read-one', read: true }),
      expect.objectContaining({ id: 'bulk-read-two', read: true }),
    ]))
    expect(store.values.has('audio:bulk-read-one:0')).toBe(true)
    expect(store.values.has('audio:bulk-read-two:0')).toBe(true)
    expect(board.frames.at(-1)).toMatchObject({ op: 'ack', count: 1 })
  })
  it('uses fresh telemetry for presence and prefers direct Wi-Fi over a Bluetooth gateway', async () => {
    const browser = socket(), board = socket('board')
    await chat(browser, 'ping')
    expect(browser.frames.at(-1)).toMatchObject({ online: false })
    await room.webSocketMessage(browser as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'status', protocol: 2, uptime_ms: 1000 } }))
    expect(browser.frames.filter(f => f.op === 'presence').at(-1)).toMatchObject({ online: true, via: 'ble' })
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 1001 }))
    expect(browser.frames.filter(f => f.op === 'presence').at(-1)).toMatchObject({ online: true, via: 'wifi' })
    await chat(browser, 'gateway.off')
    expect(browser.frames.at(-1)).toMatchObject({ online: true, via: 'wifi' })
    board.readyState = 3
    await room.webSocketClose()
    expect(browser.frames.at(-1)).toMatchObject({ online: false, via: null })
  })
  it('relays compact board lights frames to every browser', async () => {
    const board = socket('board'), first = socket(), second = socket('browser', 'second')
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 100 }))
    const lights = { type: 'lights', protocol: 2, uptime_ms: 101, status_led: 'off', modes: ['off', 'solid', 'flash', 'blink', 'off'] }
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify(lights))
    expect(first.frames.at(-1)).toMatchObject(lights)
    expect(second.frames.at(-1)).toMatchObject(lights)
  })
  it('synchronizes board replies to the whole group and accepts retried commits once', async () => {
    const first = socket(), later = socket('browser','sixth'), board = socket('board')
    await upload(board, 'reply')
    await chat(board, 'commit', { id: 'reply' })
    expect((store.values.get('messages') as unknown[])).toHaveLength(1)
    expect(first.frames.find(f => f.op === 'message')).toMatchObject({ message: { sender: 'board' } })
    expect(later.frames.find(f => f.op === 'message')).toMatchObject({ message: { sender: 'board' } })
  })
  it('remembers a committed board recording after history eviction and a lost acknowledgement', async () => {
    const board = socket('board'), browser = socket()
    await upload(board, 'persisted-reply')
    store.values.set('messages', [])
    await chat(board, 'begin', { id: 'persisted-reply', samples: 900 })
    expect(board.frames.at(-1)).toMatchObject({ op: 'ack', committed: true })
    await chat(board, 'commit', { id: 'persisted-reply' })
    expect(store.values.get('messages')).toEqual([])
    expect(browser.frames.filter(f => f.op === 'message')).toHaveLength(1)
  })
  it('confirms the actual cloud transport for a board network announcement', async () => {
    const board = socket('board'), bridge = socket()
    await chat(board, 'ping')
    expect(board.frames.find(f => f.op === 'pong')).toMatchObject({ via: 'wifi' })
    await room.webSocketMessage(bridge as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'status', protocol: 2, uptime_ms: 100 } }))
    await room.webSocketMessage(bridge as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'chat', protocol: CHAT_VERSION, op: 'ping', req: 'probe' } }))
    expect(bridge.frames.find(f => f.type === 'bridge' && (f.payload as Record<string, unknown>).op === 'pong')).toMatchObject({ payload: { op: 'pong', via: 'ble', req: 'probe' } })
  })
  it('keeps a slow upload while chunks progress and expires it only after ten idle minutes', async () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(1_000_000), board = socket('board')
    await chat(board, 'begin', { id: 'slow-reply', samples: 900 })
    time.mockReturnValue(1_000_000 + 9 * 60_000)
    await chat(board, 'chunk', { id: 'slow-reply', index: 0, data: btoa('a'.repeat(768)) })
    time.mockReturnValue(1_000_000 + 18 * 60_000)
    await room.alarm()
    expect(store.values.has('upload:slow-reply')).toBe(true)
    time.mockReturnValue(1_000_000 + 20 * 60_000)
    await room.alarm()
    expect(store.values.has('upload:slow-reply')).toBe(false)
    expect(store.values.has('audio:slow-reply:0')).toBe(false)
  })
  it('returns a failed upload reply through the Bluetooth gateway for retry', async () => {
    const bridge = socket()
    await room.webSocketMessage(bridge as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'status', protocol: 2, uptime_ms: 100 } }))
    await room.webSocketMessage(bridge as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'chat', protocol: CHAT_VERSION, op: 'commit', req: 'commit-try', id: 'not-yet-complete' } }))
    expect(bridge.frames.at(-1)).toMatchObject({ type: 'bridge', payload: { op: 'error', req: 'commit-try' } })
  })
  it('clears chat metadata, audio, and incomplete uploads while preserving delivery receipts', async () => {
    const browser = socket(), board = socket('board')
    await upload(browser, 'clear-one'); await upload(board, 'clear-two')
    await chat(browser, 'begin', { id: 'incomplete', samples: 900 })
    await chat(browser, 'chunk', { id: 'incomplete', index: 0, data: btoa('a'.repeat(768)) })
    store.values.set('realtime_enabled', true)
    const response = await room.fetch(new Request('https://room.internal/admin/clear', { method: 'POST', headers: { 'X-EasyInput-Clear': '1' } }))
    expect(await response.json()).toEqual({ ok: true, cleared: 2 })
    expect(store.values.has('messages')).toBe(false)
    expect([...store.values.keys()].filter((key) => key.startsWith('audio:'))).toEqual([])
    expect([...store.values.keys()].filter((key) => key.startsWith('upload:'))).toEqual([])
    expect(store.values.get('delivered:clear-two')).toBe(true)
    expect(store.values.get('realtime_enabled')).toBe(true)
    expect(browser.frames.filter((frame) => frame.op === 'pruned').at(-1)).toMatchObject({ ids: ['clear-one', 'clear-two'] })
  })
  it('stores the webpage realtime toggle and forwards board audio only to browsers', async () => {
    const browser = socket(), board = socket('board')
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 100 }))
    await chat(browser, 'realtime.set', { enabled: true })
    expect(store.values.get('realtime_enabled')).toBe(true)
    expect(board.frames.at(-1)).toMatchObject({ type: 'chat', op: 'settings', realtime_enabled: true })
    const packet = encodeRealtimePacket(7, Int16Array.from({ length: REALTIME_FRAME_SAMPLES }, (_, index) => index - 160))
    await room.webSocketMessage(board as unknown as WebSocket, packet.buffer as ArrayBuffer)
    expect(browser.binaryFrames).toHaveLength(0)
    await chat(board, 'realtime.start')
    expect(browser.frames.at(-1)).toMatchObject({ op: 'realtime.start' })
    expect(board.frames.at(-1)).toMatchObject({ op: 'ack', active: true })
    await room.webSocketMessage(board as unknown as WebSocket, packet.buffer as ArrayBuffer)
    expect(browser.binaryFrames).toHaveLength(1)
    expect(browser.binaryFrames[0]).toEqual(packet)
    await room.webSocketMessage(browser as unknown as WebSocket, packet.buffer as ArrayBuffer)
    expect(browser.binaryFrames).toHaveLength(1)
    await chat(board, 'realtime.stop')
    expect(browser.frames.at(-1)).toMatchObject({ op: 'realtime.stop' })
  })
  it('clears realtime when the direct board connection disappears behind a live gateway', async () => {
    const browser = socket(), board = socket('board')
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 100 }))
    await chat(browser, 'realtime.set', { enabled: true })
    await chat(board, 'realtime.start')
    await room.webSocketMessage(browser as unknown as WebSocket, JSON.stringify({
      type: 'gateway', payload: { type: 'status', protocol: 2, uptime_ms: 200 },
    }))
    await chat(browser, 'ping')

    board.readyState = 3
    await room.webSocketClose(board as unknown as WebSocket)

    expect(store.values.get('realtime_active')).toBe(false)
    expect(browser.frames.filter((frame) => frame.op === 'realtime.stop')).toHaveLength(1)
    expect(browser.frames.filter((frame) => frame.op === 'presence').at(-1)).toMatchObject({ online: true, via: 'ble' })
  })
  it('reconciles a lost realtime stop from the board heartbeat', async () => {
    const browser = socket(), board = socket('board')
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 100 }))
    store.values.set('realtime_enabled', true)
    await chat(board, 'realtime.start')
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({
      type: 'status', protocol: 2, uptime_ms: 3100, realtime_active: false,
    }))

    expect(store.values.get('realtime_active')).toBe(false)
    expect(browser.frames.filter((frame) => frame.op === 'realtime.stop')).toHaveLength(1)
  })
  it('sends the board the current unique online browser count', async () => {
    store.values.set('clients', [
      { id: 'first', name: 'first' }, { id: 'second', name: 'second' }, { id: 'third', name: 'third' },
    ])
    const board = socket('board'), first = socket('browser', 'first'), second = socket('browser', 'second'), duplicate = socket('browser', 'first')
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 100 }))
    await chat(first, 'ping')
    expect(board.frames.filter(f => f.op === 'audience').at(-1)).toMatchObject({ online_clients: 2 })
    duplicate.readyState = 3
    await chat(second, 'ping')
    expect(board.frames.filter(f => f.op === 'audience').at(-1)).toMatchObject({ online_clients: 2 })
    first.readyState = 3
    second.readyState = 3
    await chat(socket('browser', 'third'), 'ping')
    expect(board.frames.filter(f => f.op === 'audience').at(-1)).toMatchObject({ online_clients: 1 })
  })
})
