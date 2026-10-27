export const CHAT_VERSION = 1
export const AUDIO_RATE = 8000
export const AUDIO_LIMIT = AUDIO_RATE * 60
export const AUDIO_CHUNK = 768
export const CHAT_LIMIT = 100
export interface ChatMessage {
  id: string
  sender: string
  name: string
  slot: number
  samples: number
  created: number
  text?: string
  read: boolean
  cleared: boolean
}
export interface ChatClient { id: string; name: string; slot: number; online?: boolean }
export interface RoomState {
  online: boolean
  via: 'wifi' | 'ble' | null
  connected: boolean
  clients: ChatClient[]
  messages: ChatMessage[]
  self: ChatClient | null
}
export const emptyRoom: RoomState = { online: false, via: null, connected: false, clients: [], messages: [], self: null }
export function slotForClient(index: number): number { return Math.min(4, Math.max(0, index)) }
export function keyForSlot(slot: number): string { return slot < 4 ? `S${slot + 1}` : 'S8' }
export function slotLight(messages: ChatMessage[], slot: number): 'red' | 'green' | 'off' {
  const items = messages.filter((m) => m.sender !== 'board' && m.slot === slot && !m.cleared)
  return items.some((m) => !m.read) ? 'red' : items.length ? 'green' : 'off'
}
export function nextMessage(messages: ChatMessage[], slot: number): ChatMessage | undefined {
  const items = messages.filter((m) => m.sender !== 'board' && m.slot === slot && !m.cleared)
  return items.find((m) => !m.read) ?? items.at(-1)
}
export function encodeMulaw(sample: number): number {
  let pcm = Math.max(-32768, Math.min(32767, Math.round(sample)))
  const sign = pcm < 0 ? 0x80 : 0
  pcm = Math.min(32635, Math.abs(pcm)) + 132
  let exponent = 7
  for (let mask = 0x4000; exponent > 0 && !(pcm & mask); mask >>= 1) exponent--
  return ~(sign | (exponent << 4) | ((pcm >> (exponent + 3)) & 15)) & 255
}
export function decodeMulaw(value: number): number {
  const u = ~value & 255
  const pcm = (((u & 15) << 3) + 132) << ((u >> 4) & 7)
  return u & 128 ? 132 - pcm : pcm - 132
}
export function toBase64(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value)
}
export function fromBase64(value: string): Uint8Array { return Uint8Array.from(atob(value), (c) => c.charCodeAt(0)) }
export function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) }
