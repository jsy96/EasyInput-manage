import { AUDIO_LIMIT, AUDIO_RATE, VOICE_SAMPLES_MAX, decodeMulaw, encodeMulaw } from '@shared/chat'

export function captureSampleLimit(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Invalid audio sample rate')
  return Math.floor(sampleRate * AUDIO_LIMIT / AUDIO_RATE)
}
export function resample(samples: Float32Array, rate: number): Uint8Array {
  const length = Math.min(AUDIO_LIMIT, Math.floor(samples.length * AUDIO_RATE / rate))
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * rate / AUDIO_RATE), end = Math.max(start + 1, Math.floor((i + 1) * rate / AUDIO_RATE))
    let sum = 0
    for (let j = start; j < end && j < samples.length; j++) sum += samples[j]
    out[i] = encodeMulaw(sum / (end - start) * 32767)
  }
  return out
}
function wavHeader(samples: number): ArrayBuffer {
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > VOICE_SAMPLES_MAX) throw new Error('语音长度超出 WAV 格式范围')
  const data = new ArrayBuffer(44), v = new DataView(data)
  const str = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, AUDIO_RATE, true)
  v.setUint32(28, AUDIO_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples * 2, true)
  return data
}
function pcmPart(bytes: Uint8Array): ArrayBuffer {
  const data = new ArrayBuffer(bytes.length * 2), view = new DataView(data)
  bytes.forEach((b, i) => view.setInt16(i * 2, decodeMulaw(b), true))
  return data
}
export function voiceWav(bytes: Uint8Array): Blob {
  return new Blob([wavHeader(bytes.length), pcmPart(bytes)], { type: 'audio/wav' })
}
/** Blob parts avoid a contiguous allocation of the entire long PCM recording. */
export async function voiceWavChunks(chunks: AsyncIterable<Uint8Array>, samples: number, active = () => true): Promise<Blob> {
  const parts: BlobPart[] = [wavHeader(samples)]
  let received = 0
  for await (const bytes of chunks) {
    if (!active()) throw new Error('语音加载已取消')
    received += bytes.length
    if (received > samples) throw new Error('语音长度异常')
    parts.push(new Blob([pcmPart(bytes)]))
  }
  if (received !== samples) throw new Error('语音尾部不完整')
  return new Blob(parts, { type: 'audio/wav' })
}

/** Schedule bounded PCM blocks; keep only a few seconds decoded at once. */
export class VoiceSequencePlayer {
  private generation = 0
  private context: AudioContext | null = null
  private sources = new Map<AudioBufferSourceNode, () => void>()
  stop(): void {
    this.generation++
    for (const [source, done] of this.sources) { source.stop(); done() }
    this.sources.clear()
    if (this.context) void this.context.close().catch(() => undefined)
    this.context = null
  }
  async play<T>(items: T[] | Promise<T[]>, load: (item: T) => Promise<Uint8Array> | AsyncIterable<Uint8Array>, changed: (item: T, index: number) => void): Promise<void> {
    this.stop()
    const generation = this.generation, context = this.context = new AudioContext()
    const active = (): boolean => generation === this.generation
    try {
      await context.resume()
      items = await items
      for (let index = 0; index < items.length; index++) {
        if (!active()) return
        changed(items[index], index)
        const loaded = load(items[index])
        const chunks = Symbol.asyncIterator in loaded ? loaded as AsyncIterable<Uint8Array> : (async function* () { yield await loaded as Uint8Array })()
        const pending = new Set<Promise<void>>()
        let nextAt = context.currentTime ?? 0
        for await (const bytes of chunks) {
          for (let offset = 0; offset < bytes.length; offset += 8192) {
            if (!active()) return
            while (pending.size >= 3) { await Promise.race(pending); if (!active()) return }
            const part = bytes.subarray(offset, offset + 8192)
            const buffer = context.createBuffer(1, part.length, AUDIO_RATE), pcm = buffer.getChannelData(0)
            part.forEach((byte, i) => { pcm[i] = decodeMulaw(byte) / 32768 })
            const source = context.createBufferSource()
            source.buffer = buffer; source.connect(context.destination)
            let ended!: () => void
            const done = new Promise<void>(resolve => { ended = resolve })
            pending.add(done); this.sources.set(source, ended)
            source.onended = () => { this.sources.delete(source); pending.delete(done); ended() }
            nextAt = Math.max((context.currentTime ?? 0) + 0.03, nextAt)
            source.start(nextAt); nextAt += part.length / AUDIO_RATE
          }
        }
        await Promise.all(pending)
      }
    } catch (error) { if (active()) throw error }
    finally { if (active()) this.stop() }
  }
}
/** Capture PCM in an AudioWorklet so the twenty-second cutoff does not depend on a foreground tab. */
export class VoiceRecorder {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private parts: Float32Array[] = []
  private frames = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private starting = false
  private url: string | null = null
  constructor(private readonly complete: (bytes: Uint8Array) => void, private readonly changed: (seconds: number) => void) {}
  async start(): Promise<void> {
    if (this.starting || this.context) return
    this.starting = true; this.stopped = false
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      if (this.stopped) { this.dispose(); return }
      const context = this.context = new AudioContext()
      const source = context.createMediaStreamSource(this.stream)
      const sampleLimit = captureSampleLimit(context.sampleRate)
      const code = `class Capture extends AudioWorkletProcessor { constructor(){super();this.frames=0;this.done=false;} process(inputs){const a=inputs[0]?.[0];if(a&&!this.done){const n=Math.min(a.length,${sampleLimit}-this.frames);this.port.postMessage(a.slice(0,n));this.frames+=n;if(this.frames>=${sampleLimit}){this.done=true;this.port.postMessage('done');}}return !this.done;}} registerProcessor('voice-capture',Capture);`
      this.url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
      await context.audioWorklet.addModule(this.url)
      if (this.stopped) { this.dispose(); return }
      const node = this.node = new AudioWorkletNode(context, 'voice-capture')
      this.parts = []; this.frames = 0
      node.port.onmessage = (event: MessageEvent<Float32Array | string>) => {
        if (event.data === 'done') { this.stop(); return }
        if (!(event.data instanceof Float32Array) || this.stopped) return
        this.parts.push(event.data); this.frames += event.data.length
        this.changed(Math.min(20, this.frames / context.sampleRate))
      }
      source.connect(node); node.connect(context.destination)
      await context.resume()
      this.timer = setTimeout(() => this.stop(), 20000)
    } catch (error) { this.dispose(); throw error } finally { this.starting = false }
  }
  stop(): void {
    if (this.stopped) return
    if (!this.context) { this.dispose(); this.complete(new Uint8Array()); return }
    this.stopped = true
    const samples = new Float32Array(this.frames); let offset = 0
    for (const part of this.parts) { samples.set(part, offset); offset += part.length }
    const bytes = resample(samples, this.context.sampleRate)
    this.dispose()
    this.complete(bytes)
  }
  dispose(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null; this.node?.disconnect(); this.node = null
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null
    void this.context?.close(); this.context = null
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = null; this.parts = []
  }
}
