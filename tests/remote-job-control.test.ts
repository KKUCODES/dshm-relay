import { expect, test } from 'vitest'
import { operationSchema, isStream } from '../packages/protocol/src/index.js'
import { randomUUID } from 'node:crypto'

test('后台停止只接受会话、任务、本次启动身份和控制器代次', () => {
  const operation = { method: 'remote.jobStop', sessionId: 'own', jobId: 'pwsh-1', startedAt: 1, generation: randomUUID() }
  expect(operationSchema.parse(operation)).toEqual(operation)
  expect(isStream(operationSchema.parse(operation))).toBe(false)
  for (const patch of [{ sessionId: '' }, { jobId: '' }, { startedAt: -1 }, { startedAt: 1.5 }, { generation: '' }, { command: 'anything' }, { owner: 'other' }])
    expect(operationSchema.safeParse({ ...operation, ...patch }).success).toBe(false)
})

test('独立输出只接受固定任务和有界字节范围，不能指定文件或更改 owner', () => {
  const operation = { method: 'remote.jobOutput', sessionId: 'own', jobId: 'pwsh-1', startedAt: 1,
    generation: randomUUID(), stream: 'stdout', fromByte: 0, maxBytes: 65536 }
  expect(operationSchema.parse(operation)).toEqual(operation)
  expect(isStream(operationSchema.parse(operation))).toBe(false)
  for (const patch of [{ fromByte: -1 }, { fromByte: 0.5 }, { maxBytes: 0 }, { maxBytes: 65537 },
    { stream: 'all' }, { path: '/tmp/secret' }, { owner: 'other' }, { generation: '' }])
    expect(operationSchema.safeParse({ ...operation, ...patch }).success).toBe(false)
})

test('前台独立输出限定原根调用和子调用，禁止命令/路径/进程控制与超界读取', () => {
  const operation = { method: 'remote.commandOutput', sessionId: 'own', rootCallId: 'root', callId: 'child', rootCallTime: 1,
    generation: randomUUID(), stream: 'stdout', fromByte: 0, maxBytes: 65536 }
  expect(operationSchema.parse(operation)).toEqual(operation)
  expect(isStream(operationSchema.parse(operation))).toBe(false)
  expect(operationSchema.safeParse({ ...operation, outputId: randomUUID() }).success).toBe(true)
  for (const patch of [{ callId: '' }, { rootCallId: '' }, { rootCallTime: -1 }, { outputId: 'old' }, { generation: '' },
    { maxBytes: 65537 }, { fromByte: -1 }, { stream: 'all' }, { command: 'x' }, { path: '/secret' }, { pid: 100 }, { stdin: 'x' }])
    expect(operationSchema.safeParse({ ...operation, ...patch }).success).toBe(false)
})
