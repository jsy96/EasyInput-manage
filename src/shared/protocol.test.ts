import { describe, expect, it } from 'vitest'
import { describeInputEvent, parseBoardMessage } from './protocol'

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
})
