import { afterEach, describe, expect, it, vi } from 'vitest'
import { synthesize } from './tts'
import { edgeGec } from './edge-gec'
class SpeechSocket extends EventTarget {
  binaryType = 'blob'
  sent: string[] = []
  accept(): void {}
  close(): void {}
  send(value: string): void {
    this.sent.push(value)
    if (this.sent.length !== 2) return
    queueMicrotask(() => {
      const header = new TextEncoder().encode('Path:audio\r\nContent-Type:audio/mpeg\r\n')
      const frame = new Uint8Array(2 + header.length + 300)
      frame[0] = header.length >> 8; frame[1] = header.length & 255; frame.set(header, 2); frame.fill(42, header.length + 2)
      this.dispatchEvent(new MessageEvent('message', { data: this.binaryType === 'arraybuffer' ? frame.buffer : new Blob([frame]) }))
      this.dispatchEvent(new MessageEvent('message', { data: 'Path:turn.end\r\n\r\n' }))
    })
  }
}
afterEach(() => vi.unstubAllGlobals())
describe('Edge read-aloud adapter', () => {
  it('extracts binary audio under the Workers Blob default and preserves escaped Chinese text', async () => {
    const socket = new SpeechSocket()
    vi.stubGlobal('fetch', vi.fn(async () => ({ webSocket: socket, status: 101 })))
    const audio = await synthesize('你好 & 开发板')
    expect(audio.byteLength).toBe(300)
    expect([...new Uint8Array(audio)]).toEqual(Array(300).fill(42))
    expect(socket.sent[1]).toContain('你好 &amp; 开发板')
    expect(socket.sent[1]).toContain('zh-CN-YunjianNeural')
    expect(socket.sent[1]).toContain('rate="-10%"')
  })
  it('matches the installed edge-tts 7.3.1 client at a fixed timestamp', () => {
    expect(edgeGec(1793050000)).toBe('99E42783D4CE304B-3D3024030C67B9261C9C4ECFBE7B42AE8014B133AE357C057F0CF1815CF92497')
  })
})
