import { expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { operationSchema, providerRemovalViewSchema } from '../packages/protocol/src/index.js'

test('提供方删除只接受一次性确认和固定路由，不开放配置路径或凭据', () => {
  const valid = { method: 'remote.providerRemovalWrite', provider: 'alpha', snapshot: randomUUID(), expectedRevision: 1 }
  expect(operationSchema.safeParse(valid).success).toBe(true)
  for (const raw of [{ ...valid, apiKeyEnv: 'OTHER_SECRET' }, { ...valid, path: ['providers'] }, { ...valid, provider: '__proto__' },
    { ...valid, expectedRevision: -1 }, { ...valid, snapshot: 'forged' }, { ...valid, deleteKey: true }]) {
    expect(operationSchema.safeParse(raw).success).toBe(false)
  }
  const view = { provider: 'alpha', name: 'Alpha', snapshot: randomUUID(), revision: 1, writable: true, removable: true,
    removed: false, keepsCredential: true, applies: 'live' }
  expect(providerRemovalViewSchema.safeParse(view).success).toBe(true)
  expect(providerRemovalViewSchema.safeParse({ ...view, apiKeyEnv: 'OTHER_SECRET' }).success).toBe(false)
})
