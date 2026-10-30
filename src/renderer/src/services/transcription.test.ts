import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MandarinRecorder, retryTranscription } from './transcription'

class Socket {
  static instances: Socket[] = []
  static OPEN = 1
  readyState = 1
  bufferedAmount = 0
  frames: Array<string | Uint8Array> = []
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) { Socket.instances.push(this) }
  send(value: string | Uint8Array): void { this.frames.push(value) }
  close(): void { this.readyState = 3; this.onclose?.() }
  receive(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }) }
}
const connection = { gateway: 'wss://example.test', device: 'room', identity: { id: 'client', name: '电脑' } }
beforeEach(() => { Socket.instances = []; vi.stubGlobal('WebSocket', Socket) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('retries with the original ID, paces raw packets, and only succeeds after cloud save', async () => {
  vi.useFakeTimers()
  const draft = { id: 'stable-session', packets: [new Uint8Array([1]), new Uint8Array([2])] }
  let resolved = false
  const result = retryTranscription(connection, draft).then(() => { resolved = true })
  const socket = Socket.instances[0]
  expect(new URL(socket.url).searchParams.get('id')).toBe(draft.id)
  socket.receive({ type: 'ready' }); await vi.advanceTimersByTimeAsync(0)
  expect(socket.frames).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(60); expect(socket.frames).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(60)
  expect(JSON.parse(socket.frames[2] as string)).toEqual({ type: 'stop' })
  expect(resolved).toBe(false)
  socket.receive({ type: 'done' }); await result
  expect(resolved).toBe(true)
})
it('does not replay audio when the stable ID has already committed', async () => {
  const result = retryTranscription(connection, { id: 'committed', packets: [new Uint8Array([1])] })
  Socket.instances[0].receive({ type: 'done' }); await result
  expect(Socket.instances[0].frames).toEqual([])
})
it('surfaces activation and aborts a pending handshake', async () => {
  const result = retryTranscription(connection, { id: 'new-session', packets: [] })
  Socket.instances[0].receive({ type: 'error', message: '请绑定网页设备，验证码：123456' })
  await expect(result).rejects.toThrow('123456')
  const abort = new AbortController()
  const cancelled = retryTranscription(connection, { id: 'cancelled', packets: [] }, abort.signal)
  abort.abort(); await expect(cancelled).rejects.toThrow('取消')
  expect(Socket.instances[1].readyState).toBe(3)
})
it('checks encoding support before requesting the microphone or cloud connection', async () => {
  vi.stubGlobal('AudioEncoder', undefined)
  const complete = vi.fn(), recorder = new MandarinRecorder(connection, complete, vi.fn(), vi.fn())
  await expect(recorder.start()).rejects.toThrow('WebCodecs')
  expect(Socket.instances).toHaveLength(0)
  expect(complete).not.toHaveBeenCalled()
})
it('releases late microphone permission when the cloud fails while permission is pending', async () => {
  vi.stubGlobal('AudioEncoder', class { static isConfigSupported = async () => ({ supported: true }) })
  vi.stubGlobal('AudioData', class {})
  const track = { stop: vi.fn() }
  let permit!: (stream: unknown) => void
  const getUserMedia = vi.fn(() => new Promise(resolve => { permit = resolve }))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  const context = vi.fn(); vi.stubGlobal('AudioContext', context)
  const complete = vi.fn(), recorder = new MandarinRecorder(connection, complete, vi.fn(), vi.fn())
  const started = recorder.start()
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1))
  Socket.instances[0].receive({ type: 'ready' })
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())
  Socket.instances[0].receive({ type: 'error', message: '连接中断' })
  await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
  permit({ getTracks: () => [track] }); await started
  expect(track.stop).toHaveBeenCalledOnce()
  expect(context).not.toHaveBeenCalled()
  recorder.dispose()
})
it('waits for cloud readiness, releases the microphone at stop, and flushes before the final control frame', async () => {
  const track = { stop: vi.fn() }, getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }))
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  let encoderOutput!: (chunk: { byteLength: number; copyTo(bytes: Uint8Array): void }) => void
  const flushed = vi.fn(async () => {})
  vi.stubGlobal('AudioEncoder', class {
    static isConfigSupported = async () => ({ supported: true })
    state = 'configured'; encodeQueueSize = 0
    constructor(options: { output: typeof encoderOutput }) { encoderOutput = options.output }
    configure() {}
    encode() { encoderOutput({ byteLength: 2, copyTo: bytes => bytes.set([1, 2]) }) }
    flush = flushed
    close() { this.state = 'closed' }
  })
  vi.stubGlobal('AudioData', class { close() {} })
  vi.stubGlobal('AudioContext', class {
    sampleRate = 16000; destination = {}; audioWorklet = { addModule: async () => {} }
    createMediaStreamSource() { return { connect() {} } }
    async resume() {}
    async close() {}
  })
  let worklet!: { port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: ReturnType<typeof vi.fn> } }
  vi.stubGlobal('AudioWorkletNode', class {
    port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn() }
    constructor() { worklet = this }
    connect() {}
    disconnect() {}
  })
  const complete = vi.fn(), recognizing = vi.fn(), recorder = new MandarinRecorder(connection, complete, vi.fn(), recognizing)
  const started = recorder.start()
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1))
  expect(getUserMedia).not.toHaveBeenCalled()
  const socket = Socket.instances[0]; socket.receive({ type: 'ready' }); await started
  worklet.port.onmessage?.({ data: new Float32Array(960) })
  recorder.stop(); expect(track.stop).toHaveBeenCalled(); expect(recognizing).toHaveBeenCalled()
  worklet.port.onmessage?.({ data: 'done' })
  await vi.waitFor(() => expect(socket.frames).toHaveLength(2))
  expect(flushed).toHaveBeenCalledOnce()
  expect(JSON.parse(socket.frames[1] as string)).toEqual({ type: 'stop' })
  expect(complete).not.toHaveBeenCalled()
  socket.receive({ type: 'done' })
  await vi.waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith(undefined, undefined))
  recorder.dispose()
})
