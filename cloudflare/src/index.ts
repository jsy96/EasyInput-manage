import { DeviceRoom } from './device-room'
import { CHAT_VERSION } from '../../src/shared/chat'
export interface Env {
  DEVICE_ROOMS: DurableObjectNamespace
  ALLOWED_ORIGINS: string
  PAIRING_SECRET?: string
  PUBLIC_DEVICE_ID?: string
}
function allowedOrigin(request: Request, env: Env): boolean {
  return env.ALLOWED_ORIGINS.split(',').map(v => v.trim()).includes(request.headers.get('Origin') ?? '')
}
function authorized(env: Env, token: string | null): boolean { return Boolean(token && env.PAIRING_SECRET && token.length >= 16 && token === env.PAIRING_SECRET) }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = allowedOrigin(request, env)
    const cors = { 'Access-Control-Allow-Origin': origin ? request.headers.get('Origin')! : 'null', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', Vary: 'Origin' }
    if (request.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: cors })
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'easyinput-gateway', chat: CHAT_VERSION })
    if (url.pathname === '/session' && origin) return Response.json({ device: env.PUBLIC_DEVICE_ID ?? 'easyinput-v2', gateway: url.origin.replace('https:', 'wss:') }, { headers: cors })
    if (url.pathname !== '/ws' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('EasyInput gateway', { status: 200 })
    const device = url.searchParams.get('device')?.trim()
    const role = url.searchParams.get('role')
    const publicRoom = device === (env.PUBLIC_DEVICE_ID ?? 'easyinput-v2')
    if (!device || !/^[A-Za-z0-9_-]{3,64}$/.test(device) || !['board', 'browser'].includes(role ?? '') || !(role === 'browser' && publicRoom || authorized(env, url.searchParams.get('token')))) return new Response('Invalid device session', { status: 401 })
    if (role === 'browser' && !origin) return new Response('Origin not allowed', { status: 403 })
    const room = env.DEVICE_ROOMS.get(env.DEVICE_ROOMS.idFromName(device))
    const target = new URL('https://room.internal/ws')
    for (const key of ['role', 'client', 'name']) target.searchParams.set(key, url.searchParams.get(key) ?? '')
    // Older monitor clients do not supply an identity; keep them usable.
    if (role === 'browser' && !target.searchParams.get('client')) target.searchParams.set('client', crypto.randomUUID())
    return room.fetch(new Request(target.toString(), request))
  },
}
export { DeviceRoom }
