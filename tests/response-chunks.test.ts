import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import WebSocket from 'ws'
import { buildGateway } from '../packages/gateway/src/app.js'
import { Store, secret } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'
import { clientKey, proof } from './support/proof.js'
import { Relay } from '../../plugin/src/relay.js'
import type { RemoteServices } from '../../plugin/src/remote-adapter.js'
import type { SessionService } from '../../plugin/src/session-adapter.js'
import { RESPONSE_CHUNK_BYTES } from '../packages/protocol/src/index.js'

// 手机是独立JS工程；通过其正式入口测试跨仓库协议，而非另造一个重组器。
const mobileEntry = '../../dsh-mobile/src/remote-client.mjs'
const { RemoteClient } = await import(mobileEntry)
const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const huge = (marker: string) => ({ records: [{ seq: 1, marker, text: '大响应🙂'.repeat(200000) }] })

async function fixture() {
  const db = pgliteDatabase(new PGlite()); cleanup.push(() => db.close())
  const store = new Store(db); await store.migrate()
  const publicOrigin = 'http://127.0.0.1:8787'
  const gateway = await buildGateway({ store, publicOrigin, enrollmentToken: secret() })
  const origin = await gateway.listen({ host: '127.0.0.1', port: 0 }); cleanup.push(() => gateway.close())
  const host = await store.enrollHost('Chunk Test'), who = await clientKey(), pairing = secret()
  await store.createPairing(host.id, pairing, 300)
  const claim = await gateway.inject({ method: 'POST', url: '/v1/pairings/claim', headers: {
    dpop: await proof(who, publicOrigin + '/v1/pairings/claim', 'POST'),
  }, payload: { key: pairing, name: 'Chunk Test Phone' } })
  expect(claim.statusCode).toBe(201)
  const binding = claim.json(); await store.changeDevice(host.id, binding.deviceId, 'active')
  const input = { page: huge('history'), snapshot: { type: 'snapshot', ...huge('initial') }, live: [] as unknown[], wake: () => {}, followers: 0 }
  // 仅历史数据与DSH业务Gateway是合成边界；配对、鉴权、中转、Relay与手机均为实际代码。
  const services = {
    version: '0.1.6-alpha.2', connection: { createSharedFetchHandler: () => ({ fetch: async (request: Request) => {
      const envelope = await request.json() as { rpcId: string }
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: input.page } })
    } }) },
    gateway: { wireStream: {
      failure: () => ({ code: 'synthetic_failure' }),
      async *open(_endpoint: string, _payload: unknown, signal: AbortSignal) {
        input.followers++
        const abort = () => input.wake(); signal.addEventListener('abort', abort, { once: true })
        try {
          yield input.snapshot
          while (!signal.aborted) {
            const item = input.live.shift()
            if (item !== undefined) yield item
            else await new Promise<void>(done => { input.wake = done; if (signal.aborted) done() })
          }
        } finally { signal.removeEventListener('abort', abort); input.followers-- }
      },
    } },
    modules: { graph: () => ({ entries: [], batches: [], rev: 'test' }), onGraphChanged: () => () => {}, fetchBundle: async () => new Response(null, { status: 404 }) },
  } as unknown as RemoteServices
  const relay = new Relay({} as SessionService, services); cleanup.push(() => relay.stop()); relay.start(origin, host.token, host.id)
  await expect.poll(() => relay.state).toBe('online')
  const phone = async (negotiate = true) => {
    const ticket = (await gateway.inject({ method: 'POST', url: '/v1/device/ticket', headers: {
      authorization: 'DPoP ' + binding.token, dpop: await proof(who, publicOrigin + '/v1/device/ticket', 'POST', binding.token),
    } })).json().ticket
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/v1/device/socket')
    cleanup.push(() => { client.reset(); socket.terminate() }); await once(socket, 'open')
    const sent: any[] = [], wire: any[] = []
    const control = { dropAcks: false }
    const bridge = { onmessage: undefined as any, postMessage(raw: string) {
      const message = JSON.parse(raw), frame = message.data?.frame
      if (frame) {
        sent.push(frame)
        if (!(control.dropAcks && frame.type === 'responseAck')) socket.send(JSON.stringify(frame))
      }
      queueMicrotask(() => bridge.onmessage({ data: JSON.stringify({ id: message.id, data: {} }) }))
    } }
    const client = new RemoteClient(bridge)
    socket.on('message', bytes => { const frame = JSON.parse(bytes.toString()); wire.push(frame); client.receive(frame) })
    socket.on('close', () => client.receive({ type: 'closed' }))
    const ready = new Promise<void>(done => client.subscribe((frame: any) => { if (frame.type === 'ready') done() }))
    socket.send(JSON.stringify({ type: 'authenticate', ticket })); await ready
    if (negotiate) {
      const task = client.request({ method: 'remote.negotiate', version: 2 })
      const result = await task.promise
      client.responseChunksEnabled = client.relayResponseChunks && result.responseChunksVersion === 1
      expect(client.responseChunksEnabled).toBe(true)
    }
    return { client, socket, sent, wire, control }
  }
  return { input, phone, relay, gateway, host, binding, origin, store, emit(value: unknown) { input.live.push(value); input.wake() } }
}

