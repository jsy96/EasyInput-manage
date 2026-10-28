import { AUDIO_LIMIT, AUDIO_RATE, decodeMulaw, encodeMulaw } from '@shared/chat'

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
export function voiceWav(bytes: Uint8Array): Blob {
  const data = new ArrayBuffer(44 + bytes.length * 2), v = new DataView(data)
  const str = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, AUDIO_RATE, true)
  v.setUint32(28, AUDIO_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, bytes.length * 2, true)
  bytes.forEach((b, i) => v.setInt16(44 + i * 2, decodeMulaw(b), true))
  return new Blob([data], { type: 'audio/wav' })
}

/** Resume the audio context in the click handler before fetching any clips. */
export class VoiceSequencePlayer {
  private generation = 0
  private context: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private ended: (() => void) | null = null
  stop(): void {
    this.generation++
    this.source?.stop(); this.source = null
    this.ended?.(); this.ended = null
    if (this.context) void this.context.close().catch(() => undefined)
    this.context = null
  }
  async play<T>(items: T[] | Promise<T[]>, load: (item: T) => Promise<Uint8Array>, changed: (item: T, index: number) => void): Promise<void> {
    this.stop()
    const generation = this.generation, context = this.context = new AudioContext()
    try {
      await context.resume()
      items = await items
      for (let index = 0; index < items.length; index++) {
        if (generation !== this.generation) return
        changed(items[index], index)
        const bytes = await load(items[index])
        if (generation !== this.generation) return
        const buffer = context.createBuffer(1, bytes.length, AUDIO_RATE), pcm = buffer.getChannelData(0)
        bytes.forEach((byte, i) => { pcm[i] = decodeMulaw(byte) / 32768 })
        const source = this.source = context.createBufferSource()
        source.buffer = buffer; source.connect(context.destination)
        await new Promise<void>((resolve) => { this.ended = resolve; source.onended = () => resolve(); source.start() })
        this.ended = null; this.source = null
      }
    } catch (error) { if (generation === this.generation) throw error }
    finally { if (generation === this.generation) this.stop() }
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
