export const CHAT_VERSION = 2
export const AUDIO_RATE = 8000
export const AUDIO_LIMIT = AUDIO_RATE * 60
// Storage/WAV format guard (about 74 hours), independent of the browser mic limit.
export const VOICE_SAMPLES_MAX = 0x7ffff000
export const RECORD_BATCH_CHUNKS = 8
export const RECORD_IDLE_MS = 90_000
export const AUDIO_CHUNK = 768
export const AUDIO_BATCH = 16
export const AUDIO_STREAM_WINDOW = 24
export const CHAT_LIMIT = 5000
export const CHAT_PAGE_SIZE = 50
export const BOARD_INDEX_PAGE_SIZE = 8
export const REALTIME_SAMPLE_RATE = 16_000
export const REALTIME_FRAME_SAMPLES = 320
export const REALTIME_HEADER_BYTES = 12
export const REALTIME_FRAME_BYTES = REALTIME_HEADER_BYTES + REALTIME_FRAME_SAMPLES * 2
export const CHAT_TEXT_LIMIT = 1000
export interface ChatMessage {
  id: string
  sender: string
  name: string
  samples: number
  created: number
  read: boolean
  kind?: 'voice' | 'text'
  text?: string
  interrupted?: boolean
  audioSource?: string
  audioStart?: number
  audioTotal?: number
}
export function isVoiceMessage(m: ChatMessage): boolean { return m.kind !== 'text' }
export interface ChatCursor { created: number; id: string }
export interface ChatPage {
  messages: ChatMessage[]
  next: ChatCursor | null
  through: ChatCursor | null
  total: number
}
export function compareMessages(a: ChatCursor, b: ChatCursor): number {
  return a.created - b.created || a.id.localeCompare(b.id)
}
export function isChatCursor(value: unknown): value is ChatCursor {
  const c = value as ChatCursor | null
  return !!c && Number.isSafeInteger(c.created) && c.created > 0 && validId(c.id)
}
export function isChatMessage(value: unknown): value is ChatMessage {
  const m = value as ChatMessage | null
  return isChatCursor(m) && typeof m.sender === 'string' && typeof m.name === 'string' &&
    typeof m.read === 'boolean' && (m.kind === 'text'
      ? m.samples === 0 && m.read && typeof m.text === 'string' && m.text.trim().length > 0 && m.text.length <= CHAT_TEXT_LIMIT
      : (m.kind === undefined || m.kind === 'voice') && Number.isSafeInteger(m.samples) && m.samples > 0 && m.samples <= VOICE_SAMPLES_MAX &&
        (m.interrupted === undefined || typeof m.interrupted === 'boolean') &&
        (m.audioSource === undefined || (validId(m.audioSource) && Number.isSafeInteger(m.audioStart) && m.audioStart! >= 0 &&
          Number.isSafeInteger(m.audioTotal) && m.audioTotal! <= VOICE_SAMPLES_MAX && m.audioStart! + m.samples <= m.audioTotal!)))
}
export interface ChatClient { id: string; name: string; online?: boolean }
export interface RoomState {
  online: boolean
  via: 'wifi' | 'ble' | null
  connected: boolean
  clients: ChatClient[]
  messages: ChatMessage[]
  total: number
  unread: number
  next: ChatCursor | null
  self: ChatClient | null
  realtimeEnabled: boolean
  realtimeActive: boolean
  healthPending: number | null
  ledgerPending: number | null
}
export const emptyRoom: RoomState = {
  online: false, via: null, connected: false, clients: [], messages: [], total: 0, unread: 0, next: null, self: null,
  realtimeEnabled: false, realtimeActive: false,
  healthPending: null,
  ledgerPending: null,
}
export function sortMessages(messages: ChatMessage[]): ChatMessage[] {
  return [...messages].sort(compareMessages)
}
export function latestUnreadMessage(messages: ChatMessage[]): ChatMessage | undefined {
  const sorted = sortMessages(messages)
  for (let index = sorted.length - 1; index >= 0; index--) if (!sorted[index].read) return sorted[index]
  return undefined
}
export function latestMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return sortMessages(messages).at(-1)
}
export function adjacentMessage(
  messages: ChatMessage[],
  currentId: string | null,
  direction: 'older' | 'newer',
): ChatMessage | undefined {
  const sorted = sortMessages(messages)
  if (!currentId) return direction === 'older' ? latestUnreadMessage(sorted) ?? sorted.at(-1) : sorted.at(-1)
  const index = sorted.findIndex((message) => message.id === currentId)
  if (index < 0) return direction === 'older' ? sorted.at(-1) : sorted[0]
  return sorted[index + (direction === 'older' ? -1 : 1)]
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

export function encodeRealtimePacket(sequence: number, samples: Int16Array): Uint8Array {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff || samples.length !== REALTIME_FRAME_SAMPLES) {
    throw new Error('Invalid realtime packet')
  }
  const bytes = new Uint8Array(REALTIME_FRAME_BYTES)
  bytes.set([0x45, 0x49, 0x56, 0x32, 1, 1, 0, 0])
  new DataView(bytes.buffer).setUint32(8, sequence, true)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < samples.length; index++) view.setInt16(REALTIME_HEADER_BYTES + index * 2, samples[index], true)
  return bytes
}

export function isRealtimePacket(value: ArrayBuffer | Uint8Array): boolean {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  return bytes.byteLength === REALTIME_FRAME_BYTES &&
    bytes[0] === 0x45 && bytes[1] === 0x49 && bytes[2] === 0x56 && bytes[3] === 0x32 &&
    bytes[4] === 1 && bytes[5] === 1 && bytes[6] === 0 && bytes[7] === 0
}

export function decodeRealtimePacket(value: ArrayBuffer): { sequence: number; samples: Int16Array } | null {
  if (!isRealtimePacket(value)) return null
  const view = new DataView(value)
  const samples = new Int16Array(REALTIME_FRAME_SAMPLES)
  for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(REALTIME_HEADER_BYTES + index * 2, true)
  return { sequence: view.getUint32(8, true), samples }
}
