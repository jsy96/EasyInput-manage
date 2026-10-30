import type { ChatConnection } from './chat'

type Connection = Pick<ChatConnection, 'gateway' | 'device' | 'identity'>
export type TranscriptionDraft = { id: string; packets: Uint8Array[] }
const RATE = 16000, FRAME = 960, LIMIT = RATE * 60
const CONFIG: AudioEncoderConfig = { codec: 'opus', sampleRate: RATE, numberOfChannels: 1,
  bitrate: 24000, opus: { format: 'opus', frameDuration: 60000 } }

class TranscriptionSession {
  private socket: WebSocket
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private doneResolve!: () => void
  private doneReject!: (error: Error) => void
  readonly ready: Promise<void>
  readonly done: Promise<void>
  completed = false
  private closed = false
  private readyTimer: ReturnType<typeof setTimeout>
  private tailTimer: ReturnType<typeof setTimeout> | undefined
  constructor(connection: Connection, id: string, recognized?: () => void) {
    const url = new URL(connection.gateway)
    url.pathname = '/asr'; url.search = new URLSearchParams({ role: 'browser', device: connection.device,
      client: connection.identity.id, name: connection.identity.name, id }).toString()
    this.ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    this.done = new Promise<void>((resolve, reject) => { this.doneResolve = resolve; this.doneReject = reject })
    // Start failures can precede the recorder attaching the completion handler.
    void this.done.catch(() => undefined)
    void this.ready.catch(() => undefined)
    this.socket = new WebSocket(url)
    this.readyTimer = setTimeout(() => this.fail(new Error('等待小智转写连接超时，请重试')), 40_000)
    this.socket.onmessage = event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 4096) throw new Error('转写服务响应异常')
        const value = JSON.parse(event.data) as { type: string; message?: string }
        if (value.type === 'ready') { clearTimeout(this.readyTimer); this.readyResolve() }
        else if (value.type === 'recognizing') recognized?.()
        else if (value.type === 'done') {
          this.completed = true; this.closed = true; this.clearTimers(); this.readyResolve(); this.doneResolve(); this.socket.close()
        } else if (value.type === 'error') this.fail(new Error(value.message || '普通话识别失败，请重试'))
      } catch (error) { this.fail(error instanceof Error ? error : new Error('普通话识别失败')) }
    }
    this.socket.onerror = () => this.fail(new Error('普通话识别连接失败，请重试'))
    this.socket.onclose = () => { if (!this.closed) this.fail(new Error('普通话识别连接中断，请重试')) }
  }
  private clearTimers(): void { clearTimeout(this.readyTimer); clearTimeout(this.tailTimer) }
  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true; this.clearTimers(); this.readyReject(error); this.doneReject(error); this.socket.close()
  }
  send(packet: Uint8Array): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error('普通话识别连接已断开')
    if (this.socket.bufferedAmount > 256 * 1024) throw new Error('普通话网络传输过慢，请重试')
    this.socket.send(packet)
  }
  stop(): void {
    if (this.closed) return
    this.socket.send(JSON.stringify({ type: 'stop' }))
    this.tailTimer = setTimeout(() => this.fail(new Error('等待普通话识别结果超时，请重试')), 30_000)
  }
  cancel(): void { this.fail(new Error('普通话识别已取消')) }
}

