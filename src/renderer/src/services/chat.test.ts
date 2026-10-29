import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatConnection } from './chat'

function connection() {
  const chat = new ChatConnection({ state: vi.fn(), telemetry: vi.fn(), bridge: vi.fn(), notice: vi.fn(), realtime: vi.fn() })
  const request = vi.spyOn(chat as unknown as { request(op: string, data: Record<string, unknown>): Promise<Record<string, unknown>> }, 'request')
  return { chat, request }
}
const record = { id: 'a'.repeat(32), kind: 'mother_low', value: 70, measuredAt: null, uptimeMs: 300, receivedAt: 1793145600000, sequence: 1 }
describe('ledger history download', () => {
  const entry = { id: 'a'.repeat(32), amount: 273, recordedAt: null, uptimeMs: 1, receivedAt: 1793145600000, sequence: 1 }
  it('uses a fixed upper bound and downloads all records', async () => {
    const { chat, request } = connection(), progress = vi.fn()
    request.mockResolvedValueOnce({ records: [entry], next: 1, through: 2 })
      .mockResolvedValueOnce({ records: [{ ...entry, id: 'b'.repeat(32), sequence: 2 }], next: 2, through: 2 })
    expect(await chat.ledgerHistory(progress)).toHaveLength(2)
    expect(request.mock.calls).toEqual([['ledger.list', { after: 0 }], ['ledger.list', { after: 1, through: 2 }]])
    expect(progress.mock.calls).toEqual([[1], [2]])
  })
  it('accepts empty history and rejects invalid amounts, missing rows and stalled pagination', async () => {
    const { chat, request } = connection()
    request.mockResolvedValueOnce({ records: [], next: 0, through: 0 })
    expect(await chat.ledgerHistory()).toEqual([])
    for (const page of [{ records: [{ ...entry, amount: 0 }], next: 1, through: 1 }, { records: [], next: 1, through: 2 }, { records: [], next: 0, through: 2 }]) {
      request.mockResolvedValueOnce(page)
      await expect(chat.ledgerHistory()).rejects.toThrow()
    }
  })
  it('rejects duplicate records across pages and changes to the export upper bound', async () => {
    for (const second of [{ records: [{ ...entry, sequence: 2 }], next: 2, through: 2 }, { records: [], next: 1, through: 3 }]) {
      const { chat, request } = connection()
      request.mockResolvedValueOnce({ records: [entry], next: 1, through: 2 }).mockResolvedValueOnce(second)
      await expect(chat.ledgerHistory()).rejects.toThrow()
    }
  })
})
describe('measurement history download', () => {
  it('downloads all pages using a fixed export upper bound', async () => {
    const { chat, request } = connection()
    request.mockResolvedValueOnce({ records: [record], next: 1, through: 2 }).mockResolvedValueOnce({ records: [{ ...record, id: 'b'.repeat(32), sequence: 2 }], next: 2, through: 2 })
    const progress = vi.fn()
    expect(await chat.healthHistory(progress)).toHaveLength(2)
    expect(request.mock.calls).toEqual([['health.list', { after: 0 }], ['health.list', { after: 1, through: 2 }]])
    expect(progress.mock.calls).toEqual([[1], [2]])
  })
  it('accepts an empty history', async () => {
    const { chat, request } = connection()
    request.mockResolvedValue({ records: [], next: 0, through: 0 })
    expect(await chat.healthHistory()).toEqual([])
  })
  it('rejects missing rows and pagination that does not advance', async () => {
    for (const page of [{ records: [], next: 1, through: 2 }, { records: [], next: 0, through: 2 }, { records: [{ ...record, value: 999 }], next: 1, through: 1 }]) {
      const { chat, request } = connection(); request.mockResolvedValue(page)
      await expect(chat.healthHistory()).rejects.toThrow()
      expect(request).toHaveBeenCalledOnce()
    }
  })
})

