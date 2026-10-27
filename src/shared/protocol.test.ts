import { describe, expect, it } from 'vitest'
import { describeInputEvent, commandResultMatches, parseBoardMessage, pixelIsLit } from './protocol'

describe('board protocol', () => {
  it('accepts complete status frames for protocol v2 and rejects old or unknown versions', () => {
    const status = {
      type: 'status', protocol: 2, uptime_ms: 42,
      wifi: { state: 'disconnected', configured: false, retries: 0, disconnects: 0 }, ble: { state: 'advertising' },
      peripherals: { shared_rail: 'off' },
      lights: { status_led: 'off', pixels: ['off', 'off', 'off', 'off', 'off'] },
      speaker: { state: 'unavailable' }, microphone: { state: 'unavailable', rms: 0, vad: false },
      cpu: { frequency_mhz: 160, usage_percent: [0, 0] },
      memory: { internal: { total_bytes: 1, free_bytes: 1, minimum_free_bytes: 1, largest_block_bytes: 1 }, psram: { total_bytes: 0, free_bytes: 0, largest_block_bytes: 0 } },
      storage: { flash: { total_bytes: 1, unallocated_bytes: 0, read_bytes_per_second: 0, write_bytes_per_second: 0, erase_bytes_per_second: 0 }, partitions: [], app: { partition_bytes: 1, image_bytes: 1, free_bytes: 0 }, nvs: { total_bytes: 1, used_entries: 1, free_entries: 0, total_entries: 1 } },
      power: {},
    }
    expect(parseBoardMessage(JSON.stringify(status))).toEqual(status)
    const audioStatus = {
      ...status, audio: { ready: true, sample_rate_hz: 16000 },
      microphone: { state: 'active', rms: 512, vad: true },
      speaker: { state: 'playing', volume: 10 },
    }
    expect(parseBoardMessage(JSON.stringify(audioStatus))).toEqual(audioStatus)
  const voice = {
    pending: 8, sending: false, storage_error: false, setup_active: true,
    alarm_minute: 750, countdown_seconds: 0, realtime_active: false, realtime_enabled: true,
  }
    expect(parseBoardMessage(JSON.stringify({ ...audioStatus, voice }))).toEqual({ ...audioStatus, voice })
    expect(parseBoardMessage(JSON.stringify({ ...audioStatus, voice: { ...voice, sending: true, pending: 1 } }))).not.toBeNull()
  for (const value of [null, { ...voice, pending: -1 }, { ...voice, pending: 10 }, { ...voice, realtime_enabled: 'off' }, { ...voice, alarm_minute: 1440 }]) {
      expect(parseBoardMessage(JSON.stringify({ ...audioStatus, voice: value }))).toBeNull()
    }
    expect(parseBoardMessage(JSON.stringify({ ...audioStatus, audio: { ready: false, sample_rate_hz: 16000 }, microphone: { state: 'unavailable', error: 'ESP_ERR_TIMEOUT' } }))).not.toBeNull()
    for (const audio of [null, { ready: 'yes', sample_rate_hz: 16000 }, { ready: true, sample_rate_hz: 0 }, { ready: true, sample_rate_hz: 1.5 }]) {
      expect(parseBoardMessage(JSON.stringify({ ...audioStatus, audio }))).toBeNull()
    }
    for (const microphone of [
      { state: 'active', rms: -1 }, { state: 'active', rms: 32769 },
      { state: 'active', rms: '512' }, { state: 'active', vad: 1 }, { state: 'unavailable', error: 5 },
    ]) expect(parseBoardMessage(JSON.stringify({ ...audioStatus, microphone }))).toBeNull()
    for (const volume of [-1, 101, 1.5, '10']) {
      expect(parseBoardMessage(JSON.stringify({ ...audioStatus, speaker: { state: 'playing', volume } }))).toBeNull()
    }
    const control = {
      ready: true, status_led_brightness: 25,
      pixels: Array.from({ length: 5 }, () => ({ color: '#fF8000', brightness: 20, on: true })),
    }
    const extended = { ...status, lights: { ...status.lights, control } }
    expect(parseBoardMessage(JSON.stringify(extended))).toEqual(extended)
    for (const invalid of [
      { ...control, ready: 'yes' },
      { ...control, status_led_brightness: 101 },
      { ...control, status_led_brightness: -1 },
      { ...control, pixels: control.pixels.slice(1) },
      { ...control, pixels: [...control.pixels.slice(1), { color: 'red', brightness: 20, on: true }] },
      { ...control, pixels: [...control.pixels.slice(1), { color: '#ffffff', brightness: 1.5, on: true }] },
      { ...control, pixels: [...control.pixels.slice(1), { color: '#ffffff', brightness: 20, on: 'on' }] },
    ]) expect(parseBoardMessage(JSON.stringify({ ...extended, lights: { ...status.lights, control: invalid } }))).toBeNull()
    expect(parseBoardMessage(JSON.stringify({ ...extended, lights: { ...status.lights, control: { ...control, ready: false, error: 'ESP_ERR_TIMEOUT' } } }))).not.toBeNull()
    expect(parseBoardMessage(JSON.stringify({ ...status, protocol: 1 }))).toBeNull()
    expect(parseBoardMessage(JSON.stringify({ ...status, protocol: 3 }))).toBeNull()
    expect(parseBoardMessage(JSON.stringify({ ...status, storage: { ...status.storage, partitions: [{ label: 'bad', address: 'unknown' }] } }))).toBeNull()
  })

  it('ignores malformed and incomplete input frames', () => {
    expect(parseBoardMessage('{')).toBeNull()
    expect(parseBoardMessage(JSON.stringify({ type: 'event', protocol: 2, source: 'other', action: 'x', uptime_ms: 1 }))).toBeNull()
  })

  it('turns encoder deltas into readable event text', () => {
    expect(describeInputEvent({ type: 'event', protocol: 2, source: 'encoder', action: 'rotate', delta: -1, uptime_ms: 10 })).toBe('旋钮 -1')
  })

  it('accepts microphone levels and VAD edges and rejects invalid telemetry', () => {
    for (const action of ['level', 'vad_start', 'vad_end']) {
      const event = { type: 'event', protocol: 2, source: 'microphone', action, rms: 512, vad: action !== 'vad_end', uptime_ms: 42 }
      expect(parseBoardMessage(JSON.stringify(event))).toEqual(event)
      expect(parseBoardMessage(JSON.stringify({ ...event, rms: -1 }))).toBeNull()
      expect(parseBoardMessage(JSON.stringify({ ...event, rms: 32769 }))).toBeNull()
      expect(parseBoardMessage(JSON.stringify({ ...event, vad: 'false' }))).toBeNull()
    }
    expect(describeInputEvent({ type: 'event', protocol: 2, source: 'microphone', action: 'vad_end', uptime_ms: 42 })).toBe('麦克风 语音结束')
  })

  it('does not match a late audio acknowledgement to another operation', () => {
    const pending = { action: 'audio.microphone.set', requestId: 'capture-2' }
    const result = { type: 'result' as const, protocol: 2, action: pending.action, request_id: pending.requestId, ok: true }
    expect(commandResultMatches(result, pending)).toBe(true)
    expect(commandResultMatches({ ...result, request_id: 'capture-1' }, pending)).toBe(false)
    expect(commandResultMatches({ ...result, action: 'audio.speaker.test' }, pending)).toBe(false)
  })

  it('matches only the action and request ID of the outstanding light operation', () => {
    const pending = { action: 'lights.pixel.set', requestId: 'operation-2' }
    const result = { type: 'result' as const, protocol: 2, action: pending.action, ok: true, request_id: pending.requestId }
    expect(parseBoardMessage(JSON.stringify(result))).toEqual(result)
    expect(commandResultMatches(result, pending)).toBe(true)
    expect(commandResultMatches({ ...result, request_id: 'operation-1' }, pending)).toBe(false)
    expect(commandResultMatches({ ...result, action: 'lights.all.set' }, pending)).toBe(false)
    expect(commandResultMatches({ ...result, request_id: undefined }, pending)).toBe(false)
    expect(commandResultMatches(result, null)).toBe(false)
    expect(parseBoardMessage(JSON.stringify({ ...result, request_id: 12 }))).toBeNull()
    expect(parseBoardMessage(JSON.stringify({ ...result, request_id: '' }))).toBeNull()
  })

  it('treats disabled, black and sub-byte dim pixels as off after scaling', () => {
    expect(pixelIsLit({ color: '#ff0000', brightness: 20, on: true })).toBe(true)
    expect(pixelIsLit({ color: '#ff0000', brightness: 20, on: false })).toBe(false)
    expect(pixelIsLit({ color: '#ff0000', brightness: 0, on: true })).toBe(false)
    expect(pixelIsLit({ color: '#000000', brightness: 100, on: true })).toBe(false)
    expect(pixelIsLit({ color: '#010101', brightness: 20, on: true })).toBe(false)
    expect(pixelIsLit({ color: '#000001', brightness: 50, on: true })).toBe(true)
  })
})
