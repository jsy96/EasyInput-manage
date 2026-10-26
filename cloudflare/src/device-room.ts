export const PROTOCOL_VERSION = 2
export type SessionRole = 'board' | 'browser'

export class DeviceRoom {
  private readonly state: DurableObjectState
  constructor(state: DurableObjectState) { this.state = state }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 })
    const role = new URL(request.url).searchParams.get('role') as SessionRole | null
    if (!role || !['board', 'browser'].includes(role)) return new Response('Invalid role', { status: 400 })
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.state.acceptWebSocket(server)
    server.serializeAttachment({ role })
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string' || message.length > 32768) return
    const role = (socket.deserializeAttachment() as { role?: SessionRole } | null)?.role
    if (!role) return
    if (role === 'browser') {
      try {
        const value = JSON.parse(message) as { type?: string; protocol?: number; action?: string }
        if (value.type !== 'command' || value.protocol !== PROTOCOL_VERSION || !['hello.get', 'status.get'].includes(value.action ?? '')) return
      } catch { return }
    } else {
      try {
        const value = JSON.parse(message) as { type?: string; protocol?: number }
        if (value.protocol !== PROTOCOL_VERSION || !['hello', 'status', 'event', 'result'].includes(value.type ?? '')) return
      } catch { return }
    }
    for (const peer of this.state.getWebSockets()) {
      const peerRole = (peer.deserializeAttachment() as { role?: SessionRole } | null)?.role
      if (peer !== socket && peerRole && peerRole !== role && peer.readyState === WebSocket.OPEN) peer.send(message)
    }
  }

  webSocketClose(_socket: WebSocket): void {}
  webSocketError(_socket: WebSocket): void {}
}