describe('voice history pagination', () => {
  const message = (n: number) => ({ id: `synthetic-${n}`, sender: 'board', name: 'Synthetic test', samples: 1, created: n + 1, read: false })
  it('fetches every page oldest to newest without mixing in newly arriving messages', async () => {
    const { chat, request } = connection()
    request.mockResolvedValueOnce({ messages: [message(2), message(3)], next: { id: 'synthetic-2', created: 3 }, through: { id: 'synthetic-3', created: 4 }, total: 4 })
      .mockResolvedValueOnce({ messages: [message(0), message(1)], next: null, through: { id: 'synthetic-3', created: 4 }, total: 4 })
    expect(await chat.voiceHistory()).toEqual([0, 1, 2, 3].map(message))
    expect(request.mock.calls[1]).toEqual(['list', { before: { id: 'synthetic-2', created: 3 }, through: { id: 'synthetic-3', created: 4 } }])
  })
  it('merges older pages while keeping fresher read status already received', async () => {
    const { chat, request } = connection()
    chat.state = { ...chat.state, messages: [{ ...message(1), read: true }, message(2)], next: { id: 'synthetic-2', created: 3 }, total: 3 }
    request.mockResolvedValue({ messages: [message(0), message(1)], next: null, through: { id: 'synthetic-2', created: 3 }, total: 3 })
    await chat.loadOlder()
    expect(chat.state.messages.map(m => m.id)).toEqual([0, 1, 2].map(n => message(n).id))
    expect(chat.state.messages[1].read).toBe(true)
    expect(chat.state.next).toBeNull()
  })
  it('detects retention changes during export instead of returning a partial history', async () => {
    const { chat, request } = connection()
    request.mockResolvedValue({ messages: [message(0)], next: null, through: { id: 'synthetic-0', created: 1 }, total: 2 })
    await expect(chat.voiceHistory()).rejects.toThrow('清理')
  })
  it('returns an empty voice history', async () => {
    const { chat, request } = connection()
    request.mockResolvedValue({ messages: [], next: null, through: null, total: 0 })
    expect(await chat.voiceHistory()).toEqual([])
  })
})

it('keeps text in paginated chat while excluding it from voice exports and downloads', async () => {
  const { chat, request } = connection()
  const text = { id: 'text', sender: 'board', name: '开发板', kind: 'text' as const, text: '你好', samples: 0, created: 2, read: true }
  const voice = { id: 'voice', sender: 'board', name: '开发板', samples: 100, created: 1, read: false }
  request.mockResolvedValue({ messages: [voice, text], next: null, through: { id: 'text', created: 2 }, total: 2 })
  expect(await chat.voiceHistory()).toEqual([voice])
  await expect(chat.download(text)).rejects.toThrow()
  expect(request).toHaveBeenCalledOnce()
})

