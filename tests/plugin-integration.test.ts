import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import WebSocket from 'ws'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as connection from '@deepseek-ai/dsh-client-connection'
import { credentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import * as plugin from '../../plugin/src/index.js'
import type { SessionService } from '../../plugin/src/session-adapter.js'
import { Store, secret } from '../packages/gateway/src/store.js'
import { buildGateway } from '../packages/gateway/src/app.js'
import { pgliteDatabase } from './support/database.js'
import { clientKey, proof } from './support/proof.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

test.each(['entered', 'environment', 'open'])('Cordis registers with %s key, pairs a device and sends a prompt through real relay sockets', async credentialSource => {
  const db = new PGlite(); cleanup.push(() => db.close())
  const store = new Store(pgliteDatabase(db)); await store.migrate()
  const enrollment = secret()
  // Proof URL is the configured public origin; actual local listener uses an ephemeral port.
  const publicOrigin = 'http://127.0.0.1:8787'
  const registration = credentialSource === 'open' ? { registrationMode: 'open' as const } : { enrollmentToken: enrollment }
  let gateway = await buildGateway({ store, publicOrigin, ...registration })
  const origin = await gateway.listen({ host: '127.0.0.1', port: 0 }); cleanup.push(() => gateway.close())
  const records = new Map<string, CredentialRecord>()
  const credentials = {
    readRecord: async (key: string) => records.get(key),
    modifyRecord: async (key: string, change: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      const value = await change(records.get(key)); if (value) records.set(key, value); return value
    },
    resolve: async () => credentialSource === 'environment' ? { value: enrollment, source: 'test' } : undefined,
  }
  let admitted: SessionPromptRequest | undefined, admissions = 0
  const sessions: SessionService = {
    list: async () => ({ items: [] }), page: async () => { throw new Error('unused') },
    prompt: async request => { admitted = request; admissions++; return { accepted: true } },
    cancel: () => ({ accepted: true }), async *follow() {}, async *control() { yield { type: 'baseline', value: { jobs: {}, projections: {} } } },
  }
  // 凭据存储与 Agent 是明确的测试边界；Cordis、dsh Connection、插件和公网服务均运行实际代码。
  const ctx = new Context()
  const sessionFiber = ctx.plugin(SessionStore); await sessionFiber.await(); cleanup.push(() => sessionFiber.dispose())
  ctx.provide('credentials', credentials); ctx.provide('sessionController', sessions)
  ctx.provide('attachments', { imageLimits: { maxMessageImageBytes: 1024 }, async *readFileStream() { throw new Error('unused') } })
  // 业务 RPC 服务是测试边界；结束事件另外使用下面的真实 SessionStore 发布。
  ctx.provide('typertGateway', { wireStream: { open: async function* () {}, failure: () => ({ code: 'unused', message: '', details: {} }) } })
  ctx.provide('clientModules', { graph: () => ({ rev: 'test', entries: [], batches: [] }), onGraphChanged: () => () => {}, fetchBundle: async () => new Response(null, { status: 404 }) })
  const connectionFiber = ctx.plugin(connection); await connectionFiber.await(); cleanup.push(() => connectionFiber.dispose())
  const fiber = ctx.plugin(plugin, {}); await fiber.await(); cleanup.push(() => fiber.dispose())
  const route = ctx.connection.createSharedFetchHandler('/api')
  expect(ctx.connection.requestRejection({ headers: { host: 'localhost' } })).toBe(401)
  expect(ctx.connection.requestRejection({ headers: { host: 'localhost', origin: 'https://attacker.example' } })).toBe(403)
  const manage = async (action?: unknown) => {
    const response = await route.fetch(new Request('http://localhost/api/dsh-mobile', { method: action ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' }, body: action ? JSON.stringify(action) : undefined }))
    expect(response.status).toBe(200); return response.json()
  }
  expect(await manage()).toMatchObject({ configured: false })
  expect(await manage({ action: 'server-info', origin })).toEqual({ registrationMode: credentialSource === 'open' ? 'open' : 'private' })
  expect(await manage({ action: 'setup', origin, name: 'My PC', ...(credentialSource === 'entered' ? { enrollmentToken: enrollment } : {}) })).toEqual({ configured: true })
  const stored = records.get(credentialKey('dsh-mobile', 'host'))
  expect(stored?.kind).toBe('grant')
  expect(JSON.stringify(stored)).not.toContain(enrollment)
  const safeStatus = await manage(); expect(JSON.stringify(safeStatus)).not.toContain('token')
  await manage({ action: 'enable' })
  await expect.poll(async () => (await manage()).connection).toBe('online')
  const pairing = await manage({ action: 'pair' }), key = new URLSearchParams(new URL(pairing.link).hash.slice(1)).get('key')
  expect(new URL(pairing.link).search).toBe('')
  const identity = await clientKey()
  const claim = (await gateway.inject({ method: 'POST', url: '/v1/pairings/claim', payload: { key, name: 'Protocol test client' },
    headers: { dpop: await proof(identity, publicOrigin + '/v1/pairings/claim', 'POST') } })).json()
  expect((await manage()).devices[0].status).toBe('pending')
  await manage({ action: 'approve', deviceId: claim.deviceId })
  const ticket = (await gateway.inject({ method: 'POST', url: '/v1/device/ticket', headers: { authorization: 'DPoP ' + claim.token,
    dpop: await proof(identity, publicOrigin + '/v1/device/ticket', 'POST', claim.token) } })).json().ticket
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/v1/device/socket'); cleanup.push(async () => socket.terminate())
  await once(socket, 'open')
  const ready = once(socket, 'message'); socket.send(JSON.stringify({ type: 'authenticate', ticket })); await ready
  const id = randomUUID(), response = once(socket, 'message')
  socket.send(JSON.stringify({ type: 'request', id, operation: { method: 'session.prompt', sessionId: 'existing-session', requestId: id, mode: 'queue', text: '继续聊天' } }))
  expect(JSON.parse((await response)[0].toString())).toEqual({ type: 'result', id, value: { accepted: true } })
  expect(admitted).toMatchObject({ sessionId: 'existing-session', requestId: id, content: [{ type: 'text', text: '继续聊天' }] })
  const logged = ctx.sessions.create(SessionId('notification-integration'))
  logged.append('turn/start', { turn: 1 })
  logged.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const taskId = randomUUID(), taskReady = once(socket, 'message')
  socket.send(JSON.stringify({ type: 'request', id: taskId, operation: { method: 'remote.taskFollow' } }))
  expect(JSON.parse((await taskReady)[0].toString())).toMatchObject({ type: 'event', id: taskId, value: { type: 'ready' } })
  const taskEvent = once(socket, 'message')
  logged.append('turn/start', { turn: 2 })
  logged.append('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  logged.append('turn/start', { turn: 3 })
  const ended = logged.append('turn/end', { turn: 3, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'NOT_FOR_NOTIFICATION' } } })
  expect(JSON.parse((await taskEvent)[0].toString())).toEqual({ type: 'event', id: taskId,
    value: { type: 'outcome', sessionId: logged.id, seq: ended.seq, time: ended.time, turn: 3, reason: 'error' } })
  const taskEnd = once(socket, 'message')
  socket.send(JSON.stringify({ type: 'cancel', id: taskId }))
  expect(JSON.parse((await taskEnd)[0].toString())).toEqual({ type: 'end', id: taskId })
  await gateway.close()
  gateway = await buildGateway({ store, publicOrigin, ...registration })
  await gateway.listen({ host: '127.0.0.1', port: Number(new URL(origin).port) })
  await expect.poll(async () => (await manage()).connection, { timeout: 10000 }).toBe('online')
  expect(admissions).toBe(1)
  await fiber.dispose()
  const automaticallyResumed = ctx.plugin(plugin, {}); await automaticallyResumed.await()
  cleanup.push(() => automaticallyResumed.dispose())
  await expect.poll(async () => (await manage()).connection, { timeout: 10000 }).toBe('online')
  await manage({ action: 'disable' }); expect((await manage()).connection).toBe('disabled')
  await automaticallyResumed.dispose()
  expect((await route.fetch(new Request('http://localhost/api/dsh-mobile'))).status).toBe(404)
  const reloaded = ctx.plugin(plugin, {}); await reloaded.await(); cleanup.push(() => reloaded.dispose())
  expect(await manage()).toMatchObject({ configured: true, enabled: false, connection: 'disabled' })
})
