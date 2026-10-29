export const PROTOCOL_VERSION = 2
export const BLE_SERVICE_UUID = 'e1000001-6e24-4f51-a3bc-2d8db0000001'
export const BLE_TX_UUID = 'e1000002-6e24-4f51-a3bc-2d8db0000001'
export const BLE_RX_UUID = 'e1000003-6e24-4f51-a3bc-2d8db0000001'

export type ConnectionState = 'unknown' | 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'advertising'

export interface PixelSetting {
  color: string
  brightness: number
  on: boolean
}

export interface LightControl {
  ready: boolean
  pixels: PixelSetting[]
  status_led_brightness: number
  error?: string
}

export type LightCommand =
  | ({ action: 'lights.pixel.set'; index: number } & PixelSetting)
  | ({ action: 'lights.all.set' } & PixelSetting)
  | { action: 'lights.off' }
  | { action: 'lights.status.set'; brightness: number }
  | { action: 'peripherals.power.set'; on: boolean }

export type AudioCommand =
  | { action: 'audio.microphone.set'; on: boolean }
  | { action: 'audio.speaker.test'; volume: number }
  | { action: 'audio.speaker.stop' }

export interface BoardStatus {
  type: 'status'
  protocol: number
  uptime_ms: number
  wifi: {
    state: ConnectionState
    ssid?: string
    rssi?: number
    configured?: boolean
    disconnect_code?: number
    disconnects?: number
    retries?: number
    channel?: number
    ip?: string
    netmask?: string
    gateway?: string
    dns?: string
  }
  ble: { state: ConnectionState; name?: string; peers?: number }
  peripherals: { shared_rail: 'off' | 'on' | 'unknown' }
  lights: { status_led: 'off' | 'on' | 'unknown'; pixels: Array<'off' | 'on' | 'unknown'>; control?: LightControl }
  cloud?: { configured: boolean; online: boolean }
  voice?: {
    pending: number
    health_pending?: number
    ledger_pending?: number
    sending: boolean
    storage_error: boolean
    setup_active: boolean
    alarm_minute?: number | null
    countdown_seconds?: number
    stopwatch_running?: boolean
    stopwatch_seconds?: number
    realtime_active?: boolean
    realtime_enabled?: boolean
  }
  audio?: { ready: boolean; sample_rate_hz: number }
  speaker: { state: 'unavailable' | 'idle' | 'playing' | 'unknown'; volume?: number; error?: string }
  microphone: { state: 'unavailable' | 'idle' | 'active' | 'unknown'; rms?: number; vad?: boolean; error?: string }
  cpu: { frequency_mhz: number; usage_percent: number[]; temperature_c?: number }
  memory: {
    internal: { total_bytes: number; free_bytes: number; minimum_free_bytes: number; largest_block_bytes: number }
    psram: { total_bytes: number; free_bytes: number; largest_block_bytes: number }
  }
  storage: {
    flash: { state?: 'ready' | 'unknown'; total_bytes: number; unallocated_bytes: number; read_bytes_per_second: number; write_bytes_per_second: number; erase_bytes_per_second: number }
    partitions: Array<{ label: string; address: number; size_bytes: number; type: number; subtype: number }>
    app: { state?: 'running' | 'unknown'; partition_bytes: number; image_bytes: number; free_bytes: number }
    nvs: { state?: 'ready' | 'unavailable'; total_bytes: number; used_entries: number; free_entries: number; total_entries: number }
  }
  power: { battery_mv?: number; battery_percent_estimate?: number; external_power?: boolean; charging?: boolean }
}

export type LightMode = 'off' | 'solid' | 'blink' | 'flash' | 'unknown'

export interface BoardLights {
  type: 'lights'
  protocol: number
  uptime_ms: number
  status_led: 'off' | 'on' | 'unknown'
  modes: LightMode[]
}

export interface BoardHello {
  type: 'hello'
  protocol: number
  board: string
  chip: string
  firmware: string
  uptime_ms: number
}

export interface InputEvent {
  type: 'event'
  protocol: number
  source: 'key' | 'encoder' | 'microphone'
  action: string
  key?: string
  delta?: number
  rms?: number
  vad?: boolean
  uptime_ms: number
}

export interface BoardResult {
  type: 'result'
  protocol: number
  action: string
  ok: boolean
  message?: string
  request_id?: string
}

export type BoardMessage = BoardHello | BoardStatus | BoardLights | InputEvent | BoardResult