describe('displayed text receipts', () => {
  const text = { id: 'synthetic-text', sender: 'board', name: 'Synthetic test', kind: 'text' as const, text: '测试文字', samples: 0, created: 2, read: true }
  const voice = { id: 'synthetic-voice', sender: 'board', name: 'Synthetic test', samples: 100, created: 1, read: false }
  const chats: ChatConnection[] = []
  class Socket {
    static OPEN = 1
    static instances: Socket[] = []
    readyState = 1
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    sent: Array<Record<string, unknown>> = []
    constructor(readonly url: string) { Socket.instances.push(this) }
    send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>) }
    close(): void { this.readyState = 3; this.onclose?.() }
    receive(value: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify({ type: 'chat', protocol: 2, ...value }) }) }
    snapshot(): void {
      this.onopen?.()
      this.receive({ op: 'snapshot', messages: [voice, text], total: 2, unread: 1, next: null, clients: [], self: null })
    }
    receipts(): Array<Record<string, unknown>> { return this.sent.filter(frame => frame.op === 'text.displayed') }
    acknowledge(index = this.receipts().length - 1, patch: Record<string, unknown> = {}): void {
      this.receive({ ...this.receipts()[index], ...patch })
    }
  }
  function liveConnection(): { chat: ChatConnection; socket: Socket } {
    vi.useFakeTimers()
    Socket.instances = []
    vi.stubGlobal('WebSocket', Socket)
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const chat = new ChatConnection({ state: vi.fn(), telemetry: vi.fn(), bridge: vi.fn(), notice: vi.fn(), realtime: vi.fn() })
    chats.push(chat)
    chat.start()
    const socket = Socket.instances[0]
    socket.snapshot()
    return { chat, socket }
  }
  afterEach(() => {
    for (const chat of chats.splice(0)) chat.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  it('waits for the mounted page to report display and deduplicates only confirmed receipts', async () => {
    const { chat, socket } = liveConnection()
    expect(socket.receipts()).toEqual([])
    await expect(chat.textDisplayed(voice.id)).rejects.toThrow('尚未载入')
    await expect(chat.textDisplayed('unknown')).rejects.toThrow('尚未载入')
    const first = chat.textDisplayed(text.id)
    expect(chat.textDisplayed(text.id)).toBe(first)
    expect(socket.receipts()).toEqual([{ type: 'chat', protocol: 2, op: 'text.displayed', id: text.id, req: expect.any(String) }])
    socket.acknowledge()
    await first
    socket.receive({ op: 'message', message: text, added: false, total: 2, unread: 1 })
    await chat.textDisplayed(text.id)
    expect(socket.receipts()).toHaveLength(1)
  })
  it('retries a lost acknowledgement with a new request and checks its message ID', async () => {
    const { chat, socket } = liveConnection()
    const receipt = chat.textDisplayed(text.id)
    await vi.advanceTimersByTimeAsync(3000)
    expect(socket.receipts()).toHaveLength(2)
    expect(socket.receipts()[1].req).not.toBe(socket.receipts()[0].req)
    socket.acknowledge(1, { id: 'different-text' })
    await Promise.resolve()
    expect(socket.receipts()).toHaveLength(3)
    socket.acknowledge()
    await receipt
  })
  it('loads a display replay after a lost first broadcast without counting it again', async () => {
    const { chat, socket } = liveConnection()
    socket.receive({ op: 'snapshot', messages: [voice], total: 2, unread: 1, next: null, clients: [], self: null })
    socket.receive({ op: 'message', message: text, added: false, total: 2, unread: 1 })
    expect(chat.state.messages).toEqual([voice])
    socket.receive({ op: 'message', message: text, added: false, display_required: true, total: 2, unread: 1 })
    expect(chat.state.messages).toEqual([voice, text])
    expect(chat.state.total).toBe(2)
    const receipt = chat.textDisplayed(text.id)
    socket.acknowledge()
    await receipt
    socket.receive({ op: 'message', message: text, added: false, display_required: true, total: 2, unread: 1 })
    expect(chat.state.messages).toEqual([voice, text])
    await chat.textDisplayed(text.id)
    expect(socket.receipts()).toHaveLength(1)
  })
  it('bounds retries and lets a later message replay retry a failed receipt', async () => {
    const { chat, socket } = liveConnection()
    const failed = expect(chat.textDisplayed(text.id)).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(9000)
    await failed
    expect(socket.receipts()).toHaveLength(3)
    socket.receive({ op: 'message', message: text, added: false, total: 2, unread: 1 })
    const retried = chat.textDisplayed(text.id)
    expect(socket.receipts()).toHaveLength(4)
    socket.acknowledge()
    await retried
  })
  it('resends confirmed messages after reconnect and stops retries on disconnect', async () => {
    const { chat, socket } = liveConnection()
    const first = chat.textDisplayed(text.id)
    socket.acknowledge()
    await first
    socket.close()
    await vi.advanceTimersByTimeAsync(1000)
    const replacement = Socket.instances[1]
    replacement.snapshot()
    const receipt = chat.textDisplayed(text.id)
    expect(replacement.receipts()).toHaveLength(1)
    const disconnected = expect(receipt).rejects.toThrow('连接中断')
    replacement.close()
    await disconnected
    expect(replacement.receipts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    const restored = Socket.instances[2]
    restored.snapshot()
    const confirmed = chat.textDisplayed(text.id)
    restored.acknowledge()
    await confirmed
  })
})
