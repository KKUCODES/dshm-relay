import { afterEach, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { Store } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'

let db: PGlite | undefined
afterEach(async () => { await db?.close() })

test('one pairing key creates at most one device even when two clients race', async () => {
  db = new PGlite()
  const store = new Store(pgliteDatabase(db))
  await store.migrate()
  const host = await store.enrollHost('电脑', 'host-secret')
  await store.createPairing(host.id, 'a'.repeat(43), 300)
  const results = await Promise.allSettled([
    store.claimPairing('a'.repeat(43), 'phone-a', 'thumb-a'),
    store.claimPairing('a'.repeat(43), 'phone-b', 'thumb-b'),
  ])
  expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1)
  expect(await store.listDevices(host.id)).toHaveLength(1)
  await expect(store.claimPairing('a'.repeat(43), 'phone-c', 'thumb-c')).rejects.toThrow('pairing_unavailable')
  await store.cleanup()
  await expect(store.createPairing(host.id, 'a'.repeat(43), 300)).rejects.toThrow('pairing_key_already_issued')
})
