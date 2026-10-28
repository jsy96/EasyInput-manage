import { describe, expect, it, vi } from 'vitest'
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
