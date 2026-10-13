import { afterEach, expect, test, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { Store, secret } from '../packages/gateway/src/store.js'
import { buildGateway } from '../packages/gateway/src/app.js'
import { pgliteDatabase } from './support/database.js'
import { clientKey, proof } from './support/proof.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

test('真实设备认证路径中，防重放存储故障拒绝请求但不得冒充凭据失效', async () => {
  const engine = new PGlite(), db = pgliteDatabase(engine), store = new Store(db)
  cleanup.push(() => engine.close())
  await store.migrate()
  const origin = 'http://127.0.0.1:3088'
  const app = await buildGateway({ store, publicOrigin: origin, registrationMode: 'open' })
  cleanup.push(() => app.close())
  const host = await store.enrollHost('storage failure test'), pairKey = secret(), client = await clientKey()
  await store.createPairing(host.id, pairKey, 300)
  const claimed = await app.inject({ method: 'POST', url: '/v1/pairings/claim',
    headers: { dpop: await proof(client, origin + '/v1/pairings/claim', 'POST') }, payload: { key: pairKey, name: 'test phone' } })
  expect(claimed.statusCode).toBe(201)
  const binding = claimed.json()
  await store.changeDevice(host.id, binding.deviceId, 'active')
  const headers = async (path: string, method: string) => ({ authorization: `DPoP ${binding.token}`, dpop: await proof(client, origin + path, method, binding.token) })
  const query = db.query.bind(db)
  let unavailable = true
  // 仅注入数据库失败，真实签名/防重放SQL/设备认证与HTTP路由均不替换。
  vi.spyOn(db, 'query').mockImplementation((sql, values) => {
    if (unavailable && sql.startsWith('INSERT INTO proof_replays')) throw Error('injected database timeout; private diagnostic')
    return query(sql, values)
  })
  for (const [method, path] of [['GET', '/v1/device'], ['POST', '/v1/device/ticket']] as const) {
    const failed = await app.inject({ method, url: path, headers: await headers(path, method) })
    expect(failed.statusCode).toBe(500)
    expect(failed.json()).toEqual({ error: 'internal_error' })
    expect(failed.body).not.toContain('private diagnostic')
  }
  unavailable = false
  const valid = await headers('/v1/device', 'GET')
  expect((await app.inject({ method: 'GET', url: '/v1/device', headers: valid })).statusCode).toBe(200)
  const replayed = await app.inject({ method: 'GET', url: '/v1/device', headers: valid })
  expect(replayed.statusCode).toBe(401)
  expect(replayed.json()).toEqual({ error: 'proof_replayed' })
  const ticket = await app.inject({ method: 'POST', url: '/v1/device/ticket', headers: await headers('/v1/device/ticket', 'POST') })
  expect(ticket.statusCode).toBe(200)
})
