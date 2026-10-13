import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { operationSchema, computerKeyViewSchema, remotePermission } from '@dsh-mobile/protocol'

test('固定凭据目标与严格载荷：禁止任意引用、额外字段和通用凭据 RPC', () => {
  const operation = { method: 'remote.keyWrite', snapshot: randomUUID(), change: { op: 'set', value: 'TEST_KEY_ONLY' } }
  expect(operationSchema.safeParse(operation).success).toBe(true)
  for (const value of [{ ...operation, ref: 'DSH_MOBILE_ENROLLMENT_TOKEN' }, { ...operation, snapshot: '' },
    { ...operation, change: { op: 'set', value: 'has\nnewline' } }, { ...operation, change: { op: 'set', value: '' } },
    { ...operation, change: { op: 'unset', value: 'TEST_KEY_ONLY' } }]) expect(operationSchema.safeParse(value).success).toBe(false)
  expect(operationSchema.safeParse({ method: 'remote.keyRead' }).success).toBe(true)
  expect(computerKeyViewSchema.safeParse({ snapshot: randomUUID(), provider: 'deepseek-official', configured: true, writable: true, value: 'TEST_KEY_ONLY' }).success).toBe(false)
  expect(remotePermission('credentials/set', false)).toBeUndefined()
})

test('提供方目标严格解析，状态必须同时匹配路由及目标且不能带凭据引用', () => {
  const target = { provider: 'alpha' }, state = { snapshot: randomUUID(), provider: 'alpha', target, configured: true, writable: true }
  expect(operationSchema.safeParse({ method: 'remote.keyRead', target }).success).toBe(true)
  expect(computerKeyViewSchema.safeParse(state).success).toBe(true)
  for (const invalid of [{ provider: 'alpha', ref: 'SECRET' }, { provider: '__proto__' }, { provider: '' }])
    expect(operationSchema.safeParse({ method: 'remote.keyRead', target: invalid }).success).toBe(false)
  expect(computerKeyViewSchema.safeParse({ ...state, target: { provider: 'beta' } }).success).toBe(false)
  expect(computerKeyViewSchema.safeParse({ ...state, target: undefined }).success).toBe(false)
})
