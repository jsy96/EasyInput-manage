import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIO_LIMIT } from '@shared/chat'
import { captureSampleLimit, VoiceSequencePlayer } from './voice'

describe('captureSampleLimit', () => {
  it('keeps the existing limit at the persisted audio rate', () => {
    expect(captureSampleLimit(8000)).toBe(AUDIO_LIMIT)
  })

  it('allows a full twenty seconds at common browser capture rates', () => {
    expect(captureSampleLimit(44100)).toBe(882000)
    expect(captureSampleLimit(48000)).toBe(960000)
  })

  it('rejects invalid rates', () => {
    expect(() => captureSampleLimit(0)).toThrow('Invalid audio sample rate')
    expect(() => captureSampleLimit(Number.POSITIVE_INFINITY)).toThrow('Invalid audio sample rate')
  })
})

describe('VoiceSequencePlayer', () => {
  const sources: Array<{ onended: (() => void) | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = []
  beforeEach(() => {
    sources.length = 0
    vi.stubGlobal('AudioContext', class {
      resume = vi.fn(async () => {})
      close = vi.fn(async () => {})
      destination = {}
      createBuffer(_channels: number, length: number) { return { getChannelData: () => new Float32Array(length) } }
      createBufferSource() {
        const source = { onended: null as (() => void) | null, start: vi.fn(), stop: vi.fn(), connect: vi.fn(), buffer: null }
        sources.push(source); return source
      }
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  it('loads and plays each clip only after the previous clip ends', async () => {
    const player = new VoiceSequencePlayer(), load = vi.fn(async () => new Uint8Array([255, 128])), changed = vi.fn()
    const done = player.play(['first', 'second'], load, changed)
    await vi.waitFor(() => expect(sources).toHaveLength(1))
    expect(load.mock.calls).toHaveLength(1)
    sources[0].onended?.()
    await vi.waitFor(() => expect(sources).toHaveLength(2))
    expect(changed.mock.calls).toEqual([['first', 0], ['second', 1]])
    sources[1].onended?.(); await done
  })
  it('stops a playing clip and skips every remaining clip', async () => {
    const player = new VoiceSequencePlayer(), load = vi.fn(async () => new Uint8Array([255]))
    const done = player.play(['first', 'second'], load, vi.fn())
    await vi.waitFor(() => expect(sources).toHaveLength(1))
    player.stop(); await done
    expect(sources[0].stop).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('does not start audio when stopped during a download', async () => {
    const player = new VoiceSequencePlayer()
    let finish: (value: Uint8Array) => void = () => {}
    const load = vi.fn(() => new Promise<Uint8Array>(resolve => { finish = resolve }))
    const done = player.play(['first'], load, vi.fn())
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
    player.stop(); finish(new Uint8Array([255])); await done
    expect(sources).toHaveLength(0)
  })
  it('reports a missing clip and stops the queue', async () => {
    const player = new VoiceSequencePlayer(), load = vi.fn(async () => { throw new Error('语音已删除') })
    await expect(player.play(['first', 'second'], load, vi.fn())).rejects.toThrow('语音已删除')
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('long voice WAV', () => {
  it('preserves every PCM sample and length across bounded input chunks', async () => {
    const { voiceWavChunks } = await import('./voice')
    const { decodeMulaw } = await import('@shared/chat')
    async function* chunks() { for (let i = 0; i < 21; i++) yield new Uint8Array(8000).fill(i === 20 ? 128 : 255); yield new Uint8Array([0]) }
    const blob = await voiceWavChunks(chunks(), 168001), view = new DataView(await blob.arrayBuffer())
    expect(blob.size).toBe(44 + 168001 * 2)
    expect(view.getUint32(40, true)).toBe(168001 * 2)
    expect(view.getInt16(44 + 160000 * 2, true)).toBe(32124)
    expect(view.getInt16(blob.size - 2, true)).toBe(decodeMulaw(0))
  })
  it('rejects missing tails, overflow and cancellation', async () => {
    const { voiceWavChunks } = await import('./voice')
    async function* chunks() { yield new Uint8Array(10) }
    await expect(voiceWavChunks(chunks(), 11)).rejects.toThrow('尾部')
    await expect(voiceWavChunks(chunks(), 9)).rejects.toThrow('长度')
    await expect(voiceWavChunks(chunks(), 10, () => false)).rejects.toThrow('取消')
    await expect(voiceWavChunks(chunks(), 2 ** 31)).rejects.toThrow('WAV')
  })
})

it('bounds sequential playback to three decoded blocks while a long recording is still downloading', async () => {
  const sources: Array<{ onended: (() => void) | null; ended: boolean; stop(): void }> = [], lengths: number[] = []
  let yielded = 0
  vi.stubGlobal('AudioContext', class {
    currentTime = 0
    destination = {}
    async resume() {}
    async close() {}
    createBuffer(_channels: number, length: number) { lengths.push(length); return { getChannelData: () => new Float32Array(length) } }
    createBufferSource() {
      const source = { onended: null as (() => void) | null, ended: false, buffer: null, connect() {}, start() {}, stop() { this.ended = true } }
      sources.push(source); return source
    }
  })
  try {
    const player = new VoiceSequencePlayer()
    async function* chunks() { for (let i = 0; i < 40; i++) { yielded++; yield new Uint8Array(8192).fill(255) } }
    const done = player.play(['long'], chunks, vi.fn())
    await vi.waitFor(() => expect(sources).toHaveLength(3))
    expect(yielded).toBeLessThanOrEqual(4)
    expect(Math.max(...lengths)).toBe(8192)
    sources[0].ended = true; sources[0].onended?.()
    await vi.waitFor(() => expect(sources).toHaveLength(4))
    expect(yielded).toBeLessThanOrEqual(5)
    player.stop(); await done
    expect(sources.every(source => source.ended)).toBe(true)
  } finally { vi.unstubAllGlobals() }
})
