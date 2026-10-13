import { expect, test } from 'vitest'
import { operationSchema, providerModelsDiscoveryViewSchema } from '../packages/protocol/src/index.js'

test('模型发现只能指定路由，不能携带手机地址、协议、凭据或任意命名空间', () => {
  const operation = { method: 'remote.providerModelsDiscover', provider: 'alpha' }
  expect(operationSchema.safeParse(operation).success).toBe(true)
  for (const key of ['baseURL', 'apiKey', 'api', 'headers', 'settingsNs']) {
    expect(operationSchema.safeParse({ ...operation, [key]: 'forbidden' }).success).toBe(false)
  }
  expect(providerModelsDiscoveryViewSchema.safeParse({ provider: 'alpha', rows: [{ id: 'a' }, { id: 'a' }] }).success).toBe(false)
  expect(providerModelsDiscoveryViewSchema.safeParse({ provider: 'alpha', rows: [{ id: 'a', apiKey: 'forbidden' }] }).success).toBe(false)
  expect(providerModelsDiscoveryViewSchema.safeParse({ provider: 'alpha', rows: [{ id: 'a', inputModalities: ['text', 'image'] }] }).success).toBe(true)
})
