import { expect, test } from 'vitest'
import { remoteEndpoints, remotePermission, remoteRequestAllowed } from '../packages/protocol/src/remote-policy.js'

test('定时任务只在已核验新版本公布会话只读接口，管理授权也不开放调度写入', () => {
  for (const management of [false, true]) {
    expect(remoteEndpoints(management).calls).not.toContain('schedule/list')
    expect(remoteEndpoints(management, false, 'target').calls).not.toContain('schedule/list')
    expect(remoteEndpoints(management, false, 'target', true).calls).toContain('schedule/list')
  }
  expect(remotePermission('schedule/list', false)).toBe('basic')
  expect(remotePermission('schedule/list', true)).toBeUndefined()
  for (const method of ['create', 'delete', 'update', 'catalog', 'history'])
    expect(remotePermission('schedule/' + method, false)).toBeUndefined()
  const payload = { args: { request: { sessionId: 'owned-session' } } }
  expect(remoteRequestAllowed('schedule/list', payload)).toBe(false)
  expect(remoteRequestAllowed('schedule/list', payload, 'target')).toBe(true)
  for (const value of [{}, { args: {} }, { args: { request: {} } },
    { args: { request: { sessionId: '' } } }, { args: { request: { sessionId: 'x'.repeat(129) } } },
    { args: { request: { sessionId: 'nul\0' } } }, { args: { request: { sessionId: 'owned', cwd: 'C:/' } } },
    { args: { request: { sessionId: 'owned' }, id: 'task' } }, { ...payload, path: '/api' },
    { args: { sessionId: 'owned' } }, { args: { request: ['owned'] } }])
    expect(remoteRequestAllowed('schedule/list', value, 'target')).toBe(false)
})
