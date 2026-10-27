import { describe, expect, it } from 'vitest'
import { decodeMulaw, encodeMulaw, keyForSlot, nextMessage, slotForClient, slotLight } from './chat'
import type { ChatMessage } from './chat'
const message = (id: string, read = false, slot = 0): ChatMessage => ({ id, sender: 'computer', name: '电脑', slot, samples: 8000, created: 1, read, cleared: false })
describe('voice group behavior', () => {
  it('keeps the first four clients separate and routes every later client to S8', () => {
    expect(Array.from({ length: 8 }, (_, i) => keyForSlot(slotForClient(i)))).toEqual(['S1','S2','S3','S4','S8','S8','S8','S8'])
  })
  it('plays unread messages in order, then repeats the last read message', () => {
    const messages = [message('one', true), message('two'), message('three')]
    expect(nextMessage(messages, 0)?.id).toBe('two')
    expect(slotLight(messages, 0)).toBe('red')
    messages[1].read = messages[2].read = true
    expect(nextMessage(messages, 0)?.id).toBe('three')
    expect(slotLight(messages, 0)).toBe('green')
    messages.forEach(m => { m.cleared = true })
    expect(nextMessage(messages, 0)).toBeUndefined()
    expect(slotLight(messages, 0)).toBe('off')
  })
  it('combines unread voice from additional computers on the fifth light', () => {
    const m = [message('five', true, 4), { ...message('six', false, 4), sender: 'sixth' }]
    expect(slotLight(m, 4)).toBe('red')
    m[0].cleared = true
    expect(slotLight(m, 4)).toBe('red')
    m[1].read = true
    expect(slotLight(m, 4)).toBe('green')
  })
  it('uses G.711 mu-law reference values and preserves speech-scale samples', () => {
    expect(encodeMulaw(0)).toBe(255)
    expect(decodeMulaw(255)).toBe(0)
    expect(encodeMulaw(32767)).toBe(128)
    expect(decodeMulaw(128)).toBe(32124)
    for (const s of [-30000, -10000, -1000, 1000, 10000, 30000]) expect(Math.abs(decodeMulaw(encodeMulaw(s)) - s)).toBeLessThan(Math.abs(s) * 0.04 + 8)
  })
})
