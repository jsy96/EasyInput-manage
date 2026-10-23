import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeWifiAddress, WifiConnection } from './wifi'

const hello = { type: 'hello', protocol: 2, board: 'easyinput-v2', chip: 'ESP32-S3', firmware: '0.1.4', uptime_ms: 5000 }
const status = {
  type: 'status', protocol: 2, uptime_ms: 5000,
  wifi: { state: 'connected', configured: true, ip: '192.168.1.82' }, ble: { state: 'advertising' },
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

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor(readonly url: string) { FakeWebSocket.instances.push(this) }
  message(value: unknown): void { this.onmessage?.({ data: `${JSON.stringify(value)}\n` }) }
}

function setup() {
  const callbacks = {
    connected: vi.fn(), connecting: vi.fn(), retrying: vi.fn(), notice: vi.fn(),
    address: vi.fn(), reset: vi.fn(), text: vi.fn(),
  }
  const connection = new WifiConnection(callbacks)
  connections.push(connection)
  return { connection, callbacks }
}

let connections: WifiConnection[]

beforeEach(() => {
  vi.useFakeTimers()
  connections = []
  FakeWebSocket.instances = []
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  })
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, location: { protocol: 'http:' },
  }))
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  for (const connection of connections) connection.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Wi-Fi monitoring connection', () => {
  it('accepts local IPv4 addresses and rejects URLs, invalid octets and public destinations', () => {
    expect(normalizeWifiAddress(' 192.168.1.82 ')).toBe('192.168.1.82')
    expect(normalizeWifiAddress('10.0.0.1')).toBe('10.0.0.1')
    expect(normalizeWifiAddress('172.31.2.5')).toBe('172.31.2.5')
    for (const value of ['192.168.1.256', '192.168.01.1', 'ws://192.168.1.82/ws', '8.8.8.8', '172.32.1.1', 'localhost', '']) {
      expect(() => normalizeWifiAddress(value)).toThrow()
    }
  })

  it('requires its own hello and status before reporting a connection', () => {
    const { connection, callbacks } = setup()
    connection.connect('192.168.1.82')
    const socket = FakeWebSocket.instances[0]
    expect(socket.url).toBe('ws://192.168.1.82/ws')
    socket.onopen?.()
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: 'command', protocol: 2, action: 'hello.get' })
    expect(callbacks.connected).not.toHaveBeenCalledWith(true)
    socket.message(status)
    expect(callbacks.connected).not.toHaveBeenCalledWith(true)
    socket.message(hello)
    expect(callbacks.connected).toHaveBeenLastCalledWith(true)
    expect(callbacks.text).toHaveBeenCalledTimes(2)
  })

  it('times out a silent socket and reconnects without reopening an old session', () => {
    const { connection, callbacks } = setup()
    connection.connect('192.168.1.82')
    const first = FakeWebSocket.instances[0]
    const lateOpen = first.onopen
    vi.advanceTimersByTime(8000)
    expect(first.close).toHaveBeenCalledOnce()
    expect(callbacks.retrying).toHaveBeenLastCalledWith(true)
    lateOpen?.()
    expect(first.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    const second = FakeWebSocket.instances[1]
    second.message(hello)
    second.message(status)
    expect(callbacks.connected).toHaveBeenLastCalledWith(true)
  })

  it('recovers from stale status even if input events continue arriving', () => {
    const { connection, callbacks } = setup()
    connection.connect('192.168.1.82')
    const socket = FakeWebSocket.instances[0]
    socket.message(hello)
    socket.message(status)
    for (let i = 0; i < 8; i++) {
      socket.message({ type: 'event', protocol: 2, source: 'key', key: 'S1', action: 'down', uptime_ms: i })
      vi.advanceTimersByTime(1000)
    }
    expect(socket.close).toHaveBeenCalledOnce()
    expect(callbacks.connected).toHaveBeenLastCalledWith(false)
    expect(callbacks.reset).toHaveBeenCalled()
  })

  it('times out an incomplete handshake even when status keeps arriving', () => {
    const { connection, callbacks } = setup()
    connection.connect('192.168.1.82')
    const socket = FakeWebSocket.instances[0]
    for (let i = 0; i < 8; i++) {
      socket.message(status)
      vi.advanceTimersByTime(1000)
    }
    expect(socket.close).toHaveBeenCalledOnce()
    expect(callbacks.connected).not.toHaveBeenCalledWith(true)
  })

  it('remembers the learned IP without starting a connection until requested', () => {
    const { connection, callbacks } = setup()
    connection.start()
    connection.rememberAddress('192.168.1.82')
    expect(callbacks.address).toHaveBeenLastCalledWith('192.168.1.82')
    expect(FakeWebSocket.instances).toHaveLength(0)
    const restored = setup()
    restored.connection.start()
    expect(restored.callbacks.address).toHaveBeenCalledWith('192.168.1.82')
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('restores an enabled connection, but deliberate disconnection survives a reload', () => {
    const first = setup()
    first.connection.connect('192.168.1.82')
    first.connection.dispose()
    const restored = setup()
    restored.connection.start()
    expect(FakeWebSocket.instances).toHaveLength(2)
    restored.connection.disconnect()
    vi.advanceTimersByTime(60000)
    const reopened = setup()
    reopened.connection.start()
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(reopened.callbacks.address).toHaveBeenCalledWith('192.168.1.82')
  })

  it('cancels retries when paused for flashing without disabling the saved preference', () => {
    const { connection } = setup()
    connection.connect('192.168.1.82')
    FakeWebSocket.instances[0].onclose?.()
    connection.pause()
    vi.advanceTimersByTime(60000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    const reopened = setup()
    reopened.connection.start()
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('refreshes an outdated saved IP from USB/BLE while waiting to reconnect', () => {
    const { connection } = setup()
    connection.connect('192.168.1.82')
    FakeWebSocket.instances[0].onclose?.()
    connection.rememberAddress('192.168.1.83')
    expect(FakeWebSocket.instances[1].url).toBe('ws://192.168.1.83/ws')
  })

  it('rejects incompatible boards and never marks them connected', () => {
    const { connection, callbacks } = setup()
    connection.connect('192.168.1.82')
    FakeWebSocket.instances[0].message({ ...hello, board: 'other-board' })
    expect(FakeWebSocket.instances[0].close).toHaveBeenCalledOnce()
    expect(callbacks.connected).not.toHaveBeenCalledWith(true)
  })

  it('explains HTTPS limitations without repeatedly retrying a blocked connection', () => {
    window.location.protocol = 'https:'
    const { connection, callbacks } = setup()
    connection.connect('192.168.1.82')
    vi.advanceTimersByTime(60000)
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(callbacks.notice).toHaveBeenLastCalledWith(expect.stringContaining('127.0.0.1'))
  })
})