/** Encode raw 16 kHz Opus, rather than forwarding a WebM/Ogg recording container. */
export class MandarinRecorder {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private encoder: AudioEncoder | null = null
  private session: TranscriptionSession | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private url: string | null = null
  private stopping = false
  private disposed = false
  private reported = false
  private failed = false
  private frames = 0
  private readonly draft: TranscriptionDraft = { id: crypto.randomUUID(), packets: [] }
  constructor(private readonly connection: Connection, private readonly complete: (error?: Error, draft?: TranscriptionDraft) => void,
    private readonly changed: (seconds: number) => void, private readonly recognizing: () => void) {}
  async start(): Promise<void> {
    try {
      if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined' || !(await AudioEncoder.isConfigSupported(CONFIG)).supported) {
        throw new Error('当前浏览器不支持普通话音频编码，请使用支持 WebCodecs 音频的桌面 Chrome 或 Edge')
      }
      this.session = new TranscriptionSession(this.connection, this.draft.id, this.recognizing)
      void this.session.done.then(() => this.report(), error => this.fail(error))
      await this.session.ready
      if (this.disposed || this.failed) return
      if (this.session.completed) { this.report(); return }
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      if (this.disposed || this.failed) { this.closeCapture(); return }
      const context = this.context = new AudioContext({ sampleRate: RATE })
      if (context.sampleRate !== RATE) throw new Error('当前浏览器无法提供普通话识别所需的 16 kHz 音频')
      this.encoder = new AudioEncoder({
        output: chunk => {
          if (this.disposed || this.failed) return
          const packet = new Uint8Array(chunk.byteLength); chunk.copyTo(packet)
          this.draft.packets.push(packet)
          try { this.session!.send(packet) } catch (error) { this.fail(error) }
        },
        error: error => this.fail(error),
      })
      this.encoder.configure(CONFIG)
      const code = `class Capture extends AudioWorkletProcessor {
        constructor(){super();this.frames=0;this.part=new Float32Array(${FRAME});this.used=0;this.done=false;
          this.port.onmessage=e=>{if(e.data==='stop')this.finish();};}
        finish(){if(this.done)return;this.done=true;if(this.used)this.port.postMessage(this.part);this.port.postMessage('done');}
        process(inputs){if(this.done)return false;const data=inputs[0]?.[0];if(data){
          for(let i=0;i<data.length&&this.frames<${LIMIT};i++){this.part[this.used++]=data[i];this.frames++;
            if(this.used===${FRAME}){this.port.postMessage(this.part);this.part=new Float32Array(${FRAME});this.used=0;}}
          this.port.postMessage({frames:this.frames});if(this.frames>=${LIMIT})this.finish();}return !this.done;}}
        registerProcessor('mandarin-capture',Capture);`
      this.url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
      await context.audioWorklet.addModule(this.url)
      if (this.disposed || this.failed) { this.closeCapture(); return }
      const node = this.node = new AudioWorkletNode(context, 'mandarin-capture')
      node.port.onmessage = event => {
        if (this.disposed || this.failed) return
        if (event.data === 'done') { void this.finish(); return }
        if (event.data instanceof Float32Array) {
          try {
            if (this.encoder!.encodeQueueSize > 32) throw new Error('普通话编码处理过慢，请重试')
            const data = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfChannels: 1,
              numberOfFrames: event.data.length, timestamp: this.frames / RATE * 1_000_000, data: new Float32Array(event.data) })
            this.frames += event.data.length; this.encoder!.encode(data); data.close()
          } catch (error) { this.fail(error) }
        } else if (typeof event.data?.frames === 'number') this.changed(Math.min(60, event.data.frames / RATE))
      }
      context.createMediaStreamSource(this.stream).connect(node); node.connect(context.destination)
      await context.resume()
      this.timer = setTimeout(() => this.stop(), 60_000)
    } catch (error) { this.dispose(); throw error }
  }
  stop(): void {
    if (this.disposed || this.stopping) return
    this.stopping = true
    this.stream?.getTracks().forEach(track => track.stop())
    this.recognizing()
    if (this.node) {
      this.node.port.postMessage('stop')
      // Some suspended/background worklets no longer service port messages.
      clearTimeout(this.timer); this.timer = setTimeout(() => { void this.finish() }, 300)
    } else void this.finish()
  }
  private finishing = false
  private async finish(): Promise<void> {
    if (this.finishing || this.disposed) return
    this.finishing = true; this.stopping = true; this.recognizing()
    this.closeCapture()
    try { await this.encoder?.flush(); this.closeEncoder(); this.session!.stop() }
    catch (error) { this.fail(error) }
  }
  private closeCapture(): void {
    clearTimeout(this.timer)
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null }
    void this.context?.close(); this.context = null
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = null
  }
  private report(error?: Error): void {
    if (this.reported || this.disposed) return
    this.reported = true
    this.complete(error, error && this.draft.packets.length ? this.draft : undefined)
  }
  private fail(error: unknown): void {
    if (this.failed || this.disposed) return
    this.failed = true
    const value = error instanceof Error ? error : new Error('普通话识别失败，请重试')
    this.closeCapture(); this.closeEncoder(); this.session?.cancel(); this.report(value)
  }
  private closeEncoder(): void {
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close()
    this.encoder = null
  }
  dispose(): void {
    this.disposed = true; this.closeCapture(); this.closeEncoder(); this.session?.cancel()
  }
}

export async function retryTranscription(connection: Connection, draft: TranscriptionDraft, signal?: AbortSignal): Promise<void> {
  const session = new TranscriptionSession(connection, draft.id)
  const abort = (): void => session.cancel()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    if (signal?.aborted) throw new Error('普通话识别已取消')
    await session.ready
    if (session.completed) return
    // Replays keep real-time pacing; flooding the speech endpoint loses utterances.
    for (const packet of draft.packets) {
      if (signal?.aborted) throw new Error('普通话识别已取消')
      session.send(packet)
      await new Promise<void>(resolve => setTimeout(resolve, 60))
    }
    session.stop(); await session.done
  } finally { signal?.removeEventListener('abort', abort); session.cancel() }
}
