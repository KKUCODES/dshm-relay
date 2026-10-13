import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, expect, test } from 'vitest'
import WebSocket from 'ws'
import { PGlite } from '@electric-sql/pglite'
import { buildGateway } from '../packages/gateway/src/app.js'
import { Store, secret } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'
import { clientKey, proof } from './support/proof.js'

const disposers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const dispose of disposers.reverse()) await dispose(); disposers.length = 0 })
function next(socket: WebSocket): Promise<any> {
  return once(socket, 'message').then(([data]) => JSON.parse(data.toString()))
}
test('real sockets route only to the owning host, preserve ids, and disconnect revoked devices', async () => {
  const db = pgliteDatabase(new PGlite()); disposers.push(() => db.close())
  const store = new Store(db); await store.migrate()
  const origin = 'http://127.0.0.1:8787'
  const app = await buildGateway({ store, publicOrigin: origin, enrollmentToken: secret(), allowInsecureLocalhost: true })
  const address = await app.listen({ host: '127.0.0.1', port: 0 }); disposers.push(() => app.close())
  const host = await store.enrollHost('PC'), other = await store.enrollHost('Other')
  const key = secret(), who = await clientKey()
  await store.createPairing(host.id, key, 300)
  const claimed = await app.inject({ method: 'POST', url: '/v1/pairings/claim', headers: {
    dpop: await proof(who, origin + '/v1/pairings/claim', 'POST') }, payload: { key, name: 'test' } })
  const binding = claimed.json(); await store.changeDevice(host.id, binding.deviceId, 'active')
  const ticket = (await app.inject({ method: 'POST', url: '/v1/device/ticket', headers: {
    authorization: 'DPoP ' + binding.token,
    dpop: await proof(who, origin + '/v1/device/ticket', 'POST', binding.token) } })).json().ticket
  const connect = async (path: string, token?: string) => {
    const ws = new WebSocket(address.replace('http:', 'ws:') + path, { headers: token ? { authorization: 'Bearer ' + token } : {} })
    disposers.push(async () => ws.terminate()); await once(ws, 'open'); return ws
  }
  const desktop = await connect('/v1/host/socket', host.token), stranger = await connect('/v1/host/socket', other.token)
  const phone = await connect('/v1/device/socket')
  const ready = next(phone); phone.send(JSON.stringify({ type: 'authenticate', ticket })); expect(await ready).toMatchObject({ type: 'ready' })
  const replaySocket = await connect('/v1/device/socket'), replayClosed = once(replaySocket, 'close')
  replaySocket.send(JSON.stringify({ type: 'authenticate', ticket })); expect((await replayClosed)[0]).toBe(1008)
  const requestId = randomUUID(), routed = next(desktop), result = next(phone)
  phone.send(JSON.stringify({ type: 'request', id: requestId, operation: { method: 'session.list' } }))
  const request = await routed; expect(request.id).not.toBe(requestId)
  stranger.send(JSON.stringify({ type: 'result', id: request.id, value: 'must not leak' }))
  desktop.send(JSON.stringify({ type: 'result', id: request.id, value: { items: ['existing-session'] } }))
  expect(await result).toEqual({ type: 'result', id: requestId, value: { items: ['existing-session'] } })
  const mutationId = randomUUID(), forwarded = next(desktop), uncertain = next(phone)
  phone.send(JSON.stringify({ type: 'request', id: mutationId, operation: { method: 'session.prompt', sessionId: 'existing-session', requestId: mutationId, mode: 'queue', text: 'continue' } }))
  await forwarded; desktop.close()
  expect(await uncertain).toEqual({ type: 'error', id: mutationId, code: 'host_disconnected_outcome_unknown' })
  const offline = next(phone), offlineId = randomUUID()
  phone.send(JSON.stringify({ type: 'request', id: offlineId, operation: { method: 'session.list' } }))
  expect(await offline).toEqual({ type: 'error', id: offlineId, code: 'host_offline' })
  const restored = await connect('/v1/host/socket', host.token), stream = next(restored)
  phone.send(JSON.stringify({ type: 'request', id: randomUUID(), operation: { method: 'session.control' } }))
  const streamRequest = await stream, cancelled = next(restored), closed = once(phone, 'close')
  const revoked = await app.inject({ method: 'POST', url: `/v1/host/devices/${binding.deviceId}/revoke`, headers: { authorization: 'Bearer ' + host.token } })
  expect(revoked.statusCode).toBe(200)
  expect(await cancelled).toEqual({ type: 'cancel', id: streamRequest.id })
  await closed
})
