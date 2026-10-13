import { expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { operationSchema } from '../packages/protocol/src/index.js'

test('结构化创建模型复用容量限制且拒绝额外配置，保留旧ID数组', () => {
  const operation = { method: 'remote.providerCreationWrite', kind: 'custom', provider: 'my-service', name: '', useKey: false,
    confirmed: true, snapshot: randomUUID(), expectedRevision: 1, api: 'openai-completions', baseURL: 'https://example.invalid/v1' }
  const row = { id: 'a', name: 'Model A', contextWindow: 128000, maxTokens: 8000, input: ['text', 'image'] }
  expect(operationSchema.safeParse({ ...operation, models: [row] }).success).toBe(true)
  expect(operationSchema.safeParse({ ...operation, models: ['a'] }).success).toBe(true)
  for (const models of [[row, row], [row, 'b'], [{ ...row, contextWindow: 0 }], [{ ...row, maxTokens: 1.5 }],
    [{ ...row, input: [] }], [{ ...row, input: ['text', 'text'] }], [{ ...row, input: ['audio'] }],
    [{ ...row, source: randomUUID() }], [{ ...row, headers: { Authorization: 'secret' } }], [{ ...row, apiKeyEnv: 'SECRET' }]])
    expect(operationSchema.safeParse({ ...operation, models }).success).toBe(false)
})

test('既有提供方Key启用不接受任意引用、值或设置路径', () => {
  const operation = { method: 'remote.providerKeySetup', provider: 'my-service', confirmed: true, snapshot: randomUUID(), expectedRevision: 1 }
  expect(operationSchema.safeParse(operation).success).toBe(true)
  for (const change of [{ ref: 'SECRET' }, { apiKeyEnv: 'SECRET' }, { key: 'SECRET' }, { edits: [] }, { confirmed: false }])
    expect(operationSchema.safeParse({ ...operation, ...change }).success).toBe(false)
})

test('创建协议拒绝任意凭据/headers/配置树，支持两种固定来源且要求目的地址确认', () => {
  const custom = { method: 'remote.providerCreationWrite', kind: 'custom', provider: 'my-service', name: '', useKey: true,
    confirmed: true, snapshot: randomUUID(), expectedRevision: 1, api: 'openai-completions', baseURL: 'http://127.0.0.1:9000/v1', models: ['a'] }
  expect(operationSchema.safeParse(custom).success).toBe(true)
  for (const change of [{ apiKeyEnv: 'SECRET' }, { apiKey: 'SECRET' }, { headers: {} }, { confirmed: false }, { provider: '__proto__' },
    { baseURL: 'https://example.invalid/?key=SECRET' }, { models: [] }, { models: ['a', 'a'] }]) {
    expect(operationSchema.safeParse({ ...custom, ...change }).success).toBe(false)
  }
  expect(operationSchema.safeParse({ method: 'remote.providerCreationWrite', kind: 'catalog', provider: 'openai', name: '', useKey: false,
    confirmed: true, snapshot: randomUUID(), expectedRevision: 1 }).success).toBe(true)
})
