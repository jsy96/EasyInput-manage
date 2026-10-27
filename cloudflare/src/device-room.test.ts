import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRoom } from './device-room'
class Socket {
  readyState = 1
  attachment: unknown
  frames: Record<string, unknown>[] = []
  send(s: string): void { this.frames.push(JSON.parse(s) as Record<string, unknown>) }
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
let store: Store, sockets: Socket[], room: DeviceRoom
const chat = async (s: Socket, op: string, data: Record<string, unknown> = {}): Promise<void> => room.webSocketMessage(s as unknown as WebSocket, JSON.stringify({ type: 'chat', protocol: 1, op, req: op, ...data }))
function socket(role = 'browser', client = 'client', slot = 0): Socket {
  const s = new Socket(); s.serializeAttachment({ role, client, name: client, slot }); sockets.push(s); return s
}
async function upload(s: Socket, id: string): Promise<void> {
  await chat(s, 'begin', { id, samples: 900 })
  await chat(s, 'chunk', { id, index: 0, data: btoa(String.fromCharCode(...new Uint8Array(768).fill(255))) })
  await chat(s, 'chunk', { id, index: 1, data: btoa(String.fromCharCode(...new Uint8Array(132).fill(128))) })
  await chat(s, 'commit', { id })
}
beforeEach(() => {
  store = new Store(); sockets = []
  room = new DeviceRoom({ storage: store, getWebSockets: () => sockets, acceptWebSocket: (s: Socket) => sockets.push(s), blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn() } as unknown as DurableObjectState)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('shared voice room', () => {
  it('registers stable identities and assigns sixth and later computers to the S8 group', async () => {
    vi.stubGlobal('WebSocketPair', class { 0 = new Socket(); 1 = new Socket() })
    vi.stubGlobal('Response', class { status: number; constructor(_body: unknown, init: { status: number }) { this.status = init.status } })
    for (let i = 0; i < 7; i++) {
      await room.fetch(new Request(`https://room.internal/ws?role=browser&client=computer-${i}&name=Computer-${i}`, { headers: { Upgrade: 'websocket' } }))
      expect(sockets.at(-1)?.frames[0]).toMatchObject({ op: 'snapshot', self: { id: `computer-${i}`, slot: Math.min(4, i) } })
    }
    await room.fetch(new Request('https://room.internal/ws?role=browser&client=computer-0', { headers: { Upgrade: 'websocket' } }))
    expect(sockets.at(-1)?.frames[0]).toMatchObject({ self: { slot: 0 } })
    expect((store.values.get('clients') as unknown[])).toHaveLength(7)
  })
  it('stores complete audio and broadcasts it to every browser while the board is offline', async () => {
    const one = socket(), two = socket('browser','second',1)
    await upload(one, 'voice-1')
    expect(one.frames.some(f => f.op === 'message')).toBe(true)
    expect(two.frames.some(f => f.op === 'message')).toBe(true)
    await chat(two, 'pull', { id: 'voice-1', index: 1 })
    expect(atob(String(two.frames.at(-1)?.data))).toHaveLength(132)
    await chat(two, 'ping')
    expect(two.frames.at(-1)).toMatchObject({ op: 'presence', online: false, via: null })
  })
  it('only clears messages already played by the board and retains pending messages', async () => {
    const browser = socket(), board = socket('board')
    await upload(browser, 'read-one'); await upload(browser, 'unread-two')
    await chat(board, 'read', { id: 'read-one' })
    await chat(board, 'clear', { slot: 0 })
    const messages = store.values.get('messages') as { id: string; read: boolean; cleared: boolean }[]
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'read-one', read: true, cleared: true }), expect.objectContaining({ id: 'unread-two', read: false, cleared: false })]))
    expect(store.values.has('audio:read-one:0')).toBe(false)
    expect(store.values.has('audio:unread-two:0')).toBe(true)
    await chat(board, 'index', { offset: 1 })
    expect(board.frames.at(-1)).toMatchObject({ op: 'index', id: 'unread-two', read: false })
  })
  it('uses fresh telemetry for presence and prefers direct Wi-Fi over a Bluetooth gateway', async () => {
    const browser = socket(), board = socket('board')
    await chat(browser, 'ping')
    expect(browser.frames.at(-1)).toMatchObject({ online: false })
    await room.webSocketMessage(browser as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'status', protocol: 2, uptime_ms: 1000 } }))
    expect(browser.frames.at(-1)).toMatchObject({ online: true, via: 'ble' })
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 1001 }))
    expect(browser.frames.at(-1)).toMatchObject({ online: true, via: 'wifi' })
    await chat(browser, 'gateway.off')
    expect(browser.frames.at(-1)).toMatchObject({ online: true, via: 'wifi' })
    board.readyState = 3
    await room.webSocketClose()
    expect(browser.frames.at(-1)).toMatchObject({ online: false, via: null })
  })
  it('synchronizes board replies to the whole group and accepts retried commits once', async () => {
    const first = socket(), later = socket('browser','sixth',4), board = socket('board')
    await upload(board, 'reply')
    await chat(board, 'commit', { id: 'reply' })
    expect((store.values.get('messages') as unknown[])).toHaveLength(1)
    expect(first.frames.find(f => f.op === 'message')).toMatchObject({ message: { sender: 'board', slot: -1 } })
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
    await room.webSocketMessage(bridge as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'chat', protocol: 1, op: 'ping', req: 'probe' } }))
    expect(bridge.frames.find(f => f.type === 'bridge')).toMatchObject({ payload: { op: 'pong', via: 'ble', req: 'probe' } })
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
    await room.webSocketMessage(bridge as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'chat', protocol: 1, op: 'commit', req: 'commit-try', id: 'not-yet-complete' } }))
    expect(bridge.frames.at(-1)).toMatchObject({ type: 'bridge', payload: { op: 'error', req: 'commit-try' } })
  })
})
