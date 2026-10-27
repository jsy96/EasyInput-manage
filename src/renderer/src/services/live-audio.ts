import { AUDIO_RATE, fromBase64 } from '@shared/chat'
import { decodeMulaw } from '@shared/chat'

export class LiveVoicePlayer {
  private context: AudioContext | null = null
  private nextAt = 0
  private sources = new Set<AudioBufferSourceNode>()

  async start(): Promise<void> {
    if (!this.context) this.context = new AudioContext()
    await this.context.resume()
    this.nextAt = this.context.currentTime
  }

  async push(data: string): Promise<void> {
    if (!this.context) await this.start()
    const context = this.context
    if (!context || !data) return
    const bytes = fromBase64(data)
    if (!bytes.length) return
    const audio = context.createBuffer(1, bytes.length, AUDIO_RATE)
    const samples = audio.getChannelData(0)
    for (let index = 0; index < bytes.length; index++) samples[index] = decodeMulaw(bytes[index]) / 32768
    const source = context.createBufferSource()
    source.buffer = audio
    source.connect(context.destination)
    const now = context.currentTime
    if (this.nextAt < now || this.nextAt > now + 1) this.nextAt = now + 0.08
    source.start(this.nextAt)
    this.nextAt += bytes.length / AUDIO_RATE
    this.sources.add(source)
    source.onended = () => this.sources.delete(source)
  }

  stop(): void {
    for (const source of this.sources) {
      try { source.stop() } catch { /* already stopped */ }
    }
    this.sources.clear()
    this.nextAt = 0
  }

  dispose(): void {
    this.stop()
    void this.context?.close()
    this.context = null
  }
}
