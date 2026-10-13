import { afterEach, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { Store, secret } from '../packages/gateway/src/store.js'
import { buildGateway } from '../packages/gateway/src/app.js'
import { pgliteDatabase } from './support/database.js'
import { clientKey, proof } from './support/proof.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

test('pairing binds a key, waits for desktop approval, and rejects copied credentials and revoked devices', async () => {
  const db = new PGlite(), store = new Store(pgliteDatabase(db))
  cleanup.push(() => db.close())
  await store.migrate()
  const app = await buildGateway({ store, publicOrigin: 'http://127.0.0.1:3088', enrollmentToken: secret(), allowInsecureLocalhost: true })
  cleanup.push(() => app.close())
  const host = await store.enrollHost('computer')
  const key = secret(), client = await clientKey()
  const hostHeaders = { authorization: `Bearer ${host.token}` }
  const created = await app.inject({ method: 'POST', url: '/v1/host/pairings', headers: hostHeaders, payload: { key } })
  expect(created.statusCode).toBe(201)
  const claimProof = await proof(client, 'http://127.0.0.1:3088/v1/pairings/claim', 'POST')
  const claimed = await app.inject({ method: 'POST', url: '/v1/pairings/claim', headers: { dpop: claimProof }, payload: { key, name: 'phone' } })
  expect(claimed.statusCode).toBe(201)
  const binding = claimed.json()
  const headers = async (key = client) => ({ authorization: `DPoP ${binding.token}`, dpop: await proof(key, 'http://127.0.0.1:3088/v1/device/ticket', 'POST', binding.token) })
  expect((await app.inject({ method: 'POST', url: '/v1/device/ticket', headers: await headers() })).statusCode).toBe(403)
  const otherHost = await store.enrollHost('other')
  expect((await app.inject({ method: 'POST', url: `/v1/host/devices/${binding.deviceId}/approve`, headers: { authorization: `Bearer ${otherHost.token}` } })).statusCode).toBe(404)
  expect((await app.inject({ method: 'POST', url: `/v1/host/devices/${binding.deviceId}/approve`, headers: hostHeaders })).statusCode).toBe(200)
  expect((await app.inject({ method: 'POST', url: '/v1/device/ticket', headers: await headers(await clientKey()) })).statusCode).toBe(401)
  const wrongProofs = [
    await proof(client, 'https://attacker.example/v1/device/ticket', 'POST', binding.token),
    await proof(client, 'http://127.0.0.1:3088/v1/device/ticket', 'GET', binding.token),
    await proof(client, 'http://127.0.0.1:3088/v1/device/ticket', 'POST', secret()),
  ]
  for (const dpop of wrongProofs) expect((await app.inject({ method: 'POST', url: '/v1/device/ticket', headers: { authorization: `DPoP ${binding.token}`, dpop } })).statusCode).toBe(401)
  expect((await app.inject({ method: 'GET', url: '/v1/host/devices', headers: { ...hostHeaders, origin: 'https://attacker.example' } })).statusCode).toBe(403)
  const valid = await headers()
  expect((await app.inject({ method: 'POST', url: '/v1/device/ticket', headers: valid })).statusCode).toBe(200)
  expect((await app.inject({ method: 'POST', url: '/v1/device/ticket', headers: valid })).statusCode).toBe(401)
  expect((await app.inject({ method: 'POST', url: `/v1/host/devices/${binding.deviceId}/revoke`, headers: hostHeaders })).statusCode).toBe(200)
  expect((await app.inject({ method: 'POST', url: '/v1/device/ticket', headers: await headers() })).statusCode).toBe(401)
})
