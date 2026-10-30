import { afterEach, describe, expect, it, vi } from 'vitest'
import { ASR_DRAIN_MS, createXiaozhiIdentity, opusPacket, provisionXiaozhi, runXiaozhiTranscription, XiaozhiActivationError } from './xiaozhi'

class Socket extends EventTarget {
  readyState = 1
  frames: Array<string | Uint8Array> = []
  accept = vi.fn()
  send(value: string | Uint8Array): void { this.frames.push(value) }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')) }
  receive(data: unknown): void { this.dispatchEvent(new MessageEvent('message', { data })) }
  json(): Array<Record<string, unknown>> { return this.frames.filter((v): v is string => typeof v === 'string').map(v => JSON.parse(v)) }
}
const identity = { deviceId: '02:01:02:03:04:05', clientId: 'synthetic-cloud-client' }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('Xiaozhi web transcription protocol', () => {
  it('creates a stable independent software identity without copying a board', () => {
    const first = createXiaozhiIdentity(), second = createXiaozhiIdentity()
    expect(first.clientId).not.toBe(second.clientId)
    expect(first.deviceId).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/)
    expect(parseInt(first.deviceId.slice(0, 2), 16) & 3).toBe(2)
  })
  it('wraps raw Opus using the negotiated v1/v2/v3 framing', () => {
    const raw = new Uint8Array([1, 2, 3]).buffer
    expect([...opusPacket(raw, 1, 120)]).toEqual([1, 2, 3])
    const packet = opusPacket(raw, 2, 120), view = new DataView(packet.buffer)
    expect(view.getUint16(0)).toBe(2); expect(view.getUint32(8)).toBe(120); expect(view.getUint32(12)).toBe(3)
    expect([...packet.slice(16)]).toEqual([1, 2, 3])
    expect([...opusPacket(raw, 3, 120)]).toEqual([0, 0, 0, 3, 1, 2, 3])
    expect(() => opusPacket(new ArrayBuffer(4001), 1, 0)).toThrow('音频帧')
  })
  it('surfaces activation, uses the same independent identity, and bounds activation attempts', async () => {
    const fetcher = vi.fn(async (url: unknown) => String(url).endsWith('activate')
      ? new Response('{}', { status: 202 }) : Response.json({ activation: { code: '123456' } }))
    await expect(provisionXiaozhi(identity, new AbortController().signal, fetcher as typeof fetch)).rejects.toBeInstanceOf(XiaozhiActivationError)
    expect(fetcher).toHaveBeenCalledTimes(3)
    const init = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(init[1].redirect).toBe('manual')
    expect(init[1].headers).toMatchObject({ 'Device-Id': identity.deviceId, 'Client-Id': identity.clientId })
    expect(JSON.parse(String(init[1].body)).board.type).toBe('web')
  })
  it('rejects OTA redirects with the Workers-supported manual redirect mode', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://other.example/' } }))
    await expect(provisionXiaozhi(identity, new AbortController().signal, fetcher as typeof fetch)).rejects.toThrow('重定向')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual')
  })
  it('waits for all tail results, ignores assistant output, and saves once before success', async () => {
    vi.useFakeTimers()
    const browser = new Socket(), upstream = new Socket(), commit = vi.fn(async () => {})
    const fetcher = vi.fn(async (url: unknown) => String(url).includes('/ota/')
      ? Response.json({ websocket: { url: 'wss://speech.example/ws', token: 'synthetic-secret', version: 3 } })
      : { status: 101, webSocket: upstream })
    const done = runXiaozhiTranscription(browser as unknown as WebSocket, identity, commit, fetcher as unknown as typeof fetch)
    await vi.waitFor(() => expect(upstream.json()[0]?.type).toBe('hello'))
    upstream.receive(JSON.stringify({ type: 'hello', session_id: 's', transport: 'websocket' }))
    expect(browser.json()).toEqual([{ type: 'ready' }])
    browser.receive(new Uint8Array([7, 8]).buffer)
    expect([...upstream.frames.find(v => v instanceof Uint8Array) as Uint8Array]).toEqual([0, 0, 0, 2, 7, 8])
    upstream.receive(JSON.stringify({ type: 'stt', text: '第一句' }))
    upstream.receive(JSON.stringify({ type: 'stt', text: '第一句' }))
    upstream.receive(JSON.stringify({ type: 'llm', text: '忽略回答' }))
    browser.receive(JSON.stringify({ type: 'stop' }))
    upstream.receive(JSON.stringify({ type: 'tts', state: 'stop' }))
    await vi.advanceTimersByTimeAsync(ASR_DRAIN_MS - 1)
    expect(commit).not.toHaveBeenCalled()
    upstream.receive(JSON.stringify({ type: 'stt', text: '最后一句' }))
    await vi.advanceTimersByTimeAsync(1); await done
    expect(commit).toHaveBeenCalledExactlyOnceWith('第一句\n第一句\n最后一句')
    expect(browser.json().at(-1)).toEqual({ type: 'done' })
    expect(JSON.stringify(browser.frames)).not.toContain('synthetic-secret')
    expect(upstream.readyState).toBe(3)
  })
  it('does not save empty recognition or a cancelled session', async () => {
    vi.useFakeTimers()
    for (const cancel of [false, true]) {
      const browser = new Socket(), upstream = new Socket(), commit = vi.fn(async () => {})
      const fetcher = vi.fn(async (url: unknown) => String(url).includes('/ota/')
        ? Response.json({ websocket: { url: 'wss://speech.example/ws' } }) : { status: 101, webSocket: upstream })
      const done = runXiaozhiTranscription(browser as unknown as WebSocket, identity, commit, fetcher as unknown as typeof fetch)
      await vi.waitFor(() => expect(upstream.json()[0]?.type).toBe('hello'))
      upstream.receive(JSON.stringify({ type: 'hello', session_id: 's', transport: 'websocket' }))
      if (cancel) browser.close()
      else { browser.receive(JSON.stringify({ type: 'stop' })); await vi.advanceTimersByTimeAsync(ASR_DRAIN_MS) }
      await done
      expect(commit).not.toHaveBeenCalled()
      if (!cancel) expect(browser.json().at(-1)?.message).toContain('未识别')
    }
  })
})
