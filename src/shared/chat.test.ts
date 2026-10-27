import { describe, expect, it } from 'vitest'
import { AUDIO_LIMIT, adjacentMessage, decodeMulaw, encodeMulaw, latestUnreadMessage, sortMessages } from './chat'
import type { ChatMessage } from './chat'
const message = (id: string, created: number, read = false, sender = 'computer'): ChatMessage => ({ id, sender, name: '电脑', samples: 8000, created, read })
describe('voice timeline behavior', () => {
  it('limits one recording to twenty seconds', () => { expect(AUDIO_LIMIT).toBe(160_000) })
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
})