test('生产中转鉴权路由与实际插件/手机传输：大历史页、初始快照、实时大事件完整有序', async () => {
  const f = await fixture(), p = await f.phone()
  const page = p.client.request({ method: 'remote.rpc', endpoint: 'session/page', payload: { args: { request: { address: { kind: 'session', sessionId: 'test' }, throughSeq: 1 } } } })
  expect(await page.promise).toEqual({ ok: true, value: f.input.page })
  const received: unknown[] = []
  const follow = p.client.request({ method: 'remote.stream', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'test' } } } } }, (value: unknown) => received.push(value))
  await expect.poll(() => received.length).toBe(1)
  f.emit({ type: 'event', ...huge('live') }); f.emit({ type: 'event', text: 'after-large' })
  await expect.poll(() => received.length).toBe(3)
  expect(received).toEqual([f.input.snapshot, { type: 'event', ...huge('live') }, { type: 'event', text: 'after-large' }])
  expect(p.wire.filter(frame => frame.type === 'responseStart')).toHaveLength(3)
  expect(p.wire.every(frame => Buffer.byteLength(JSON.stringify(frame)) <= 2 * 1024 * 1024)).toBe(true)
  expect(p.client.assembler.bytes).toBe(0)
  follow.cancel(); await follow.promise; await expect.poll(() => f.input.followers).toBe(0)
})

test('旧手机保持小响应；大响应明确失败并释放原订阅，不自动重放写操作', async () => {
  const f = await fixture(), p = await f.phone(false)
  f.input.page = { records: [] } as any
  const page = p.client.request({ method: 'remote.rpc', endpoint: 'session/page', payload: { args: {} } })
  expect(await page.promise).toEqual({ ok: true, value: { records: [] } })
  const follow = p.client.request({ method: 'remote.stream', endpoint: 'session/follow', payload: { args: {} } })
  await expect(follow.promise).rejects.toThrow('response_too_large')
  await expect.poll(() => f.input.followers).toBe(0)
  expect(p.socket.readyState).toBe(WebSocket.OPEN)
  expect(p.sent.some(frame => frame.responseChunks)).toBe(false)
})

test('分块中断和设备撤权释放半份快照，重新配对连接只读取新响应', async () => {
  const f = await fixture(), p = await f.phone()
  p.control.dropAcks = true
  const task = p.client.request({ method: 'remote.stream', endpoint: 'session/follow', payload: { args: {} } })
  const failure = expect(task.promise).rejects.toThrow('connection_closed')
  await expect.poll(() => p.wire.filter(frame => frame.type === 'responseChunk').length).toBe(4)
  expect(p.client.assembler.bytes).toBeGreaterThan(0)
  p.socket.close(); await failure
  expect(p.client.assembler.bytes).toBe(0); await expect.poll(() => f.input.followers).toBe(0)
  const next = await f.phone()
  const page = next.client.request({ method: 'remote.rpc', endpoint: 'session/page', payload: { args: {} } })
  expect(await page.promise).toEqual({ ok: true, value: f.input.page })
  next.control.dropAcks = true
  const revoked = next.client.request({ method: 'remote.stream', endpoint: 'session/follow', payload: { args: {} } })
  const rejected = expect(revoked.promise).rejects.toThrow('connection_closed')
  await expect.poll(() => next.client.assembler.bytes).toBeGreaterThan(0)
  await f.gateway.inject({ method: 'POST', url: `/v1/host/devices/${f.binding.deviceId}/revoke`, headers: { authorization: 'Bearer ' + f.host.token } })
  await rejected; expect(next.client.assembler.bytes).toBe(0)
  await expect.poll(() => f.input.followers).toBe(0)
})

