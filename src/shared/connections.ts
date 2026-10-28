import { parseBoardMessage } from './protocol'
import type { BoardHello, BoardLights, BoardMessage, BoardStatus, InputEvent } from './protocol'

export type BoardTransport = 'usb' | 'ble' | 'wifi'

const TRANSPORTS: BoardTransport[] = ['usb', 'ble', 'wifi']

interface BoardSession {
  buffer: string
  hello: BoardHello | null
  status: BoardStatus | null
  lights: BoardLights | null
  lastSeenAt: number | null
  lastStatusAt: number | null
}

function emptySession(): BoardSession {
  return { buffer: '', hello: null, status: null, lights: null, lastSeenAt: null, lastStatusAt: null }
}

export class BoardConnections {
  private sessions: Record<BoardTransport, BoardSession> = { usb: emptySession(), ble: emptySession(), wifi: emptySession() }
  private recentEvents = new Map<string, { transport: BoardTransport; receivedAt: number }>()

  reset(transport?: BoardTransport): void {
    if (transport) {
      this.sessions[transport] = emptySession()
    } else {
      this.sessions = { usb: emptySession(), ble: emptySession(), wifi: emptySession() }
      this.recentEvents.clear()
    }
  }

  isOnline(transport: BoardTransport, now: number): boolean {
    const session = this.sessions[transport]
    return Boolean(session.hello && session.status && session.lastStatusAt !== null && now - session.lastStatusAt < 3000)
  }

  commandTransport(now: number): BoardTransport | null {
    if (this.isOnline('usb', now)) return 'usb'
    if (this.isOnline('ble', now)) return 'ble'
    return null
  }

  current(now: number): { transport: BoardTransport; session: Readonly<BoardSession> } | null {
    const transport = TRANSPORTS.find((candidate) => this.isOnline(candidate, now))
      ?? TRANSPORTS.find((candidate) => this.sessions[candidate].status)
      ?? TRANSPORTS.find((candidate) => this.sessions[candidate].hello)
      ?? TRANSPORTS.find((candidate) => this.sessions[candidate].lights)
    return transport ? { transport, session: this.sessions[transport] } : null
  }

  receive(transport: BoardTransport, text: string, now: number): BoardMessage[] {
    const session = this.sessions[transport]
    const lines = (session.buffer + text).split(/\r?\n/)
    const remainder = lines.pop() ?? ''
    session.buffer = remainder.length <= 32768 ? remainder : ''
    const messages: BoardMessage[] = []
    for (const line of lines) {
      const message = parseBoardMessage(line.trim())
      if (!message) continue
      session.lastSeenAt = now
      if (message.type === 'hello') session.hello = message
      if (message.type === 'status') {
        session.status = message
        session.lastStatusAt = now
      }
      if (message.type === 'lights') session.lights = message
      if (message.type !== 'event' || this.acceptEvent(transport, message, now)) messages.push(message)
    }
    return messages
  }

  private acceptEvent(transport: BoardTransport, event: InputEvent, now: number): boolean {
    const key = JSON.stringify([event.protocol, event.uptime_ms, event.source, event.action, event.key, event.delta, event.rms, event.vad])
    const previous = this.recentEvents.get(key)
    if (previous && previous.transport !== transport && now - previous.receivedAt < 10000) return false
    this.recentEvents.delete(key)
    this.recentEvents.set(key, { transport, receivedAt: now })
    if (this.recentEvents.size > 160) {
      const oldest = this.recentEvents.keys().next().value
      if (oldest !== undefined) this.recentEvents.delete(oldest)
    }
    return true
  }
}
