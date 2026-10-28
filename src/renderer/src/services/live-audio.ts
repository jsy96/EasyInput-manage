import { AUDIO_RATE, REALTIME_SAMPLE_RATE, decodeMulaw, fromBase64 } from '@shared/chat'

const TARGET_BUFFER_SECONDS = 0.06
const MAX_BUFFER_SECONDS = 0.25

export class LiveVoicePlayer {
  private context: AudioContext | null = null
  private nextAt = 0
  private sources = new Set<AudioBufferSourceNode>()
  private lastSequence: number | null = null

  async start(): Promise<void> {
    if (!this.context) this.context = new AudioContext({ latencyHint: 'interactive' })
    await this.context.resume()
    this.stopSources()
    this.lastSequence = null
    this.nextAt = this.context.currentTime + TARGET_BUFFER_SECONDS
  }

  async pushPcm16(sequence: number, samples: Int16Array): Promise<void> {
    if (this.lastSequence !== null && sequence <= this.lastSequence) return
    this.lastSequence = sequence
    await this.schedule(samples, REALTIME_SAMPLE_RATE)
  }

  /** Compatibility path for an older board that still sends JSON mu-law chunks. */
  async push(data: string): Promise<void> {
    const bytes = fromBase64(data)
    if (!bytes.length) return
    const samples = new Int16Array(bytes.length)
    for (let index = 0; index < bytes.length; index++) samples[index] = decodeMulaw(bytes[index])
    await this.schedule(samples, AUDIO_RATE)
  }

  private async schedule(samples: Int16Array, sampleRate: number): Promise<void> {
    if (!samples.length) return
    if (!this.context) await this.start()
    const context = this.context
    if (!context) return
    const now = context.currentTime
    if (this.nextAt <= now || this.nextAt - now > MAX_BUFFER_SECONDS) {
      this.stopSources()
      this.nextAt = now + TARGET_BUFFER_SECONDS
    }

    const audio = context.createBuffer(1, samples.length, sampleRate)
    const output = audio.getChannelData(0)
    const fadeSamples = Math.min(samples.length, Math.ceil(sampleRate * 0.001))
    for (let index = 0; index < samples.length; index++) {
      const fadeIn = Math.min(1, index / fadeSamples)
      const fadeOut = Math.min(1, (samples.length - 1 - index) / fadeSamples)
      output[index] = samples[index] / 32768 * Math.min(fadeIn, fadeOut)
    }

    const source = context.createBufferSource()
    source.buffer = audio
    source.connect(context.destination)
    source.start(this.nextAt)
    this.nextAt += samples.length / sampleRate
    this.sources.add(source)
    source.onended = () => this.sources.delete(source)
  }

  private stopSources(): void {
    for (const source of this.sources) {
      try { source.stop() } catch { /* already stopped */ }
    }
    this.sources.clear()
  }

  stop(): void {
    this.stopSources()
    this.nextAt = 0
    this.lastSequence = null
  }

  dispose(): void {
    this.stop()
    void this.context?.close()
    this.context = null
  }
}