test('中转拦截乱序、重复、缺块、越窗和未协商分块，只终止关联请求', async () => {
  const f = await fixture(), p = await f.phone()
  p.control.dropAcks = true
  const host = new WebSocket(f.origin.replace('http:', 'ws:') + '/v1/host/socket?transport=2', {
    headers: { authorization: 'Bearer ' + f.host.token, 'x-dshm-response-chunks': '1' },
  })
  cleanup.push(() => host.terminate()); await once(host, 'open')
  const routed: any[] = []; host.on('message', bytes => routed.push(JSON.parse(bytes.toString())))
  for (const fault of ['order', 'duplicate', 'missing', 'window', 'transfer', 'kind', 'unnegotiated']) {
    p.client.responseChunksEnabled = fault !== 'unnegotiated'
    const before = routed.length
    const task = p.client.request({ method: 'remote.rpc', endpoint: 'session/page', payload: { args: {} } })
    const rejected = expect(task.promise).rejects.toThrow(fault === 'missing' ? 'incomplete_response_chunk' : 'invalid_response_chunk')
    await expect.poll(() => routed.slice(before).find(frame => frame.type === 'request')).toBeTruthy()
    const id = routed.slice(before).find(frame => frame.type === 'request').id, transferId = randomUUID()
    const send = (frame: unknown) => host.send(JSON.stringify(frame))
    send({ type: 'responseStart', id, transferId, kind: fault === 'kind' ? 'event' : 'result', bytes: RESPONSE_CHUNK_BYTES * 5, sha256: '0'.repeat(64) })
    const chunk = (index: number, transfer = transferId) => send({ type: 'responseChunk', id, transferId: transfer, index, data: Buffer.alloc(RESPONSE_CHUNK_BYTES).toString('base64') })
    if (fault === 'order') chunk(1)
    else if (fault === 'duplicate') { chunk(0); chunk(0) }
    else if (fault === 'missing') send({ type: 'responseEnd', id, transferId })
    else if (fault === 'window') for (let index = 0; index < 5; index++) chunk(index)
    else if (fault === 'transfer') chunk(0, randomUUID())
    await rejected
    await expect.poll(() => routed.some(frame => frame.type === 'cancel' && frame.id === id)).toBe(true)
    expect(p.client.assembler.bytes).toBe(0)
    expect(p.socket.readyState).toBe(WebSocket.OPEN); expect(host.readyState).toBe(WebSocket.OPEN)
  }
})

test('分块和确认保持原Host及原设备连接归属，其他已认证连接不能注入或提前确认', async () => {
  const f = await fixture(), p = await f.phone(), otherPhone = await f.phone()
  p.control.dropAcks = true
  const rawHost = async (token: string) => {
    const socket = new WebSocket(f.origin.replace('http:', 'ws:') + '/v1/host/socket?transport=2', {
      headers: { authorization: 'Bearer ' + token, 'x-dshm-response-chunks': '1' },
    })
    cleanup.push(() => socket.terminate()); await once(socket, 'open')
    const received: any[] = []; socket.on('message', bytes => received.push(JSON.parse(bytes.toString())))
    return { socket, received, send: (frame: unknown) => socket.send(JSON.stringify(frame)) }
  }
  const host = await rawHost(f.host.token), stranger = await rawHost((await f.store.enrollHost('Other')).token)
  const task = p.client.request({ method: 'remote.rpc', endpoint: 'session/page', payload: { args: {} } })
  await expect.poll(() => host.received.filter(frame => frame.type === 'request').length).toBe(1)
  const id = host.received[0].id, transferId = randomUUID()
  stranger.send({ type: 'responseStart', id, transferId, kind: 'event', bytes: 1, sha256: '0'.repeat(64) })
  const data = Buffer.from(JSON.stringify({ ok: true, value: 'owner' }))
  const { createHash } = await import('node:crypto')
  host.send({ type: 'responseStart', id, transferId, kind: 'result', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
  host.send({ type: 'responseChunk', id, transferId, index: 0, data: data.toString('base64') })
  await expect.poll(() => p.wire.filter(frame => frame.type === 'responseChunk').length).toBe(1)
  otherPhone.socket.send(JSON.stringify({ type: 'responseAck', id: task.id, transferId, index: 0 }))
  const barrier = otherPhone.client.request({ method: 'remote.rpc', endpoint: 'session/page', payload: { args: {} } })
  await expect.poll(() => host.received.filter(frame => frame.type === 'request').length).toBe(2)
  expect(host.received.some(frame => frame.type === 'responseAck')).toBe(false)
  p.socket.send(JSON.stringify({ type: 'responseAck', id: task.id, transferId, index: 0 }))
  await expect.poll(() => host.received.some(frame => frame.type === 'responseAck' && frame.id === id)).toBe(true)
  host.send({ type: 'responseEnd', id, transferId })
  expect(await task.promise).toEqual({ ok: true, value: 'owner' })
  barrier.cancel(); await barrier.promise
})
