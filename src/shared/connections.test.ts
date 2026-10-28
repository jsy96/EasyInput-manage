import { describe, expect, it } from 'vitest'
import { BoardConnections } from './connections'

const hello = { type: 'hello', protocol: 2, board: 'easyinput-v2', chip: 'ESP32-S3', firmware: '0.1.2', uptime_ms: 5000 }
const status = {
  type: 'status', protocol: 2, uptime_ms: 5000,
  wifi: { state: 'connected', configured: true, ssid: 'Saved Wi-Fi' }, ble: { state: 'connected' },
  peripherals: { shared_rail: 'off' }, lights: { status_led: 'off', pixels: [] },
  speaker: { state: 'unavailable' }, microphone: { state: 'unavailable' },
  cpu: { frequency_mhz: 160, usage_percent: [0, 0] },
  memory: { internal: { total_bytes: 1, free_bytes: 1, minimum_free_bytes: 1, largest_block_bytes: 1 }, psram: { total_bytes: 1, free_bytes: 1, largest_block_bytes: 1 } },
  storage: {
    flash: { total_bytes: 1, unallocated_bytes: 0, read_bytes_per_second: 0, write_bytes_per_second: 0, erase_bytes_per_second: 0 },
    partitions: [], app: { partition_bytes: 1, image_bytes: 1, free_bytes: 0 },
    nvs: { total_bytes: 1, used_entries: 1, free_entries: 0, total_entries: 1 },
  }, power: {},
}
const event = { type: 'event', protocol: 2, source: 'key', action: 'down', key: 'S1', uptime_ms: 5200 }
const frame = (message: unknown) => `${JSON.stringify(message)}\n`
const handshake = frame(hello) + frame(status)

