import { expect, test } from 'vitest'
import { remoteEndpoints, remotePermission, remoteRequestAllowed } from '../packages/protocol/src/remote-policy.js'

const samples = {
  getClientCode: { agentId: 's', pluginId: 'p', pluginRunId: 'r' }, inventory: {},
  invoke: { pluginId: 'p', pluginRunId: 'r', method: 'read', args: null },
  reportClientGuardFailure: { agentId: 's', pluginId: 'p', pluginRunId: 'r', failure: { message: 'fixture' } },
  reportRenderFailure: { agentId: 's', pluginId: 'p', pluginRunId: 'r', failure: {} },
  resolveInspectQuery: { agentId: 's', requestId: 'q', resolution: { ok: true, data: 'fixture' } },
  resolveRequestRun: { requestId: 'q', resolution: { ok: false, reason: 'rejected', message: 'fixture' } },
  runHostHalf: { agentId: 's', pluginId: 'p', packageId: 'v', mode: 'run', requestId: null, approveFutureVersions: false },
  settleUserRun: { agentId: 's', pluginId: 'p', resolution: {} },
  stopFromPanel: { agentId: 's', pluginId: 'p' }, syncInspectManifest: { providers: [] },
  undefineFromPanel: { agentId: 's', pluginId: 'p' },
}

test('仅兼容电脑协商的12个调用，无补丁时不宣告可用，也不新增流', () => {
  for (const method of Object.keys(samples)) {
    const endpoint = `dynamicCordisRunner/${method}`
    expect(remotePermission(endpoint, false)).toBe('basic')
    expect(remotePermission(endpoint, true)).toBeUndefined()
    expect(remoteEndpoints(true).calls).not.toContain(endpoint)
    expect(remoteEndpoints(false, true).calls).toContain(endpoint)
  }
  for (const method of ['define', 'createClientManifestScope', 'snapshot', 'eval', 'run']) {
    expect(remotePermission(`dynamicCordisRunner/${method}`, false)).toBeUndefined()
    expect(remoteRequestAllowed(`dynamicCordisRunner/${method}`, { args: {} })).toBe(false)
  }
})

test('保留原参数名称并拒绝页面自报身份、额外字段与缺失参数', () => {
  for (const [method, args] of Object.entries(samples)) {
    const endpoint = `dynamicCordisRunner/${method}`
    expect(remoteRequestAllowed(endpoint, { args })).toBe(true)
    for (const extra of [{ owner: 'other' }, { connectionId: 'other' }, { cwd: '/' }, { code: 'arbitrary' }]) {
      expect(remoteRequestAllowed(endpoint, { args: { ...args, ...extra } })).toBe(false)
      expect(remoteRequestAllowed(endpoint, { args, ...extra })).toBe(false)
    }
    for (const key of Object.keys(args)) {
      const missing = { ...args }; delete missing[key as keyof typeof missing]
      expect(remoteRequestAllowed(endpoint, { args: missing })).toBe(false)
    }
  }
})

test('不接受空、越界或控制字符身份；只有原 runHostHalf 的 requestId 可为空', () => {
  for (const value of ['', 'x'.repeat(201), 'a\nb', null, 42])
    expect(remoteRequestAllowed('dynamicCordisRunner/invoke', { args: { ...samples.invoke, pluginId: value } })).toBe(false)
  expect(remoteRequestAllowed('dynamicCordisRunner/resolveRequestRun', { args: { ...samples.resolveRequestRun, requestId: null } })).toBe(false)
  expect(remoteRequestAllowed('dynamicCordisRunner/runHostHalf', { args: samples.runHostHalf })).toBe(true)
})
