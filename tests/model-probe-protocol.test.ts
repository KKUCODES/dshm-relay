import { expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { modelProbePrepareSchema, modelProbeExecuteSchema, modelProbePreparedSchema, modelProbeResultSchema } from '../packages/protocol/src/remote-model-probe.js'

const draft = { method: 'remote.modelProbePrepare', baseURL: 'http://127.0.0.1:12345/v1', api: 'openai-completions', authentication: { mode: 'none' } }
const execute = { method: 'remote.modelProbeExecute', snapshot: randomUUID(), confirmed: true }

test('准备目标允许HTTP/HTTPS及三种已知协议，认证来源明确互斥', () => {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
    for (const authentication of [{ mode: 'none' }, { mode: 'temporary' }, { mode: 'stored', provider: 'configured-route' }]) {
      expect(modelProbePrepareSchema.safeParse({ ...draft, api, authentication }).success).toBe(true)
    }
  }
  for (const authentication of [{ mode: 'stored' }, { mode: 'none', provider: 'other' }, { mode: 'temporary', apiKey: 'not-in-page' }]) {
    expect(modelProbePrepareSchema.safeParse({ ...draft, authentication }).success).toBe(false)
  }
  for (const baseURL of ['file:///tmp', 'https://user:pass@example.com', 'https://example.com?key=x', 'https://example.com/#x']) {
    expect(modelProbePrepareSchema.safeParse({ ...draft, baseURL }).success).toBe(false)
  }
  expect(modelProbePrepareSchema.safeParse({ ...draft, api: 'guessed-protocol' }).success).toBe(false)
  expect(modelProbePrepareSchema.safeParse({ ...draft, headers: { authorization: 'hidden' } }).success).toBe(false)
})

test('执行只能引用确认快照，禁止替换目标，只有临时认证分支携带Key', () => {
  for (const mode of ['none', 'stored']) {
    expect(modelProbeExecuteSchema.safeParse({ ...execute, mode }).success).toBe(true)
    expect(modelProbeExecuteSchema.safeParse({ ...execute, mode, apiKey: 'unexpected' }).success).toBe(false)
  }
  expect(modelProbeExecuteSchema.safeParse({ ...execute, mode: 'temporary', apiKey: 'synthetic-key' }).success).toBe(true)
  for (const apiKey of [undefined, '', ' ', 'bad\nheader', 'x'.repeat(8193)]) {
    expect(modelProbeExecuteSchema.safeParse({ ...execute, mode: 'temporary', apiKey }).success).toBe(false)
  }
  expect(modelProbeExecuteSchema.safeParse({ ...execute, mode: 'none', confirmed: false }).success).toBe(false)
  expect(modelProbeExecuteSchema.safeParse({ ...execute, mode: 'stored', provider: 'changed' }).success).toBe(false)
  expect(modelProbeExecuteSchema.safeParse({ ...execute, mode: 'none', baseURL: 'https://changed.invalid' }).success).toBe(false)
})

test('准备响应与候选不允许混入凭据或错误详情', () => {
  const view = { snapshot: randomUUID(), expiresAt: Date.now() + 300000, baseURL: draft.baseURL, api: draft.api, authentication: draft.authentication }
  expect(modelProbePreparedSchema.safeParse(view).success).toBe(true)
  expect(modelProbePreparedSchema.safeParse({ ...view, apiKey: 'secret' }).success).toBe(false)
  expect(modelProbeResultSchema.safeParse({ rows: [{ id: 'one', name: 'One' }] }).success).toBe(true)
  expect(modelProbeResultSchema.safeParse({ rows: [{ id: 'one' }, { id: 'one' }] }).success).toBe(false)
  expect(modelProbeResultSchema.safeParse({ rows: [], headers: {} }).success).toBe(false)
})
