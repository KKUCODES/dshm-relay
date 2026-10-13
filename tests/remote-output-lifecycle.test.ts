import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, expect, test } from 'vitest'
import WebSocket from 'ws'
import { PGlite } from '@electric-sql/pglite'
import { buildGateway } from '../packages/gateway/src/app.js'
import { Store, secret } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'
import { clientKey, proof } from './support/proof.js'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const next = (socket: WebSocket) => once(socket, 'message').then(([data]) => JSON.parse(data.toString()))
const output = { method: 'remote.jobOutput', sessionId: 'test', jobId: 'pwsh-test', startedAt: 1,
  generation: randomUUID(), stream: 'stdout', fromByte: 0, maxBytes: 65536 }
const reply = (socket: WebSocket, id: string, text: string) => socket.send(JSON.stringify({ type: 'result', id,
  value: { state: 'available', status: 'completed', data: Buffer.from(text).toString('base64'),
    startOffset: 0, nextOffset: Buffer.byteLength(text), totalBytes: Buffer.byteLength(text), lossy: false } }))

async function fixture() {
  const db = new PGlite(), store = new Store(pgliteDatabase(db)); cleanup.push(() => db.close())
  await store.migrate()
  const publicOrigin = 'http://127.0.0.1:8787'
  const app = await buildGateway({ store, publicOrigin, registrationMode: 'open' })
  const origin = await app.listen({ host: '127.0.0.1', port: 0 }); cleanup.push(() => app.close())
  const host = await store.enrollHost('output-lifecycle-test')
  const connect = async (path: string, token?: string) => {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + path, { headers: token ? { authorization: 'Bearer ' + token } : {} })
    cleanup.push(() => socket.terminate()); await once(socket, 'open'); return socket
  }
  const hostAction = (deviceId: string, action: string, body?: object) => fetch(`${origin}/v1/host/devices/${deviceId}/${action}`, {
    method: 'POST', headers: { authorization: 'Bearer ' + host.token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const pair = async () => {
    const who = await clientKey(), key = secret()
    await store.createPairing(host.id, key, 300)
    const claimed = await fetch(origin + '/v1/pairings/claim', { method: 'POST', headers: {
      'content-type': 'application/json', dpop: await proof(who, publicOrigin + '/v1/pairings/claim', 'POST'),
    }, body: JSON.stringify({ key, name: 'output-test-device' }) })
    expect(claimed.status).toBe(201)
    const binding = await claimed.json() as { deviceId: string; token: string }
    expect((await hostAction(binding.deviceId, 'approve')).status).toBe(200)
    const ticket = () => proof(who, publicOrigin + '/v1/device/ticket', 'POST', binding.token).then(dpop => fetch(origin + '/v1/device/ticket', {
      method: 'POST', headers: { authorization: 'DPoP ' + binding.token, dpop },
    }))
    const socketWith = async (credential: string) => {
      const socket = await connect('/v1/device/socket'), ready = next(socket)
      socket.send(JSON.stringify({ type: 'authenticate', ticket: credential })); await ready; return socket
    }
    const open = async () => {
      const result = await ticket(); expect(result.status).toBe(200)
      return socketWith((await result.json() as { ticket: string }).ticket)
    }
    return { ...binding, ticket, open }
  }
  const desktop = await connect('/v1/host/socket?transport=2', host.token)
  const request = async (phone: WebSocket, id: string, operation: object = output) => {
    const routed = next(desktop)
    phone.send(JSON.stringify({ type: 'request', id, operation })); return routed
  }
  return { desktop, pair, connect, hostAction, request }
}

test('真实HTTP/WS撤销在途独立输出，取消Host请求且不影响另一设备同名请求', async () => {
  const f = await fixture(), first = await f.pair(), second = await f.pair()
  const phone = await first.open(), other = await second.open(), id = randomUUID()
  const old = await f.request(phone, id), valid = await f.request(other, id)
  expect(old.id).not.toBe(valid.id)
  const ticket = await first.ticket(), stale = (await ticket.json() as { ticket: string }).ticket
  const cancelled = next(f.desktop), closed = once(phone, 'close')
  expect((await f.hostAction(first.deviceId, 'revoke')).status).toBe(200)
  expect(await cancelled).toEqual({ type: 'cancel', id: old.id })
  const [code, reason] = await closed
  expect(code).toBe(4003); expect(reason.toString()).toBe('device_revoked')
  const result = next(other)
  reply(f.desktop, old.id, 'REVOKED_PRIVATE_OUTPUT'); reply(f.desktop, valid.id, 'OTHER_DEVICE_OUTPUT')
  expect(await result).toMatchObject({ type: 'result', id, value: { data: Buffer.from('OTHER_DEVICE_OUTPUT').toString('base64') } })
  expect((await first.ticket()).status).toBe(401)
  const replay = await f.connect('/v1/device/socket'), rejected = once(replay, 'close')
  replay.send(JSON.stringify({ type: 'authenticate', ticket: stale })); expect((await rejected)[0]).toBe(1008)
})

test('取消后复用客户端请求标识，迟到输出不能填充新读取', async () => {
  const f = await fixture(), device = await f.pair(), phone = await device.open(), id = randomUUID()
  const old = await f.request(phone, id), cancelled = next(f.desktop), ended = next(phone)
  phone.send(JSON.stringify({ type: 'cancel', id }))
  expect(await cancelled).toEqual({ type: 'cancel', id: old.id })
  expect(await ended).toEqual({ type: 'end', id })
  const fresh = await f.request(phone, id), result = next(phone)
  expect(fresh.id).not.toBe(old.id)
  reply(f.desktop, old.id, 'STALE_OUTPUT'); reply(f.desktop, fresh.id, 'FRESH_OUTPUT')
  expect(await result).toMatchObject({ type: 'result', id, value: { data: Buffer.from('FRESH_OUTPUT').toString('base64') } })
})

test('权限变化取消独立输出，重连重新核验身份且旧响应不能进入新连接', async () => {
  const f = await fixture(), device = await f.pair(), phone = await device.open(), id = randomUUID()
  const old = await f.request(phone, id), cancelled = next(f.desktop), closed = once(phone, 'close')
  expect(old.context.management).toBe(false)
  expect((await f.hostAction(device.deviceId, 'management', { enabled: true })).status).toBe(200)
  expect(await cancelled).toEqual({ type: 'cancel', id: old.id })
  const [code, reason] = await closed
  expect(code).toBe(4003); expect(reason.toString()).toBe('permissions_changed')
  const restored = await device.open(), fresh = await f.request(restored, id), result = next(restored)
  expect(fresh.context.management).toBe(true)
  expect(fresh.context.connectionId).not.toBe(old.context.connectionId)
  reply(f.desktop, old.id, 'OLD_CONNECTION_OUTPUT'); reply(f.desktop, fresh.id, 'NEW_CONNECTION_OUTPUT')
  expect(await result).toMatchObject({ type: 'result', id, value: { data: Buffer.from('NEW_CONNECTION_OUTPUT').toString('base64') } })
})

test('前台命令固定协议经过真实HTTP/WS批准通道，撤销终止在途读取且不影响另一设备', async () => {
  const f = await fixture(), device = await f.pair(), otherDevice = await f.pair()
  const phone = await device.open(), other = await otherDevice.open(), id = randomUUID()
  const operation = { method: 'remote.commandOutput', sessionId: 'own', rootCallId: 'root', callId: 'child', rootCallTime: 1,
    generation: randomUUID(), stream: 'stderr', fromByte: 0, maxBytes: 65536 }
  const old = await f.request(phone, id, operation), valid = await f.request(other, id, operation)
  expect(old.operation).toEqual(operation); expect(old.context.management).toBe(false)
  const cancelled = next(f.desktop), closed = once(phone, 'close')
  expect((await f.hostAction(device.deviceId, 'revoke')).status).toBe(200)
  expect(await cancelled).toEqual({ type: 'cancel', id: old.id }); expect((await closed)[0]).toBe(4003)
  const result = next(other)
  reply(f.desktop, old.id, 'REVOKED_COMMAND'); reply(f.desktop, valid.id, 'ACTIVE_COMMAND')
  expect(await result).toMatchObject({ type: 'result', id, value: { data: Buffer.from('ACTIVE_COMMAND').toString('base64') } })
  expect((await device.ticket()).status).toBe(401)
})
