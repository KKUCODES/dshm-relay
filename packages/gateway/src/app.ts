import Fastify, { type FastifyRequest } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { z } from 'zod'
import { labelSchema, tokenSchema, MAX_FRAME_BYTES, REMOTE_TRANSPORT_VERSION } from '@dsh-mobile/protocol'
import { authorization, equalSecret, verifyProof } from './auth.js'
import { ApiError, type Store } from './store.js'
import { Tickets } from './tickets.js'
import { Hub } from './hub.js'
import { registrationConfigSchema } from './registration-config.js'

export interface GatewayOptions {
  store: Store
  publicOrigin: string
  enrollmentToken?: string
  registrationMode?: 'open' | 'private'
  /** 兼容旧调用；HTTP 与 HTTPS 均允许，此项不再生效。 */
  allowInsecureLocalhost?: boolean
  logger?: boolean
  trustProxyHops?: 0 | 1
}
export function validateOrigin(origin: string): string {
  const url = new URL(origin)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN must be an origin')
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PUBLIC_ORIGIN must use HTTP or HTTPS')
  return url.origin
}

export async function buildGateway(options: GatewayOptions) {
  const origin = validateOrigin(options.publicOrigin)
  const registration = registrationConfigSchema.parse(options)
  const store = options.store, tickets = new Tickets()
  const app = Fastify({ bodyLimit: 128 * 1024, requestTimeout: 15000,
    trustProxy: options.trustProxyHops === 1 ? (_address, hop) => hop < 1 : false,
    logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.dpop'] } : false })
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' })
  await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false } })
  const hub = new Hub(store, tickets)
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
    if (request.headers.origin && request.headers.origin !== origin) throw new ApiError(403, 'origin_denied')
  })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ error: error.code })
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request' })
    if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: 'request_rejected' })
    }
    request.log.error({ code: 'internal_error' }, 'Request failed')
    return reply.code(500).send({ error: 'internal_error' })
  })
  const host = (request: FastifyRequest) => store.authenticateHost(authorization(request.headers.authorization, 'Bearer'))
  const device = async (request: FastifyRequest, path: string, allowPending = false) => {
    const token = authorization(request.headers.authorization, 'DPoP')
    const thumb = await verifyProof(store, request.headers.dpop as string | undefined, request.method, origin + path, token)
    return store.authenticateDevice(token, thumb, allowPending)
  }
  app.get('/health', async () => { await store.db.query('SELECT 1'); return { ok: true, protocol: 1 } })
  app.get('/v1/server-info', async () => ({ registrationMode: registration.registrationMode, remoteTransport: REMOTE_TRANSPORT_VERSION }))
  app.post('/v1/hosts', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (registration.registrationMode === 'private') {
      const token = authorization(request.headers.authorization, 'Bearer')
      if (!equalSecret(token, registration.enrollmentToken!)) throw new ApiError(401, 'invalid_enrollment_credential')
    }
    const body = z.object({ name: labelSchema }).strict().parse(request.body)
    return reply.code(201).send(await store.enrollHost(body.name))
  })
  app.post('/v1/host/pairings', async (request, reply) => {
    const hostId = await host(request)
    const body = z.object({ key: tokenSchema }).strict().parse(request.body)
    await store.createPairing(hostId, body.key, 300)
    return reply.code(201).send({ expiresIn: 300 })
  })
  app.post('/v1/pairings/claim', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = z.object({ key: tokenSchema, name: labelSchema }).strict().parse(request.body)
    const thumb = await verifyProof(store, request.headers.dpop as string | undefined, 'POST', origin + '/v1/pairings/claim')
    return reply.code(201).send(await store.claimPairing(body.key, body.name, thumb))
  })
  app.get('/v1/host/devices', async request => ({ devices: await store.listDevices(await host(request)) }))
  app.post('/v1/host/devices/:id/approve', async request => {
    const id = z.object({ id: z.uuid() }).parse(request.params).id
    await store.changeDevice(await host(request), id, 'active')
    return { approved: true }
  })
  app.post('/v1/host/devices/:id/revoke', async request => {
    const id = z.object({ id: z.uuid() }).parse(request.params).id
    await store.changeDevice(await host(request), id, 'revoked')
    tickets.revoke(id)
    hub.revoke(id)
    return { revoked: true }
  })
  app.post('/v1/host/devices/:id/management', async request => {
    const id = z.object({ id: z.uuid() }).parse(request.params).id
    const body = z.object({ enabled: z.boolean() }).strict().parse(request.body)
    await store.setManagement(await host(request), id, body.enabled)
    // 更改权限后重建所有通道，不能让旧 ticket / 在途请求继续沿用旧权限。
    tickets.revoke(id)
    hub.revoke(id, 'permissions_changed')
    return { management: body.enabled }
  })
  app.get('/v1/device', async request => {
    const value = await device(request, '/v1/device', true)
    return { deviceId: value.id, hostId: value.host_id, status: value.status, management: value.management, expiresAt: value.expires_at }
  })
  app.post('/v1/device/ticket', async request => ({ ticket: tickets.mint(await device(request, '/v1/device/ticket')), expiresIn: 30 }))
  const hosts = new WeakMap<FastifyRequest, { id: string; transport: number }>()
  app.get('/v1/host/socket', { websocket: true, preValidation: async request => {
    const id = await host(request)
    const query = z.object({ transport: z.literal('2').optional() }).strict().parse(request.query)
    hosts.set(request, { id, transport: query.transport ? REMOTE_TRANSPORT_VERSION : 1 })
  } }, (socket, request) => {
    const host = hosts.get(request)!
    hub.attachHost(host.id, socket, host.transport)
  })
  app.get('/v1/device/socket', { websocket: true }, socket => hub.attachDevice(socket))
  const cleanup = setInterval(() => { tickets.cleanup(); void store.cleanup().catch(() => app.log.error('Cleanup failed')) }, 300000)
  cleanup.unref()
  app.addHook('preClose', async () => { hub.close() })
  app.addHook('onClose', async () => { clearInterval(cleanup) })
  return app
}
