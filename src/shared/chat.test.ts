import { describe, expect, it } from 'vitest'
import {
  AUDIO_LIMIT, REALTIME_FRAME_BYTES, REALTIME_FRAME_SAMPLES, adjacentMessage,
  decodeMulaw, decodeRealtimePacket, encodeMulaw, encodeRealtimePacket, isRealtimePacket,
  latestUnreadMessage, sortMessages, isChatMessage,
} from './chat'
import type { ChatMessage } from './chat'
const message = (id: string, created: number, read = false, sender = 'computer'): ChatMessage => ({ id, sender, name: '电脑', samples: 8000, created, read })
describe('voice timeline behavior', () => {
  it('keeps browser microphone capture limited to sixty seconds', () => { expect(AUDIO_LIMIT).toBe(480_000) })
  it('sorts every sender by time without grouping computers', () => {
    const messages = [message('new-board', 300, false, 'board'), message('old-computer', 100), message('new-computer', 200)]
    expect(sortMessages(messages).map((value) => value.id)).toEqual(['old-computer', 'new-computer', 'new-board'])
  })
  it('selects the newest unread message across the shared timeline', () => {
    const messages = [message('one', 100), message('two', 200, true), message('three', 300)]
    expect(latestUnreadMessage(messages)?.id).toBe('three')
  })
  it('navigates short to older and long to newer without wrapping', () => {
    const messages = [message('one', 100), message('two', 200), message('three', 300)]
    expect(adjacentMessage(messages, null, 'older')?.id).toBe('three')
    expect(adjacentMessage(messages, 'three', 'older')?.id).toBe('two')
    expect(adjacentMessage(messages, 'two', 'newer')?.id).toBe('three')
    expect(adjacentMessage(messages, 'three', 'newer')).toBeUndefined()
  })
  it('uses G.711 mu-law reference values and preserves speech-scale samples', () => {
    expect(encodeMulaw(0)).toBe(255)
    expect(decodeMulaw(255)).toBe(0)
    expect(encodeMulaw(32767)).toBe(128)
    expect(decodeMulaw(128)).toBe(32124)
    for (const s of [-30000, -10000, -1000, 1000, 10000, 30000]) expect(Math.abs(decodeMulaw(encodeMulaw(s)) - s)).toBeLessThan(Math.abs(s) * 0.04 + 8)
  })
  it('round-trips 20 ms PCM16 realtime packets', () => {
    const samples = Int16Array.from({ length: REALTIME_FRAME_SAMPLES }, (_, index) => index * 31 - 5000)
    const packet = encodeRealtimePacket(42, samples)
    expect(packet.byteLength).toBe(REALTIME_FRAME_BYTES)
    expect(isRealtimePacket(packet)).toBe(true)
    expect(decodeRealtimePacket(packet.buffer as ArrayBuffer)).toMatchObject({ sequence: 42, samples })
    packet[5] = 2
    expect(isRealtimePacket(packet)).toBe(false)
  })
})

it('validates board and browser transcripts without accepting a fake audio clip', () => {
  const m = { id: 'text', sender: 'board', name: '开发板', samples: 0, created: 1, read: true, kind: 'text', text: '你好' }
  expect(isChatMessage(m)).toBe(true)
  expect(isChatMessage({ ...m, sender: 'browser', name: '电脑' })).toBe(true)
  for (const patch of [{ samples: 1 }, { read: false }, { text: ' ' }, { text: '字'.repeat(1001) }, { kind: 'html' }]) expect(isChatMessage({ ...m, ...patch })).toBe(false)
})

it('accepts saved recordings beyond the browser mic limit and validates split source ranges', () => {
  const m = { id: 'long', sender: 'board', name: '开发板', samples: 8000 * 3600, created: 1, read: true, interrupted: true }
  expect(isChatMessage(m)).toBe(true)
  expect(isChatMessage({ ...m, audioSource: 'source', audioStart: 8000, audioTotal: m.samples + 8000 })).toBe(true)
  for (const patch of [{ samples: 2 ** 31 }, { samples: 1.5 }, { interrupted: 'true' }, { audioSource: 'source' },
    { audioSource: 'source', audioStart: -1, audioTotal: m.samples }, { audioSource: 'source', audioStart: 1, audioTotal: m.samples }]) {
    expect(isChatMessage({ ...m, ...patch })).toBe(false)
  }
})
