import { describe, expect, it, vi } from 'vitest'
import { ChatConnection } from './chat'

function connection() {
  const chat = new ChatConnection({ state: vi.fn(), telemetry: vi.fn(), bridge: vi.fn(), notice: vi.fn(), realtime: vi.fn() })
  const request = vi.spyOn(chat as unknown as { request(op: string, data: Record<string, unknown>): Promise<Record<string, unknown>> }, 'request')
  return { chat, request }
}
const record = { id: 'a'.repeat(32), kind: 'mother_low', value: 70, measuredAt: null, uptimeMs: 300, receivedAt: 1793145600000, sequence: 1 }
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