export function parseBoardMessage(line: string): BoardMessage | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }

  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.protocol !== PROTOCOL_VERSION || typeof record.type !== 'string') return null

  if (record.type === 'hello') {
    if (typeof record.board !== 'string' || typeof record.chip !== 'string' || typeof record.firmware !== 'string') return null
    return record as unknown as BoardHello
  }

  if (record.type === 'status') {
    const wifi = record.wifi
    const ble = record.ble
    const peripherals = record.peripherals
    const lights = record.lights
    const speaker = record.speaker
    const microphone = record.microphone
    const cpu = record.cpu
    const memory = record.memory
    const internalMemory = isRecord(memory) ? memory.internal : null
    const psramMemory = isRecord(memory) ? memory.psram : null
    const storage = record.storage
    const flashStorage = isRecord(storage) ? storage.flash : null
    const partitions = isRecord(storage) ? storage.partitions : null
    const appStorage = isRecord(storage) ? storage.app : null
    const nvsStorage = isRecord(storage) ? storage.nvs : null
    const power = record.power
    if (
      !isFiniteNumber(record.uptime_ms) || !isRecord(wifi) || typeof wifi.state !== 'string' ||
      !isRecord(ble) || typeof ble.state !== 'string' ||
      !isRecord(peripherals) || typeof peripherals.shared_rail !== 'string' ||
      !isRecord(lights) || typeof lights.status_led !== 'string' || !Array.isArray(lights.pixels) ||
      !isRecord(speaker) || typeof speaker.state !== 'string' ||
      !isRecord(microphone) || typeof microphone.state !== 'string' ||
      !isRecord(cpu) || !isFiniteNumber(cpu.frequency_mhz) || !Array.isArray(cpu.usage_percent) || !cpu.usage_percent.every(isFiniteNumber) ||
      !isRecord(internalMemory) || !isRecord(psramMemory) ||
      !['total_bytes', 'free_bytes', 'minimum_free_bytes', 'largest_block_bytes'].every((key) => isFiniteNumber(internalMemory[key])) ||
      !['total_bytes', 'free_bytes', 'largest_block_bytes'].every((key) => isFiniteNumber(psramMemory[key])) ||
      !isRecord(flashStorage) || !Array.isArray(partitions) ||
      !['total_bytes', 'unallocated_bytes', 'read_bytes_per_second', 'write_bytes_per_second', 'erase_bytes_per_second'].every((key) => isFiniteNumber(flashStorage[key])) ||
      !partitions.every((partition) => isRecord(partition) && typeof partition.label === 'string' && ['address', 'size_bytes', 'type', 'subtype'].every((key) => isFiniteNumber(partition[key]))) ||
      !isRecord(appStorage) || !['partition_bytes', 'image_bytes', 'free_bytes'].every((key) => isFiniteNumber(appStorage[key])) ||
      !isRecord(nvsStorage) || !['total_bytes', 'used_entries', 'free_entries', 'total_entries'].every((key) => isFiniteNumber(nvsStorage[key])) ||
      !isRecord(power)
    ) return null
    if (lights.control !== undefined && !isLightControl(lights.control)) return null
    if (record.voice !== undefined && (!isRecord(record.voice) || !isFiniteNumber(record.voice.pending) ||
      !Number.isInteger(record.voice.pending) || record.voice.pending < 0 || record.voice.pending > 9 ||
      (record.voice.health_pending !== undefined && (!Number.isInteger(record.voice.health_pending) || Number(record.voice.health_pending) < 0 || Number(record.voice.health_pending) > 64)) ||
      (record.voice.ledger_pending !== undefined && (!Number.isInteger(record.voice.ledger_pending) || Number(record.voice.ledger_pending) < 0 || Number(record.voice.ledger_pending) > 64)) ||
      !['sending', 'storage_error', 'setup_active'].every(key => typeof (record.voice as Record<string, unknown>)[key] === 'boolean') ||
      (record.voice.alarm_minute !== undefined && !(record.voice.alarm_minute === null || (isFiniteNumber(record.voice.alarm_minute) &&
        Number.isInteger(record.voice.alarm_minute) && record.voice.alarm_minute >= 0 && record.voice.alarm_minute < 1440))) ||
      (record.voice.countdown_seconds !== undefined && (!isFiniteNumber(record.voice.countdown_seconds) ||
        !Number.isInteger(record.voice.countdown_seconds) || record.voice.countdown_seconds < 0 || record.voice.countdown_seconds > 3600)) ||
      (record.voice.stopwatch_running !== undefined && typeof record.voice.stopwatch_running !== 'boolean') ||
      (record.voice.stopwatch_seconds !== undefined && (!isFiniteNumber(record.voice.stopwatch_seconds) ||
        !Number.isInteger(record.voice.stopwatch_seconds) || record.voice.stopwatch_seconds < 0 || record.voice.stopwatch_seconds > 4294967295)) ||
      (record.voice.realtime_active !== undefined && typeof record.voice.realtime_active !== 'boolean') ||
      (record.voice.realtime_enabled !== undefined && typeof record.voice.realtime_enabled !== 'boolean'))) return null
    if (record.audio !== undefined && (!isRecord(record.audio) || typeof record.audio.ready !== 'boolean' ||
      !isFiniteNumber(record.audio.sample_rate_hz) || !Number.isInteger(record.audio.sample_rate_hz) || record.audio.sample_rate_hz <= 0)) return null
    if ((microphone.rms !== undefined && !isAudioLevel(microphone.rms)) ||
      (microphone.vad !== undefined && typeof microphone.vad !== 'boolean') ||
      (microphone.error !== undefined && typeof microphone.error !== 'string') ||
      (speaker.volume !== undefined && !isBrightness(speaker.volume)) ||
      (speaker.error !== undefined && typeof speaker.error !== 'string')) return null
    return record as unknown as BoardStatus
  }

  if (record.type === 'lights') {
    if (
      !isFiniteNumber(record.uptime_ms) ||
      !['off', 'on', 'unknown'].includes(String(record.status_led)) ||
      !Array.isArray(record.modes) || record.modes.length !== 5 ||
      !record.modes.every((mode) => ['off', 'solid', 'blink', 'flash', 'unknown'].includes(String(mode)))
    ) return null
    return record as unknown as BoardLights
  }

  if (record.type === 'event') {
    if (
      !['key', 'encoder', 'microphone'].includes(String(record.source)) ||
      typeof record.action !== 'string' || typeof record.uptime_ms !== 'number'
    ) return null
    if (record.source === 'microphone' && ((record.rms !== undefined && !isAudioLevel(record.rms)) ||
      (record.vad !== undefined && typeof record.vad !== 'boolean'))) return null
    return record as unknown as InputEvent
  }

  if (record.type === 'result') {
    if (typeof record.action !== 'string' || typeof record.ok !== 'boolean') return null
    if (record.request_id !== undefined && (typeof record.request_id !== 'string' || !record.request_id || record.request_id.length > 64)) return null
    if (record.message !== undefined && typeof record.message !== 'string') return null
    return record as unknown as BoardResult
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBrightness(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
}

function isAudioLevel(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 32768
}

function isLightControl(value: unknown): value is LightControl {
  return isRecord(value) && typeof value.ready === 'boolean' && isBrightness(value.status_led_brightness) &&
    (value.error === undefined || typeof value.error === 'string') &&
    Array.isArray(value.pixels) && value.pixels.length === 5 && value.pixels.every((pixel) =>
      isRecord(pixel) && typeof pixel.color === 'string' && /^#[\da-f]{6}$/i.test(pixel.color) &&
      isBrightness(pixel.brightness) && typeof pixel.on === 'boolean')
}

export function commandResultMatches(result: BoardResult, pending: { action: string; requestId: string } | null): boolean {
  return pending !== null && result.action === pending.action && result.request_id === pending.requestId
}

export function pixelIsLit(pixel: PixelSetting): boolean {
  return pixel.on && [1, 3, 5].some((offset) => Math.round(parseInt(pixel.color.slice(offset, offset + 2), 16) * pixel.brightness / 100) > 0)
}

export function describeInputEvent(event: InputEvent): string {
  if (event.source === 'key') return `${event.key ?? '按键'} ${event.action === 'down' ? '按下' : '释放'}`
  if (event.source === 'encoder' && event.action === 'rotate') return `旋钮 ${event.delta && event.delta > 0 ? '+' : ''}${event.delta ?? 0}`
  if (event.source === 'encoder') return `旋钮按键 ${event.action === 'down' ? '按下' : '释放'}`
  if (event.action === 'level') return `麦克风音量 ${Math.round(event.rms ?? 0)}`
  return `麦克风 ${event.action === 'vad_start' ? '检测到语音' : event.action === 'vad_end' ? '语音结束' : event.action}`
}
