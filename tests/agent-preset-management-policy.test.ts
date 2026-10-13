import { expect, test } from 'vitest'
import { remoteEndpoints, remotePermission, remoteRequestAllowed } from '../packages/protocol/src/remote-policy.js'

test('预设管理按原ID接口开放且只出现在管理能力清单', () => {
  for (const [endpoint, args] of [
    ['settings/openAgentPresetDirectory', { agentPreset: 'my-copy' }],
    ['agentPresets/read', { agentPreset: 'standard' }],
    ['agentPresets/copy', { from: 'standard', id: 'my-copy', name: '我的预设' }],
    ['agentPresets/deletePreset', { id: 'my-copy' }],
  ] as const) {
    expect(remotePermission(endpoint, false)).toBe('management')
    expect(remotePermission(endpoint, true)).toBeUndefined()
    expect(remoteEndpoints(false).calls).not.toContain(endpoint)
    expect(remoteEndpoints(true).calls).toContain(endpoint)
    expect(remoteRequestAllowed(endpoint, { args })).toBe(true)
    for (const payload of [{ args: {} }, { args: { ...args, path: '/any' } }, { args, management: true }])
      expect(remoteRequestAllowed(endpoint, payload)).toBe(false)
  }
})

test('新版不声明或放行已被官方移除的复制和删除，旧版及中转仍保留原契约', () => {
  for (const [endpoint, args] of [
    ['agentPresets/copy', { from: 'standard', id: 'my-copy', name: '我的预设' }],
    ['agentPresets/deletePreset', { id: 'my-copy' }],
  ] as const) {
    for (const management of [false, true])
      expect(remoteEndpoints(management, false, 'target', true).calls).not.toContain(endpoint)
    expect(remoteRequestAllowed(endpoint, { args }, 'target')).toBe(false)
    expect(remoteRequestAllowed(endpoint, { args }, 'legacy')).toBe(true)
    expect(remoteRequestAllowed(endpoint, { args }, 'either')).toBe(true)
    expect(remoteEndpoints(true, false, 'legacy').calls).toContain(endpoint)
  }
  for (const endpoint of ['agentPresets/read', 'settings/openAgentPresetDirectory'])
    expect(remoteEndpoints(true, false, 'target', true).calls).toContain(endpoint)
  expect(remoteRequestAllowed('agentPresets/read', { args: { agentPreset: 'standard' } }, 'target')).toBe(true)
})

test('拒绝路径、源码、控制字符及任意凭据或配置扩展', () => {
  for (const id of ['', '../outside', '/root', 'a/b', 'a\\b', 'a\n', 'a'.repeat(129)]) {
    expect(remoteRequestAllowed('agentPresets/read', { args: { agentPreset: id } })).toBe(false)
    expect(remoteRequestAllowed('agentPresets/deletePreset', { args: { id } })).toBe(false)
    expect(remoteRequestAllowed('agentPresets/copy', { args: { from: 'standard', id } })).toBe(false)
  }
  for (const extra of [{ source: 'code' }, { name: '\n' }, { name: 'x'.repeat(257) }, { config: {} }])
    expect(remoteRequestAllowed('agentPresets/copy', { args: { from: 'standard', id: 'test', ...extra } })).toBe(false)
})

test('设置更新仅允许预设默认值与模式开关，保留原版本条件', () => {
  const args = { ns: 'agent-presets', patch: { default: 'standard', modeSelectionEnabled: true } }
  expect(remotePermission('settings/update', false)).toBe('management')
  for (const expectedRevision of [undefined, 0, 42]) expect(remoteRequestAllowed('settings/update', { args: { ...args, expectedRevision } })).toBe(true)
  for (const patch of [{}, { default: '../root' }, { default: null }, { modeSelectionEnabled: 1 }, { default: 'standard', roots: [] }, { apiKeyEnv: 'SECRET' }])
    expect(remoteRequestAllowed('settings/update', { args: { ...args, patch } })).toBe(false)
  for (const extra of [{ ns: 'llm-deepseek' }, { expectedRevision: -1 }, { expectedRevision: null }, { expectedRevision: 1.5 }, { path: [] }])
    expect(remoteRequestAllowed('settings/update', { args: { ...args, ...extra } })).toBe(false)
  expect(remoteRequestAllowed('settings/update', { args, management: true })).toBe(false)
})
