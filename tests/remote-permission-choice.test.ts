import { expect, test } from 'vitest'
import { remoteEndpoints, remotePermission, remoteRequestAllowed } from '../packages/protocol/src/remote-policy.js'

test('Agent 目录与会话选择不授予预设管理能力', () => {
  expect(remotePermission('agentPresets/list', false)).toBe('basic')
  expect(remotePermission('agentPresets/select', false)).toBe('basic')
  // 管理接口已有独立能力门槛；普通聊天的协商清单仍不能包含它们。
  for (const method of ['copy', 'read', 'deletePreset']) expect(remoteEndpoints(false).calls).not.toContain(`agentPresets/${method}`)
  expect(remoteRequestAllowed('agentPresets/list', { args: {} })).toBe(true)
  expect(remoteRequestAllowed('agentPresets/list', { args: { path: '/any' } })).toBe(false)
  const args = { agentId: 'test', agentPreset: 'minimal' }
  expect(remoteRequestAllowed('agentPresets/select', { args })).toBe(true)
  for (const value of [undefined, [], {}, { ...args, agentId: '' }, { ...args, agentPreset: '' },
    { ...args, agentPreset: 'a\n' }, { ...args, agentPreset: 'a'.repeat(129) }, { ...args, cwd: '/any' }])
    expect(remoteRequestAllowed('agentPresets/select', { args: value })).toBe(false)
})

test('权限选择允许原生成 wire，拒绝任意命令、附件及多行', () => {
  const args = { agentId: 'session', line: '/permission workspace-write', submittedAttachments: [] }
  expect(remotePermission('commands/execute', false)).toBe('basic')
  expect(remotePermission('commands/execute', true)).toBeUndefined()
  for (const preset of ['read-only', 'workspace-write', 'danger-full-access', 'auto', '自定义权限']) {
    expect(remoteRequestAllowed('commands/execute', { args: { ...args, line: `/permission ${preset}` } })).toBe(true)
  }
  for (const invalid of [undefined, [], {}, { ...args, agentId: '' }, { ...args, submittedAttachments: [{}] },
    { ...args, extra: 'ignored?' }, ...['/clear', '/permission', '/permission ', '/permission read-only\n/clear',
      '/permission\tread-only', '/permission read-only\0', '/permission  read-only', `/permission ${'x'.repeat(129)}`]
      .map(line => ({ ...args, line }))]) {
    expect(remoteRequestAllowed('commands/execute', { args: invalid })).toBe(false)
  }
})
