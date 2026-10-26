import { DeviceRoom } from './device-room'

export interface Env {
  DEVICE_ROOMS: DurableObjectNamespace
  ALLOWED_ORIGINS: string
  PAIRING_SECRET?: string
}

function allowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin')
  if (!origin) return false
  return env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean).includes(origin)
}

function authorized(env: Env, token: string | null): boolean {
  return Boolean(token && env.PAIRING_SECRET && token.length >= 16 && token === env.PAIRING_SECRET)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'easyinput-gateway' })
    if (url.pathname !== '/ws' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('EasyInput gateway', { status: 200 })
    const deviceId = url.searchParams.get('device')?.trim()
    const role = url.searchParams.get('role')
    const token = url.searchParams.get('token')
    if (!deviceId || !/^[A-Za-z0-9_-]{3,64}$/.test(deviceId) || !['board', 'browser'].includes(role ?? '') || !authorized(env, token)) return new Response('Invalid device session', { status: 401 })
    if (role === 'browser' && !allowedOrigin(request, env)) return new Response('Origin not allowed', { status: 403 })
    const id = env.DEVICE_ROOMS.idFromName(deviceId)
    return env.DEVICE_ROOMS.get(id).fetch(new Request(`https://room.internal/ws?role=${role}`, request))
  },
}

export { DeviceRoom }
