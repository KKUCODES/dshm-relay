import { expect, test } from 'vitest'
import { remoteEndpoints, remotePermission, remoteRequestAllowed } from '../packages/protocol/src/remote-policy.js'

test('两版只公布实际目录入口；投影只读调用不能带路径或额外读取选项', () => {
  expect(remoteEndpoints(false).calls).toContain('subagents/list')
  expect(remoteEndpoints(false).calls).not.toContain('session/projections')
  expect(remoteEndpoints(false, false, 'target').calls).toContain('session/projections')
  expect(remoteEndpoints(false, false, 'target').calls).not.toContain('subagents/list')
  expect(remotePermission('session/projections', false)).toBe('basic')
  expect(remotePermission('session/projections', true)).toBeUndefined()
  const payload = { args: { request: { sessionId: 'owned-parent' } } }
  expect(remoteRequestAllowed('session/projections', payload)).toBe(false)
  for (const contract of ['target', 'either'] as const) {
    expect(remoteRequestAllowed('session/projections', payload, contract)).toBe(true)
    for (const invalid of [{ args: { sessionId: 'owned-parent' } }, { args: { request: { sessionId: '' } } },
      { args: { request: { sessionId: 'x'.repeat(129) } } }, { args: { request: { sessionId: 'nul\0' } } },
      { args: { request: { sessionId: 'owned-parent', cwd: 'C:/' } } },
      { args: { request: { sessionId: 'owned-parent' }, keys: ['subagentCatalog'] } }, { ...payload, path: '/api' }]) {
      expect(remoteRequestAllowed('session/projections', invalid, contract), JSON.stringify(invalid)).toBe(false)
    }
  }
  expect(remoteRequestAllowed('subagents/list', { args: { sessionId: 'parent' } }, 'target')).toBe(false)
});
