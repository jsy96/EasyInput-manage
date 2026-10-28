import { describe, expect, it } from 'vitest'
import { AUDIO_LIMIT } from '@shared/chat'
import { captureSampleLimit } from './voice'

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
