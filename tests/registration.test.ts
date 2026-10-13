import { afterEach, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { buildGateway } from '../packages/gateway/src/app.js'
import { registrationConfigSchema } from '../packages/gateway/src/registration-config.js'
import { Store, secret } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

test('private is the default and invalid modes or missing personal keys fail closed', () => {
  expect(registrationConfigSchema.parse({ enrollmentToken: secret() }).registrationMode).toBe('private')
  for (const input of [{}, { registrationMode: 'private', enrollmentToken: '' }, { registrationMode: 'opne' }]) {
    expect(registrationConfigSchema.safeParse(input).success).toBe(false)
  }
  expect(registrationConfigSchema.safeParse({ registrationMode: 'open' }).success).toBe(true)
  expect(registrationConfigSchema.safeParse({ registrationMode: 'open', enrollmentToken: 'ignored' }).success).toBe(true)
})

test.each(['open', 'private'] as const)('%s mode only changes computer enrollment, keeping Host/device access protected', async registrationMode => {
  const db = new PGlite(); cleanup.push(() => db.close())
  const store = new Store(pgliteDatabase(db)); await store.migrate()
  const enrollmentToken = registrationMode === 'private' ? secret() : undefined
  const app = await buildGateway({ store, publicOrigin: 'http://127.0.0.1:8787', registrationMode, enrollmentToken })
  cleanup.push(() => app.close())
  expect((await app.inject('/v1/server-info')).json()).toEqual({ registrationMode, remoteTransport: 2 })
  const enroll = (authorization?: string) => app.inject({ method: 'POST', url: '/v1/hosts', headers: authorization ? { authorization } : {}, payload: { name: 'Test computer' } })
  expect((await enroll()).statusCode).toBe(registrationMode === 'open' ? 201 : 401)
  expect((await enroll('Bearer ' + secret())).statusCode).toBe(registrationMode === 'open' ? 201 : 401)
  const created = await enroll(enrollmentToken ? 'Bearer ' + enrollmentToken : undefined)
  expect(created.statusCode).toBe(201)
  expect(await store.authenticateHost(created.json().token)).toBe(created.json().id)
  expect((await app.inject('/v1/host/devices')).statusCode).toBe(401)
  expect((await app.inject({ method: 'POST', url: '/v1/host/pairings', payload: { key: secret() } })).statusCode).toBe(401)
  expect((await app.inject({ method: 'POST', url: '/v1/device/ticket' })).statusCode).toBe(401)
  for (let i = 0; i < 8; i++) await enroll()
  expect((await enroll()).statusCode).toBe(429)
})
