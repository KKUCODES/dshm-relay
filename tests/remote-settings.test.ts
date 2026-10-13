import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { operationSchema, remotePermission, pluginSettingsViewSchema } from '../packages/protocol/src/index.js'

test('新版预设默认值只允许已审阅的字段、模式ID及快照版本', () => {
  const write = { method: 'remote.settingsWrite', namespace: 'agent-preset-registry', snapshot: randomUUID(), expectedRevision: 0,
    edits: [{ op: 'set', key: 'selectedDefault', value: 'custom-preset-with-long-name' }] }
  expect(operationSchema.safeParse(write).success).toBe(true)
  for (const invalid of [{ ...write, expectedRevision: undefined }, { ...write, snapshot: undefined },
    { ...write, namespace: 'agent-loop' }, { ...write, edits: [{ op: 'set', key: 'default', value: 'standard' }] },
    ...['../file', 'x\nsecret', 'a'.repeat(129), true, {}].map(value => ({ ...write, edits: [{ op: 'set', key: 'selectedDefault', value }] }))])
    expect(operationSchema.safeParse(invalid).success).toBe(false)
  expect(pluginSettingsViewSchema.safeParse({ namespace: write.namespace, snapshot: write.snapshot, revision: 0,
    writable: true, applies: 'live', fields: [{ key: 'selectedDefault', overridden: false }] }).success).toBe(true)
})

test('自定义协议更改要求原快照与明确确认', () => {
  const operation = { method: 'remote.providerSettingsWrite', provider: 'test-route', snapshot: randomUUID(),
    expectedRevision: 1, edits: [], protocolChange: { value: 'anthropic-messages', confirmed: true } };
  expect(operationSchema.parse(operation)).toEqual(operation);
  expect(operationSchema.safeParse({ ...operation, snapshot: undefined }).success).toBe(false);
  expect(operationSchema.safeParse({ ...operation, expectedRevision: undefined }).success).toBe(false);
  for (const protocolChange of [{ value: 'anthropic-messages' }, { value: '', confirmed: true },
    { value: 'anthropic-messages', confirmed: false }, { value: 'anthropic-messages', confirmed: true, apiKey: 'SECRET' }])
    expect(operationSchema.safeParse({ ...operation, protocolChange }).success).toBe(false);
});

test('电脑设置只有固定字段与必填快照版本，拒绝密钥、任意 namespace 与无条件写入', () => {
  const write = { method: 'remote.settingsWrite', snapshot: randomUUID(), expectedRevision: 0, edits: [{ op: 'set', key: 'maxTokens', value: 1024 }] }
  expect(operationSchema.safeParse(write).success).toBe(true)
  for (const invalid of [{ ...write, expectedRevision: undefined }, { ...write, snapshot: undefined }, { ...write, ns: 'credentials' },
    { ...write, edits: [{ op: 'set', key: 'apiKeyEnv', value: 'KEY' }] }, { ...write, edits: [{ op: 'set', key: 'thinking', value: 'SECRET' }] },
    { ...write, edits: [...write.edits, ...write.edits] }, { ...write, edits: [{ op: 'set', key: 'maxTokens', value: -1 }] },
    { ...write, edits: [{ op: 'unset', key: 'maxTokens', value: 1 }] }]) expect(operationSchema.safeParse(invalid).success).toBe(false)
  for (const endpoint of ['settings/describe', 'settings/mutate', 'settings/replace', 'credentials/set']) expect(remotePermission(endpoint, false)).toBeUndefined()
})

test('插件配置按 namespace 限定数值字段，不允许跨域、路径、秘密和非法数值', () => {
  const write = { method: 'remote.settingsWrite', namespace: 'shell', snapshot: randomUUID(), expectedRevision: 0,
    edits: [{ op: 'set', key: 'timeoutMs', value: 120001 }] }
  expect(operationSchema.safeParse(write).success).toBe(true)
  expect(operationSchema.safeParse({ method: 'remote.settingsRead', namespace: 'agent-loop' }).success).toBe(true)
  for (const invalid of [{ ...write, namespace: 'llm-pi-ai' }, { ...write, namespace: undefined },
    { ...write, namespace: 'agent-loop' }, { ...write, edits: [{ op: 'set', key: 'cwd', value: 'C:/' }] },
    { ...write, edits: [{ op: 'set', key: 'timeoutMs', value: 0 }] },
    { ...write, edits: [{ op: 'unset', key: 'maxTokens' }] },
    { ...write, namespace: 'agent-loop', edits: [{ op: 'set', key: 'maxParallelToolCalls', value: 1.5 }] }])
    expect(operationSchema.safeParse(invalid).success).toBe(false)
})

test('Subagent 投影只接受限制及严格模型路由，禁止将对象藏入其他字段', () => {
  const routes = [{ provider: 'deepseek', model: 'deepseek-chat' }]
  const write = { method: 'remote.settingsWrite', namespace: 'subagent-model-selection', snapshot: randomUUID(), expectedRevision: 0,
    edits: [{ op: 'set', key: 'enabled', value: true }, { op: 'set', key: 'allowedModels', value: routes }] }
  expect(operationSchema.safeParse(write).success).toBe(true)
  for (const value of [[{ ...routes[0], apiKey: 'SECRET' }], [...routes, ...routes], [{ provider: '', model: 'x' }], {}, true])
    expect(operationSchema.safeParse({ ...write, edits: [{ op: 'set', key: 'allowedModels', value }] }).success).toBe(false)
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(operationSchema.safeParse({ ...write, namespace: 'subagent', edits: [{ op: 'set', key: 'maxDepth', value }] }).success).toBe(false)
  expect(operationSchema.safeParse({ ...write, namespace: 'shell' }).success).toBe(false)
  const view = { namespace: write.namespace, snapshot: write.snapshot, revision: 0, writable: true, applies: 'live', fields: [
    { key: 'enabled', value: false, base: false, overridden: false },
    { key: 'allowedModels', value: routes, base: [], user: routes, overridden: true },
  ] }
  expect(pluginSettingsViewSchema.safeParse(view).success).toBe(true)
  expect(pluginSettingsViewSchema.safeParse({ ...view, fields: [...view.fields.slice(0, 1), { ...view.fields[1], user: [{ ...routes[0], headers: 'SECRET' }] }] }).success).toBe(false)
})

test('网页搜索次数与敏感配置使用不同入口，目标只能选已审阅的搜索服务', () => {
  const write = { method: 'remote.settingsWrite', namespace: 'web-search-deepseek', snapshot: randomUUID(), expectedRevision: 0,
    edits: [{ op: 'set', key: 'maxUses', value: 6 }] }
  expect(operationSchema.safeParse(write).success).toBe(true)
  for (const [key, value] of [['maxUses', 0], ['maxUses', 1.2], ['apiKey', 'PRIVATE'], ['baseURL', 'https://search.invalid']])
    expect(operationSchema.safeParse({ ...write, edits: [{ op: 'set', key, value }] }).success).toBe(false)
  for (const method of ['remote.keyRead', 'remote.endpointRead']) {
    expect(operationSchema.safeParse({ method, target: 'web-search-deepseek' }).success).toBe(true)
    for (const target of ['credentials', 'llm-pi-ai', '', null]) expect(operationSchema.safeParse({ method, target }).success).toBe(false)
  }
})
