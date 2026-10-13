import { expect, test } from 'vitest'
import { remoteEndpoints, remotePermission, remoteRequestAllowed } from '../packages/protocol/src/remote-policy.js'

test('工作区管理必须单独授权，不放行创建或目录选择', () => {
  for (const endpoint of ['workspace/rename', 'workspace/delete', 'workspace/insertBefore', 'workspace/insertSessionBefore']) {
    expect(remotePermission(endpoint, false)).toBe('management')
    expect(remoteEndpoints(false).calls).not.toContain(endpoint)
    expect(remoteEndpoints(true).calls).toContain(endpoint)
  }
  expect(remotePermission('workspace/create', false)).toBeUndefined()
  expect(remotePermission('workspace/archiveSession', false)).toBe('basic')
})

test('管理参数只接受已有工作区身份及原操作字段', () => {
  const cases = [
    ['workspace/rename', { workspaceId: 'a', title: '工作区' }],
    ['workspace/delete', { workspaceId: 'a' }],
    ['workspace/insertBefore', { workspaceId: 'a', beforeWorkspaceId: 'b' }],
    ['workspace/insertSessionBefore', { workspaceId: 'a', sessionId: 's', beforeSessionId: 't' }],
  ] as const
  for (const [endpoint, request] of cases) {
    expect(remoteRequestAllowed(endpoint, { args: { request } })).toBe(true)
    for (const extra of [{ path: '/new' }, { cwd: '/new' }, { deleteFiles: true }, { workspaceId: '' }])
      expect(remoteRequestAllowed(endpoint, { args: { request: { ...request, ...extra } } })).toBe(false)
    expect(remoteRequestAllowed(endpoint, { args: { request, extra: true } })).toBe(false)
  }
  for (const title of ['', ' ', 'a\nb', 'x'.repeat(201)])
    expect(remoteRequestAllowed('workspace/rename', { args: { request: { workspaceId: 'a', title } } })).toBe(false)
  expect(remoteRequestAllowed('workspace/insertBefore', { args: { request: { workspaceId: 'a', beforeWorkspaceId: 'a' } } })).toBe(false)
})
