import { expect, test } from 'vitest'
import { operationSchema, computerSettingsWriteSchema, pluginSettingsViewSchema } from '../packages/protocol/src/index.js'
import { randomUUID } from 'node:crypto'

test('代码视图只读操作拒绝额外参数，管理字段只允许布尔值和恢复继承', () => {
  expect(operationSchema.safeParse({ method: 'remote.codingToolsRead' }).success).toBe(true)
  expect(operationSchema.safeParse({ method: 'remote.codingToolsRead', namespace: 'credentials' }).success).toBe(false)
  const base = { method: 'remote.settingsWrite', namespace: 'ui-settings', snapshot: randomUUID(), expectedRevision: 1 }
  expect(computerSettingsWriteSchema.safeParse({ ...base, edits: [{ op: 'set', key: 'enabled', value: false }] }).success).toBe(true)
  expect(computerSettingsWriteSchema.safeParse({ ...base, edits: [{ op: 'unset', key: 'enabled' }] }).success).toBe(true)
  for (const edits of [[{ op: 'set', key: 'enabled', value: 'false' }], [{ op: 'set', key: 'selectedDefault', value: 'standard' }]])
    expect(computerSettingsWriteSchema.safeParse({ ...base, edits }).success).toBe(false)
  expect(pluginSettingsViewSchema.safeParse({ namespace: 'ui-settings', snapshot: randomUUID(), revision: 0, writable: true, applies: 'live',
    fields: [{ key: 'enabled', value: false, base: true, user: false, overridden: true }] }).success).toBe(true)
})
