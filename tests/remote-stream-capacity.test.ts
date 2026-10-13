import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, expect, test } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import { PGlite } from '@electric-sql/pglite'
import { buildGateway } from '../packages/gateway/src/app.js'
import { Store, secret } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'
import { clientKey, proof } from './support/proof.js'

const cleanups: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const next = (socket: WebSocket) => once(socket, 'message').then(([data]) => JSON.parse(data.toString()))

test('长期订阅满额仍能下载插件；传输独立限额、取消归还容量、总请求上限保持', async () => {
  const db = new PGlite(), store = new Store(pgliteDatabase(db)); cleanups.push(() => db.close())
  await store.migrate()
  const publicOrigin = 'http://127.0.0.1:8787'
  const app = await buildGateway({ store, publicOrigin, registrationMode: 'open' })
  const origin = await app.listen({ host: '127.0.0.1', port: 0 }); cleanups.push(() => app.close())
  const host = await store.enrollHost('capacity-test'), key = secret(), who = await clientKey()
  await store.createPairing(host.id, key, 300)
  const binding = (await app.inject({ method: 'POST', url: '/v1/pairings/claim', payload: { key, name: 'capacity' },
    headers: { dpop: await proof(who, publicOrigin + '/v1/pairings/claim', 'POST') } })).json()
  await store.changeDevice(host.id, binding.deviceId, 'active')
  const connect = async (path: string, token?: string) => {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + path, { headers: token ? { authorization: 'Bearer ' + token } : {} })
    cleanups.push(() => socket.terminate()); await once(socket, 'open'); return socket
  }
  const desktop = await connect('/v1/host/socket?transport=2', host.token), phone = await connect('/v1/device/socket')
  const ticket = (await app.inject({ method: 'POST', url: '/v1/device/ticket', headers: {
    authorization: 'DPoP ' + binding.token, dpop: await proof(who, publicOrigin + '/v1/device/ticket', 'POST', binding.token),
  } })).json().ticket
  const ready = next(phone); phone.send(JSON.stringify({ type: 'authenticate', ticket })); await ready
  const send = (operation: object) => {
    const id = randomUUID()
    return new Promise<{ id: string; route: boolean; frame: Record<string, any> }>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); desktop.off('message', routed); phone.off('message', rejected) }
      const done = (route: boolean, data: RawData) => { cleanup(); resolve({ id, route, frame: JSON.parse(data.toString()) }) }
      const routed = (data: RawData) => done(true, data), rejected = (data: RawData) => done(false, data)
      const timer = setTimeout(() => { cleanup(); reject(new Error('capacity route timeout')) }, 2000)
      desktop.on('message', routed); phone.on('message', rejected)
      phone.send(JSON.stringify({ type: 'request', id, operation }))
    })
  }
  const watch = { method: 'remote.graphFollow' }
  const subscriptions = []
  for (let i = 0; i < 20; i++) {
    const item = await send(watch)
    expect(item.route).toBe(true); subscriptions.push(item)
  }
  expect((await send(watch)).frame).toMatchObject({ type: 'error', code: 'too_many_streams' })
  // 旁栏关闭释放长期订阅名额，不依赖重建连接。
  const streamCancelled = next(desktop), streamEnded = next(phone)
  phone.send(JSON.stringify({ type: 'cancel', id: subscriptions[0]!.id }))
  expect(await streamCancelled).toEqual({ type: 'cancel', id: subscriptions[0]!.frame.id })
  expect(await streamEnded).toEqual({ type: 'end', id: subscriptions[0]!.id })
  expect((await send(watch)).route).toBe(true)
  expect((await send(watch)).frame.code).toBe('too_many_streams')
  const download = { method: 'remote.resource', verb: 'GET', path: '/plugins/fixture/client.js?rev=test' }
  const first = await send(download)
  expect(first.route, JSON.stringify(first.frame)).toBe(true)
  for (let i = 0; i < 7; i++) expect((await send(download)).route).toBe(true)
  expect((await send(download)).frame).toMatchObject({ type: 'error', code: 'too_many_transfers' })
  const cancelled = next(desktop), ended = next(phone)
  phone.send(JSON.stringify({ type: 'cancel', id: first.id }))
  expect(await cancelled).toEqual({ type: 'cancel', id: first.frame.id })
  expect(await ended).toEqual({ type: 'end', id: first.id })
  const replacement = await send({ method: 'remote.sessionExport', sessionId: 'fixture', includeDescendants: false })
  expect(replacement.route).toBe(true)
  const ack = next(desktop)
  phone.send(JSON.stringify({ type: 'ack', id: replacement.id, count: 1 }))
  expect(await ack).toEqual({ type: 'ack', id: replacement.frame.id, count: 1 })
  expect((await send(watch)).frame.code).toBe('too_many_streams')
  // 20个订阅 + 8个传输 + 4个未返回短请求，仍触达原32个总上限。
  for (let i = 0; i < 4; i++) expect((await send({ method: 'remote.graph' })).route).toBe(true)
  expect((await send({ method: 'remote.graph' })).frame.code).toBe('too_many_requests')
})
