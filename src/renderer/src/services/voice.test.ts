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
