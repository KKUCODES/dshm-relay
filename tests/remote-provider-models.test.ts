import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { operationSchema, providerModelsViewSchema, modelCompatSchema } from '@dsh-mobile/protocol'

test('官方DeepSeek模型仅允许固定目标和字段，去空白后重复ID拒绝', () => {
  const base = { method: 'remote.deepSeekModelsWrite', snapshot: randomUUID(), expectedRevision: 0 }
  expect(operationSchema.safeParse({ method: 'remote.deepSeekModelsRead' }).success).toBe(true)
  expect(operationSchema.safeParse({ method: 'remote.deepSeekModelsRead', provider: 'other' }).success).toBe(false)
  const parsed = operationSchema.parse({ ...base, change: { op: 'set', rows: [{ id: ' one ', advanced: { input: ['text', 'image'] } }] } })
  expect(parsed).toMatchObject({ change: { rows: [{ id: 'one' }] } })
  for (const rows of [[{ id: 'one' }, { id: ' one ' }], [{ id: 'one', advanced: { input: [] } }],
    [{ id: 'one', advanced: { reasoningEfforts: false } }], [{ id: 'one', compat: {} }], [{ id: 'one', apiKeyEnv: 'PRIVATE' }]])
    expect(operationSchema.safeParse({ ...base, change: { op: 'set', rows } }).success).toBe(false)
})

test('内置模型覆盖只接收固定scope，字典ID拒绝原型键，清单旧请求保持兼容', () => {
  const base = { method: 'remote.providerModelsWrite', provider: 'deepseek', scope: 'overrides', snapshot: randomUUID(), expectedRevision: 0 }
  expect(operationSchema.safeParse({ ...base, change: { op: 'set', rows: [{ id: 'deepseek-chat', name: 'Changed' }] } }).success).toBe(true)
  for (const id of ['__proto__', 'constructor', 'prototype', 'bad\u0000id'])
    expect(operationSchema.safeParse({ ...base, change: { op: 'set', rows: [{ id }] } }).success).toBe(false)
  expect(operationSchema.safeParse({ ...base, change: { op: 'unset' } }).success).toBe(true)
  expect(operationSchema.safeParse({ method: 'remote.providerModelsRead', provider: 'deepseek', scope: 'arbitrary' }).success).toBe(false)
})

test('模型清单仅允许固定展示字段，重复ID/原行、任意路径和非有限容量拒绝', () => {
  const source = randomUUID(), row = { id: 'model', source }, base = { method: 'remote.providerModelsWrite', provider: 'alpha',
    snapshot: randomUUID(), expectedRevision: 1, change: { op: 'set', rows: [row] } }
  expect(operationSchema.safeParse(base).success).toBe(true)
  for (const rows of [[row, row], [row, { ...row, id: 'other' }], [{ ...row, compat: { arbitrary: true } }], [{ ...row, contextWindow: 0 }],
    [{ ...row, maxTokens: Infinity }], [{ ...row, id: '' }]])
    expect(operationSchema.safeParse({ ...base, change: { op: 'set', rows } }).success).toBe(false)
  expect(operationSchema.safeParse({ ...base, path: ['anything'] }).success).toBe(false)
  expect(operationSchema.safeParse({ ...base, change: { op: 'unset' } }).success).toBe(true)
  expect(providerModelsViewSchema.safeParse({ provider: 'alpha', snapshot: randomUUID(), revision: 0, writable: true,
    applies: 'live', overridden: true, rows: [row] }).success).toBe(true)
  expect(providerModelsViewSchema.safeParse({ provider: 'alpha', snapshot: randomUUID(), revision: 0, writable: true,
    applies: 'live', overridden: true, rows: [{ ...row, id: '' }, { ...row, source: randomUUID(), id: '' }] }).success).toBe(true)
})

test('兼容配置只接纳原固定字段与受限模板值，不能扩大为任意配置', () => {
  expect(modelCompatSchema.safeParse({ supportsStore: false, thinkingFormat: 'qwen-chat-template', vllmPriority: -2,
    chatTemplateKwargs: { enable: { $var: 'thinking.enabled' }, numeric: 1, nullable: null, text: 'value' } }).success).toBe(true)
  for (const value of [{ headers: { Authorization: 'test' } }, { apiKeyEnv: 'TEST' }, { supportsStore: null },
    { supportsStore: 'true' }, { maxTokensField: 'unknown' }, { vllmPriority: 0.5 }, { vllmPriority: Infinity },
    { chatTemplateArgs: [] }, { chatTemplateKwargs: { bad: { $var: 'unknown' } } }, { chatTemplateArgs: { nested: { arbitrary: true } } },
    { chatTemplateArgs: JSON.parse('{"__proto__":"unsafe"}') }]) expect(modelCompatSchema.safeParse(value).success).toBe(false)
})

test('模型输入与思考声明遵循继承、关闭和明确档位的区别，拒绝未知能力', () => {
  const base = { method: 'remote.providerModelsWrite', provider: 'alpha', snapshot: randomUUID(), expectedRevision: 1 }
  const parse = (advanced: unknown) => operationSchema.safeParse({ ...base, change: { op: 'set', rows: [{ id: 'm', advanced }] } }).success
  for (const advanced of [{}, { input: [] }, { input: ['text', 'image'] }, { reasoningEfforts: false },
    { reasoningEfforts: { off: null, high: 'high' } }]) expect(parse(advanced)).toBe(true)
  for (const advanced of [{ input: ['audio'] }, { input: ['text', 'text'] }, { reasoningEfforts: null },
    { reasoningEfforts: {} }, { reasoningEfforts: { high: null } }, { reasoningEfforts: { off: null } },
    { reasoningEfforts: { high: '' } }, { reasoningEfforts: { secret: 'value' } }, { compat: {} }]) expect(parse(advanced)).toBe(false)
})
