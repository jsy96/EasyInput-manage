import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRoomV2 } from './device-room'
import { CHAT_VERSION, CHAT_LIMIT, CHAT_PAGE_SIZE, REALTIME_FRAME_SAMPLES, encodeRealtimePacket } from '../../src/shared/chat'
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
  put = vi.fn(async (key: string | Record<string, unknown>, value?: unknown) => {
    if (typeof key === 'string') this.values.set(key, structuredClone(value))
    else for (const [name, item] of Object.entries(key)) this.values.set(name, structuredClone(item))
  })
  delete = vi.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key) })
  list = vi.fn(async ({ prefix, limit = 10000, startAfter }: { prefix: string; limit?: number; startAfter?: string }) => new Map([...this.values].filter(([k]) => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)))
  transaction = vi.fn(async <T>(fn: (tx: Store) => Promise<T>): Promise<T> => {
    const previous = structuredClone(this.values)
    try { return await fn(this) } catch (e) { this.values = previous; throw e }
  })
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
  const entry = { id: 'd'.repeat(32), amount: 273, recordedAt: null, uptimeMs: 12345 }
  it('persists ledger entries, deduplicates retries after restart and retains repeated amounts as distinct records', async () => {
    const board = socket('board'), browser = socket()
    await chat(board, 'ledger.put', { record: entry })
    await chat(board, 'ledger.put', { record: entry })
    expect(board.frames.at(-1)).toMatchObject({ op: 'ledger.ack', id: entry.id })
    expect(store.values.get('ledger-count')).toBe(1)
    room = new DeviceRoomV2({ storage: store, getWebSockets: () => sockets, blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn() } as unknown as DurableObjectState)
    await chat(board, 'ledger.put', { record: { ...entry, id: 'e'.repeat(32) } })
    await chat(browser, 'ledger.list')
    expect(browser.frames.at(-1)).toMatchObject({ next: 2, through: 2, complete: true, records: [{ ...entry, sequence: 1 }, { ...entry, id: 'e'.repeat(32), sequence: 2 }] })
  })
  it('does not acknowledge a ledger save when storage fails', async () => {
    const board = socket('board')
    store.values.set('voice-revision', 0)
    store.put.mockRejectedValueOnce(new Error('Synthetic storage failure'))
    await chat(board, 'ledger.put', { record: entry })
    expect(board.frames.at(-1)?.op).toBe('error')
    expect(store.values.has('ledger-count')).toBe(false)
    await chat(board, 'ledger.put', { record: entry })
    expect(board.frames.at(-1)?.op).toBe('ledger.ack')
    expect(store.values.get('ledger-count')).toBe(1)
  })
  it('validates ledger amounts and export cursors', async () => {
    const board = socket('board'), browser = socket()
    for (const amount of [0, 1000, 2.5]) {
      await chat(board, 'ledger.put', { record: { ...entry, amount } })
      expect(board.frames.at(-1)?.op).toBe('error')
    }
    await chat(browser, 'ledger.put', { record: entry })
    expect(browser.frames.at(-1)?.op).toBe('error')
    await chat(browser, 'ledger.list', { after: -1 })
    expect(browser.frames.at(-1)?.op).toBe('error')
    expect(store.values.has('ledger-count')).toBe(false)
  })
  it('exports ledger history with a stable upper bound and bridges Bluetooth saves and pending counts', async () => {
    const browser = socket(), board = socket('board')
    for (let i = 1; i <= 105; i++) await chat(board, 'ledger.put', { record: { ...entry, id: i.toString(16).padStart(32, '0') } })
    await chat(browser, 'ledger.list')
    expect(browser.frames.at(-1)).toMatchObject({ through: 105, next: 100, complete: false })
    expect(browser.frames.at(-1)?.records).toHaveLength(100)
    await chat(board, 'ledger.put', { record: entry })
    await chat(browser, 'ledger.list', { after: 100, through: 105 })
    expect(browser.frames.at(-1)?.records).toHaveLength(5)
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 100, ledger_pending: 3 }))
    expect(browser.frames.filter(f => f.op === 'presence').at(-1)).toMatchObject({ ledgerPending: 3 })
    board.readyState = 3
    await room.webSocketMessage(browser as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'status', protocol: 2, uptime_ms: 101, voice: { ledger_pending: 2 } } }))
    expect(browser.frames.filter(f => f.op === 'presence').at(-1)).toMatchObject({ ledgerPending: 2, via: 'ble' })
    await room.webSocketMessage(browser as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'chat', protocol: 2, op: 'ledger.put', req: 'ledger-1', record: entry } }))
    expect(browser.frames.at(-1)).toMatchObject({ type: 'bridge', payload: { op: 'ledger.ack', id: entry.id, req: 'ledger-1' } })
    await chat(browser, 'gateway.off')
    expect(browser.frames.filter(f => f.op === 'presence').at(-1)).toMatchObject({ ledgerPending: null, online: false })
  })
  const measurement = { id: 'a'.repeat(32), kind: 'father_glucose', value: 75, measuredAt: null, uptimeMs: 12345 }
  const synthetic = (n: number, read = false) => ({ id: `synthetic-${String(n).padStart(5, '0')}`, sender: 'client', name: 'Synthetic test', samples: 900, created: 1000 + n, read })
  function seed(count: number, read = false): void {
    store.values.set('voice-revision', 0)
    for (let i = 0; i < count; i++) { const m = synthetic(i, read); store.values.set(`voice-message:${m.id}`, m) }
  }
  it('migrates legacy metadata atomically without losing existing audio or unrelated data', async () => {
    store.values.set('messages', [synthetic(0)])
    store.values.set('audio:synthetic-00000:0', btoa('a'.repeat(768)))
    store.values.set('audio:synthetic-00000:1', btoa('b'.repeat(132)))
    store.values.set('health-count', 12)
    store.values.set('delivered:old', true)
    const browser = socket()
    await chat(browser, 'list')
    expect(browser.frames.at(-1)).toMatchObject({ messages: [synthetic(0)], total: 1, next: null })
    expect(store.values.has('messages')).toBe(false)
    await chat(browser, 'pullBatch', { id: synthetic(0).id, index: 0, count: 2 })
    expect((browser.frames.at(-1)?.chunks as { data: string }[]).map(c => atob(c.data).length)).toEqual([768, 132])
    expect(store.values.get('health-count')).toBe(12)
    expect(store.values.get('delivered:old')).toBe(true)
  })
  it('loads 5000 stored messages in bounded storage pages and exports all with stable cursors', async () => {
    seed(CHAT_LIMIT)
    const browser = socket()
    let before: unknown, through: unknown, ids: string[] = []
    do {
      await chat(browser, 'list', { ...(before ? { before } : {}), ...(through ? { through } : {}) })
      const page = browser.frames.at(-1)!
      expect(page.total).toBe(CHAT_LIMIT)
      const messages = page.messages as { id: string }[]
      expect(messages.length).toBeLessThanOrEqual(CHAT_PAGE_SIZE)
      expect(JSON.stringify(page).length).toBeLessThan(131072)
      ids.push(...messages.map(m => m.id))
      before = page.next; through = page.through
    } while (before)
    expect(new Set(ids).size).toBe(CHAT_LIMIT)
    expect(store.list.mock.calls.filter(([options]) => options.prefix === 'voice-message:')).toHaveLength(6)
    expect(store.put).not.toHaveBeenCalled()
  })
  it('sends only the newest 50 messages in the browser snapshot with whole-room totals', async () => {
    seed(5000)
    vi.stubGlobal('WebSocketPair', class { 0 = new Socket(); 1 = new Socket() })
    vi.stubGlobal('Response', class { constructor(_body: unknown, _init: unknown) {} })
    await room.fetch(new Request('https://room.internal/ws?role=browser&client=synthetic-browser', { headers: { Upgrade: 'websocket' } }))
    const snapshot = sockets.at(-1)!.frames[0]
    expect(snapshot).toMatchObject({ total: 5000, unread: 5000, messages: expect.any(Array), next: { id: synthetic(4950).id } })
    expect(snapshot.messages).toHaveLength(50)
  })
  it('retains 5000 and evicts the oldest eligible item while preserving unread browser messages', async () => {
    seed(5000)
    store.values.set(`voice-message:${synthetic(1).id}`, synthetic(1, true))
    const browser = socket()
    await upload(browser, 'new-retained-voice')
    expect(browser.frames.filter(f => f.op === 'message').at(-1)).toMatchObject({ total: 5000, added: true })
    expect(store.values.has(`voice-message:${synthetic(0).id}`)).toBe(true)
    expect(store.values.has(`voice-message:${synthetic(1).id}`)).toBe(false)
    expect([...store.values.keys()].filter(k => k.startsWith('voice-message:'))).toHaveLength(5000)
  })
  it('rejects a new upload when all 5000 browser messages are unread', async () => {
    seed(5000)
    const browser = socket()
    await chat(browser, 'begin', { id: 'one-too-many', samples: 900 })
    expect(browser.frames.at(-1)).toMatchObject({ op: 'error', message: expect.stringContaining('5000') })
    expect(store.values.has('upload:one-too-many')).toBe(false)
  })
  it('serves eight-item board pages, skips unchanged indexes and restarts on concurrent changes', async () => {
    seed(10)
    const board = socket('board'), browser = socket()
    await chat(board, 'index', { offset: 0, count: 8 })
    expect(board.frames.at(-1)).toMatchObject({ next: 8, end: false, revision: 0 })
    expect(board.frames.at(-1)?.items).toHaveLength(8)
    expect(JSON.stringify(board.frames.at(-1)).length).toBeLessThan(2048)
    await chat(board, 'index', { offset: 8, count: 8, revision: 0 })
    expect(board.frames.at(-1)).toMatchObject({ next: 10, end: true })
    await chat(board, 'index', { offset: 0, count: 8, ifRevision: 0 })
    expect(board.frames.at(-1)).toMatchObject({ unchanged: true })
    await upload(browser, 'concurrent-new-voice')
    await chat(board, 'index', { offset: 8, count: 8, revision: 0 })
    expect(board.frames.at(-1)).toMatchObject({ restart: true, revision: 1 })
  })
  it('stores committed audio in one binary value and serves it after a room restart', async () => {
    const browser = socket()
    await upload(browser, 'binary-voice')
    expect(store.values.get('clip:binary-voice')).toBeInstanceOf(ArrayBuffer)
    expect([...store.values.keys()].filter(k => k.startsWith('audio:binary-voice:'))).toEqual([])
    room = new DeviceRoomV2({ storage: store, getWebSockets: () => sockets, blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn() } as unknown as DurableObjectState)
    await chat(browser, 'pullBatch', { id: 'binary-voice', index: 0, count: 2 })
    expect((browser.frames.at(-1)?.chunks as { data: string }[]).map(c => atob(c.data).length)).toEqual([768, 132])
  })
  it('excludes new messages from an export that fixed its upper cursor', async () => {
    seed(52)
    const browser = socket()
    await chat(browser, 'list')
    const first = browser.frames.at(-1)!
    await upload(browser, 'arrived-during-export')
    await chat(browser, 'list', { before: first.next, through: first.through })
    expect(browser.frames.at(-1)).toMatchObject({ total: 52, messages: [synthetic(0), synthetic(1)], next: null, through: first.through })
  })
  it('rolls back a failed metadata migration and succeeds without losing the legacy array', async () => {
    store.values.set('messages', [synthetic(0)])
    store.put.mockRejectedValueOnce(new Error('Synthetic storage failure'))
    const browser = socket()
    await expect(chat(browser, 'list')).rejects.toThrow('Synthetic storage failure')
    expect(store.values.get('messages')).toEqual([synthetic(0)])
    expect(store.values.has('voice-revision')).toBe(false)
    await chat(browser, 'list')
    expect(browser.frames.at(-1)?.messages).toEqual([synthetic(0)])
  })
  it('preserves the retained history and upload when the binary commit cannot be stored', async () => {
    seed(5000, true)
    const browser = socket()
    await chat(browser, 'begin', { id: 'failed-commit', samples: 1 })
    await chat(browser, 'chunk', { id: 'failed-commit', index: 0, data: btoa('a') })
    store.transaction.mockImplementationOnce(async () => { throw new Error('Synthetic commit failure') })
    await chat(browser, 'commit', { id: 'failed-commit' })
    expect(browser.frames.at(-1)).toMatchObject({ op: 'error' })
    expect(store.values.has(`voice-message:${synthetic(0).id}`)).toBe(true)
    expect(store.values.has('upload:failed-commit')).toBe(true)
    expect(store.values.has('clip:failed-commit')).toBe(false)
    await chat(browser, 'commit', { id: 'failed-commit' })
    expect(browser.frames.filter(f => f.op === 'message').at(-1)).toMatchObject({ total: 5000 })
  })
  it('preserves committed audio if an old incomplete-upload marker is encountered by cleanup', async () => {
    const browser = socket()
    await upload(browser, 'committed-voice')
    store.values.set('upload:committed-voice', { id: 'committed-voice', samples: 900, sender: 'client', created: 1, updated: 1 })
    await room.alarm()
    expect(store.values.has('clip:committed-voice')).toBe(true)
    expect(store.values.has('upload:committed-voice')).toBe(false)
  })
  it('commits and reads the maximum 20-second clip with the exact final remainder', async () => {
    const browser = socket(), samples = 160000
    const chunks = Array.from({ length: Math.ceil(samples / 768) }, (_, index) => ({ index, data: btoa(String.fromCharCode(128 + index % 64).repeat(Math.min(768, samples - index * 768))) }))
    await chat(browser, 'begin', { id: 'max-duration', samples })
    for (let i = 0; i < chunks.length; i += 16) await chat(browser, 'chunks', { id: 'max-duration', chunks: chunks.slice(i, i + 16) })
    await chat(browser, 'commit', { id: 'max-duration' })
    expect((store.values.get('clip:max-duration') as ArrayBuffer).byteLength).toBe(samples)
    await chat(browser, 'pullBatch', { id: 'max-duration', index: 208, count: 16 })
    expect(browser.frames.at(-1)).toMatchObject({ complete: true, next: 209, chunks: [{ index: 208, data: chunks[208].data }] })
    expect(atob(chunks[208].data)).toHaveLength(256)
  })
  it('persists each measurement once after a lost acknowledgement and across room restarts', async () => {
    const board = socket('board'), browser = socket()
    await chat(board, 'health.put', { record: measurement })
    await chat(board, 'health.put', { record: measurement })
    expect(board.frames.at(-1)).toMatchObject({ op: 'health.ack', id: measurement.id })
    expect(store.values.get('health-count')).toBe(1)
    room = new DeviceRoomV2({ storage: store, getWebSockets: () => sockets, blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn() } as unknown as DurableObjectState)
    await chat(browser, 'health.list')
    expect(browser.frames.at(-1)).toMatchObject({ records: [{ ...measurement, sequence: 1 }], through: 1, next: 1, complete: true })
    await chat(board, 'health.put', { record: { ...measurement, id: 'b'.repeat(32) } })
    expect(store.values.get('health-count')).toBe(2)
  })
  it('rejects browser writes, invalid values and invalid cursors', async () => {
    const board = socket('board'), browser = socket()
    await chat(browser, 'health.put', { record: measurement })
    expect(browser.frames.at(-1)?.op).toBe('error')
    for (const record of [{ ...measurement, value: 201 }, { ...measurement, kind: 'unknown' }, { ...measurement, measuredAt: -1 }, { ...measurement, uptimeMs: 0.5 }]) {
      await chat(board, 'health.put', { record }); expect(board.frames.at(-1)?.op).toBe('error')
    }
    await chat(browser, 'health.list', { after: -1 })
    expect(browser.frames.at(-1)?.op).toBe('error')
    expect(store.values.has('health-count')).toBe(false)
  })
  it('pages the full history with a fixed upper bound while new measurements arrive', async () => {
    const browser = socket(), board = socket('board')
    for (let i = 1; i <= 105; i++) await chat(board, 'health.put', { record: { ...measurement, id: i.toString(16).padStart(32, '0') } })
    await chat(browser, 'health.list')
    expect((browser.frames.at(-1)?.records as unknown[]).length).toBe(100)
    expect(browser.frames.at(-1)).toMatchObject({ through: 105, next: 100, complete: false })
    await chat(board, 'health.put', { record: { ...measurement, id: 'f'.repeat(32) } })
    await chat(browser, 'health.list', { after: 100, through: 105 })
    expect((browser.frames.at(-1)?.records as unknown[]).length).toBe(5)
    expect(browser.frames.at(-1)).toMatchObject({ through: 105, next: 105, complete: true })
  })
  it('stores Bluetooth gateway measurements and sends acknowledgements back through the bridge', async () => {
    const bridge = socket()
    await room.webSocketMessage(bridge as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'status', protocol: 2, uptime_ms: 100 } }))
    await room.webSocketMessage(bridge as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'chat', protocol: 2, op: 'health.put', req: 'health-1', record: measurement } }))
    expect(bridge.frames.at(-1)).toMatchObject({ type: 'bridge', payload: { op: 'health.ack', id: measurement.id, req: 'health-1' } })
    expect(store.values.get('health-count')).toBe(1)
  })
  it('reports pending measurements from compact Wi-Fi and full gateway status, clearing the count when offline', async () => {
    const browser = socket(), board = socket('board')
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 100, health_pending: 3 }))
    expect(browser.frames.filter(f => f.op === 'presence').at(-1)).toMatchObject({ healthPending: 3 })
    board.readyState = 3
    await room.webSocketMessage(browser as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'status', protocol: 2, uptime_ms: 101, voice: { health_pending: 2 } } }))
    expect(browser.frames.filter(f => f.op === 'presence').at(-1)).toMatchObject({ via: 'ble', healthPending: 2 })
    await chat(browser, 'gateway.off')
    expect(browser.frames.filter(f => f.op === 'presence').at(-1)).toMatchObject({ online: false, healthPending: null })
  })
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
  it('accepts batched browser uploads and serves twenty-four-chunk board windows', async () => {
    const browser = socket(), board = socket('board')
    const chunks = Array.from({ length: 25 }, (_, index) => ({
      index,
      data: btoa((index === 24 ? 'z' : 'a').repeat(index === 24 ? 1 : 768)),
    }))
    await chat(browser, 'begin', { id: 'batch-audio', samples: 768 * 24 + 1 })
    await chat(browser, 'chunks', { id: 'batch-audio', chunks })
    await chat(browser, 'commit', { id: 'batch-audio' })
    await chat(browser, 'pullBatch', { id: 'batch-audio', index: 0, count: 32 })
    expect(browser.frames.filter(f => f.op === 'chunks').at(-1)).toMatchObject({ next: 25, complete: true })
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'chat', protocol: CHAT_VERSION, op: 'stream', req: 'stream-1', id: 'batch-audio', index: 0, count: 24 }))
    expect(board.frames.filter(f => f.op === 'audio')).toHaveLength(24)
    expect(board.frames.filter(f => f.op === 'streamAck').at(-1)).toMatchObject({ next: 24, complete: false })
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'chat', protocol: CHAT_VERSION, op: 'stream', req: 'stream-2', id: 'batch-audio', index: 24, count: 24 }))
    expect(board.frames.filter(f => f.op === 'audio')).toHaveLength(25)
    expect(board.frames.filter(f => f.op === 'streamAck').at(-1)).toMatchObject({ next: 25, complete: true })
  })
  it('marks a played item read without deleting shared timeline audio', async () => {
    const browser = socket(), board = socket('board')
    await upload(browser, 'read-one'); await upload(browser, 'unread-two')
    await chat(board, 'read', { id: 'read-one' })
    const messages = [...store.values.entries()].filter(([key]) => key.startsWith('voice-message:')).map(([, value]) => value) as { id: string; read: boolean }[]
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'read-one', read: true }), expect.objectContaining({ id: 'unread-two', read: false })]))
    expect(store.values.has('clip:read-one')).toBe(true)
    expect(store.values.has('clip:unread-two')).toBe(true)
    await chat(board, 'index', { offset: 1 })
    expect(board.frames.at(-1)).toMatchObject({ op: 'index', id: 'unread-two', read: false })
  })
  it('marks every unread item read for the board without deleting audio', async () => {
    const browser = socket(), board = socket('board')
    await upload(browser, 'bulk-read-one'); await upload(browser, 'bulk-read-two')
    await chat(board, 'read', { id: 'bulk-read-one' })
    await chat(board, 'readAll')
    const messages = [...store.values.entries()].filter(([key]) => key.startsWith('voice-message:')).map(([, value]) => value) as { id: string; read: boolean }[]
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bulk-read-one', read: true }),
      expect.objectContaining({ id: 'bulk-read-two', read: true }),
    ]))
    expect(store.values.has('clip:bulk-read-one')).toBe(true)
    expect(store.values.has('clip:bulk-read-two')).toBe(true)
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
    expect(([...store.values.keys()].filter(key => key.startsWith('voice-message:')))).toHaveLength(1)
    expect(first.frames.find(f => f.op === 'message')).toMatchObject({ message: { sender: 'board' } })
    expect(later.frames.find(f => f.op === 'message')).toMatchObject({ message: { sender: 'board' } })
  })
  it('remembers a committed board recording after history eviction and a lost acknowledgement', async () => {
    const board = socket('board'), browser = socket()
    await upload(board, 'persisted-reply')
    await room.fetch(new Request('https://room.internal/admin/clear', { method: 'POST', headers: { 'X-EasyInput-Clear': '1' } }))
    await chat(board, 'begin', { id: 'persisted-reply', samples: 900 })
    expect(board.frames.at(-1)).toMatchObject({ op: 'ack', committed: true })
    await chat(board, 'commit', { id: 'persisted-reply' })
    expect([...store.values.keys()].filter(key => key.startsWith('voice-message:'))).toEqual([])
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
    await chat(board, 'health.put', { record: measurement })
    const response = await room.fetch(new Request('https://room.internal/admin/clear', { method: 'POST', headers: { 'X-EasyInput-Clear': '1' } }))
    expect(await response.json()).toEqual({ ok: true, cleared: 2 })
    expect(store.values.has('messages')).toBe(false)
    expect([...store.values.keys()].filter((key) => key.startsWith('audio:'))).toEqual([])
    expect([...store.values.keys()].filter((key) => key.startsWith('upload:'))).toEqual([])
    expect(store.values.get('delivered:clear-two')).toBe(true)
    expect(store.values.get('realtime_enabled')).toBe(true)
    expect(store.values.get('health-count')).toBe(1)
    expect(store.values.get('health:1')).toMatchObject(measurement)
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
    expect(browser.frames.filter(f => f.op === 'realtime.stop')).toHaveLength(1)
    expect(browser.frames.at(-1)).toMatchObject({ op: 'settings', realtime_enabled: false })
    expect(store.values.get('realtime_enabled')).toBe(false)
  })
  it('starts and stops capture from the webpage without physical board keys', async () => {
    const browser = socket(), other = socket('browser', 'other'), board = socket('board')
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 100 }))
    await chat(browser, 'realtime.set', { enabled: true })
    expect(board.frames.at(-1)).toMatchObject({ op: 'settings', realtime_enabled: true })
    await chat(board, 'realtime.start')
    expect(other.frames.at(-1)).toMatchObject({ op: 'realtime.start' })
    await chat(other, 'realtime.set', { enabled: false })
    expect(board.frames.at(-1)).toMatchObject({ op: 'settings', realtime_enabled: false })
    expect(browser.frames.filter(f => f.op === 'realtime.stop')).toHaveLength(1)
    expect(store.values.get('realtime_active')).toBe(false)
    const packet = encodeRealtimePacket(1, new Int16Array(REALTIME_FRAME_SAMPLES))
    await room.webSocketMessage(board as unknown as WebSocket, packet.buffer as ArrayBuffer)
    expect(browser.binaryFrames).toHaveLength(0)
    await chat(board, 'realtime.start')
    expect(board.frames.at(-1)).toMatchObject({ op: 'error' })
    expect(store.values.get('realtime_active')).toBe(false)
  })
  it('rejects opening the microphone when only a Bluetooth gateway is online', async () => {
    const browser = socket()
    await room.webSocketMessage(browser as unknown as WebSocket, JSON.stringify({ type: 'gateway', payload: { type: 'status', protocol: 2, uptime_ms: 100 } }))
    await chat(browser, 'realtime.set', { enabled: true })
    expect(browser.frames.at(-1)).toMatchObject({ op: 'error', message: expect.stringContaining('Wi-Fi') })
    expect(store.values.get('realtime_enabled')).not.toBe(true)
    await chat(browser, 'realtime.set', { enabled: 'true' })
    expect(browser.frames.at(-1)).toMatchObject({ op: 'error' })
  })
  it('does not let unsolicited board telemetry or keys open the microphone', async () => {
    const browser = socket(), board = socket('board')
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 100, voice: { realtime_active: true } }))
    expect(board.frames.filter(f => f.op === 'settings').at(-1)).toMatchObject({ realtime_enabled: false })
    await chat(board, 'realtime.start')
    expect(board.frames.at(-1)).toMatchObject({ op: 'error' })
    expect(browser.frames.some(f => f.op === 'realtime.start')).toBe(false)
  })
  it('clears an opening request if the firmware never starts capture', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const browser = socket(), board = socket('board')
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 100 }))
    await chat(browser, 'realtime.set', { enabled: true })
    now.mockReturnValue(108_000)
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 8100, voice: { realtime_active: false } }))
    expect(store.values.get('realtime_enabled')).toBe(false)
    expect(board.frames.filter(f => f.op === 'settings').at(-1)).toMatchObject({ realtime_enabled: false })
  })
  it('allows pre-start telemetry to drain, then reconciles a lost stop from nested voice status', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const browser = socket(), board = socket('board')
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 100 }))
    await chat(browser, 'realtime.set', { enabled: true })
    await chat(board, 'realtime.start')
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 200, voice: { realtime_active: false } }))
    expect(store.values.get('realtime_active')).toBe(true)
    now.mockReturnValue(103_000)
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 3100, voice: { realtime_active: false } }))
    expect(store.values.get('realtime_active')).toBe(false)
    expect(store.values.get('realtime_enabled')).toBe(false)
  })
  it('closes capture when direct Wi-Fi heartbeats become stale', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const browser = socket(), board = socket('board')
    await room.webSocketMessage(board as unknown as WebSocket, JSON.stringify({ type: 'status', protocol: 2, uptime_ms: 100 }))
    await chat(browser, 'realtime.set', { enabled: true })
    await chat(board, 'realtime.start')
    now.mockReturnValue(108_001)
    await room.alarm()
    expect(store.values.get('realtime_active')).toBe(false)
    expect(store.values.get('realtime_enabled')).toBe(false)
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