describe('independent board connections', () => {
  it('reassembles USB and BLE fragments independently, including after a reconnect', () => {
    const connections = new BoardConnections()
    const split = 18
    expect(connections.receive('usb', frame(hello).slice(0, split), 100)).toEqual([])
    expect(connections.receive('ble', handshake, 101)).toHaveLength(2)
    expect(connections.receive('usb', frame(hello).slice(split) + frame(status), 102)).toHaveLength(2)
    expect(connections.commandTransport(103)).toBe('usb')
    connections.receive('usb', '{"type":', 104)
    connections.reset('usb')
    expect(connections.receive('usb', handshake, 105)).toHaveLength(2)
    expect(connections.isOnline('ble', 106)).toBe(true)
  })

  it('requires each transport to complete its own handshake', () => {
    const connections = new BoardConnections()
    connections.receive('usb', frame(hello), 100)
    connections.receive('ble', frame(status), 100)
    expect(connections.commandTransport(101)).toBeNull()
    connections.receive('ble', frame(hello), 102)
    expect(connections.commandTransport(103)).toBe('ble')
    expect(connections.isOnline('usb', 103)).toBe(false)
  })

  it.each(['usb', 'ble'] as const)('keeps the other transport and Wi-Fi status when %s disconnects', (transport) => {
    const connections = new BoardConnections()
    connections.receive('usb', handshake, 100)
    connections.receive('ble', handshake, 100)
    connections.reset(transport)
    const remaining = transport === 'usb' ? 'ble' : 'usb'
    expect(connections.commandTransport(101)).toBe(remaining)
    expect(connections.current(101)?.session.status?.wifi).toEqual(status.wifi)
    expect(connections.isOnline(transport, 101)).toBe(false)
  })

  it('prefers healthy USB, falls back to BLE when USB is stale, and recovers after fresh USB status', () => {
    const connections = new BoardConnections()
    connections.receive('usb', handshake, 100)
    connections.receive('ble', handshake, 100)
    expect(connections.commandTransport(101)).toBe('usb')
    connections.receive('ble', frame(status), 3000)
    connections.receive('usb', frame(event), 3100)
    expect(connections.commandTransport(3100)).toBe('ble')
    connections.receive('usb', frame(status), 3101)
    expect(connections.commandTransport(3102)).toBe('usb')
  })

  it('shows each event once across transports while preserving repeated inputs on one transport', () => {
    const connections = new BoardConnections()
    expect(connections.receive('usb', frame(event), 100)).toHaveLength(1)
    expect(connections.receive('ble', frame(event), 101)).toEqual([])
    connections.reset('usb')
    expect(connections.receive('ble', frame(event), 102)).toEqual([])
    expect(connections.receive('ble', frame({ ...event, uptime_ms: 5201 }), 103)).toHaveLength(1)
    expect(connections.receive('ble', frame({ ...event, uptime_ms: 5201 }), 104)).toHaveLength(1)
  })

  it('rejects malformed and incompatible frames without disturbing the healthy transport', () => {
    const connections = new BoardConnections()
    connections.receive('ble', handshake, 100)
    expect(connections.receive('usb', '{bad}\n' + frame({ ...hello, protocol: 1 }) + frame(status), 101)).toHaveLength(1)
    expect(connections.commandTransport(102)).toBe('ble')
    connections.reset()
    expect(connections.current(103)).toBeNull()
  })

  it('keeps the latest compact lights frame per transport', () => {
    const connections = new BoardConnections()
    const lights = { type: 'lights', protocol: 2, uptime_ms: 5100, status_led: 'off', modes: ['off', 'solid', 'flash', 'blink', 'off'] }
    expect(connections.receive('wifi', frame(lights), 100)).toHaveLength(1)
    expect(connections.current(101)?.session.lights).toEqual(lights)
    expect(connections.receive('wifi', frame({ ...lights, uptime_ms: 5101, modes: ['off', 'off', 'off', 'off', 'off'] }), 102)).toHaveLength(1)
    expect(connections.current(103)?.session.lights?.modes).toEqual(['off', 'off', 'off', 'off', 'off'])
    connections.reset('wifi')
    expect(connections.current(104)).toBeNull()
  })

  it('continues receiving over Wi-Fi after both USB and BLE disconnect', () => {
    const connections = new BoardConnections()
    for (const transport of ['usb', 'ble', 'wifi'] as const) connections.receive(transport, handshake, 100)
    connections.reset('usb')
    connections.reset('ble')
    connections.receive('wifi', frame({ ...status, uptime_ms: 10000 }), 5000)
    expect(connections.current(5001)?.transport).toBe('wifi')
    expect(connections.current(5001)?.session.status?.uptime_ms).toBe(10000)
    expect(connections.isOnline('wifi', 5001)).toBe(true)
    // Network configuration commands still require a trusted USB/BLE transport.
    expect(connections.commandTransport(5001)).toBeNull()
  })

  it('requires a Wi-Fi handshake and preserves Wi-Fi when reconnecting USB', () => {
    const connections = new BoardConnections()
    connections.receive('usb', handshake, 100)
    connections.receive('wifi', frame(status), 100)
    expect(connections.isOnline('wifi', 101)).toBe(false)
    connections.receive('wifi', frame(hello), 102)
    connections.reset('usb')
    expect(connections.current(103)?.transport).toBe('wifi')
    connections.receive('usb', handshake, 104)
    expect(connections.current(105)?.transport).toBe('usb')
    expect(connections.isOnline('wifi', 105)).toBe(true)
  })

  it('deduplicates input events across all three transports', () => {
    const connections = new BoardConnections()
    expect(connections.receive('usb', frame(event), 100)).toHaveLength(1)
    expect(connections.receive('ble', frame(event), 101)).toEqual([])
    expect(connections.receive('wifi', frame(event), 102)).toEqual([])
    expect(connections.receive('wifi', frame({ ...event, uptime_ms: 5201 }), 103)).toHaveLength(1)
    expect(connections.receive('ble', frame({ ...event, uptime_ms: 5201 }), 104)).toEqual([])
  })
})
