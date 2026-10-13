import { expect, test } from 'vitest'
import { operationSchema, modelReadinessSchema } from '../packages/protocol/src/index.js'

test('就绪请求无参数，结果只有固定枚举，不接受引用、配置或Key', () => {
  expect(operationSchema.safeParse({ method: 'remote.modelReadiness' }).success).toBe(true)
  for (const extra of [{ provider: 'other' }, { ref: 'SECRET' }, { config: {} }])
    expect(operationSchema.safeParse({ method: 'remote.modelReadiness', ...extra }).success).toBe(false)
  for (const kind of ['provider-ready', 'adapter-absent', 'credential-missing', 'unavailable'])
    expect(modelReadinessSchema.safeParse({ kind }).success).toBe(true)
  expect(modelReadinessSchema.safeParse({ kind: 'ready' }).success).toBe(false)
  expect(modelReadinessSchema.safeParse({ kind: 'unavailable', error: 'SECRET' }).success).toBe(false)
})
