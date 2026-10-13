import { expect, test } from 'vitest'
import { remoteEndpoints, remotePermission, remoteRequestAllowed } from '../packages/protocol/src/remote-policy.js'

test('任务目录只在新版公布，只读流不扩展为取消任务或任意输出调用', () => {
  expect(remoteEndpoints(false).streams).not.toContain('job/list')
  expect(remoteEndpoints(false, false, 'target').streams).toContain('job/list')
  expect(remotePermission('job/list', true)).toBe('basic')
  expect(remotePermission('job/list', false)).toBeUndefined()
  expect(remotePermission('job/follow', true)).toBeUndefined()
  expect(remotePermission('job/kill', false)).toBeUndefined()
})

test('网关和新版 Host 仅接受已核验的会话目录请求，旧版拒绝新版契约', () => {
  const valid = { args: { request: { sessionId: 'session-owned' } } }
  expect(remoteRequestAllowed('job/list', valid)).toBe(false)
  for (const contract of ['target', 'either'] as const) {
    expect(remoteRequestAllowed('job/list', valid, contract)).toBe(true)
    for (const invalid of [{}, { args: null }, { args: [] }, { args: { request: [] } },
      { args: { sessionId: 'session-owned' } }, { args: { request: { sessionId: '' } } },
      { args: { request: { sessionId: 'x'.repeat(129) } } }, { args: { request: { sessionId: 'a\n' } } },
      { args: { request: { sessionId: 'a\0' } } }, { args: { request: { sessionId: 'a', jobId: 'pwsh-1' } } },
      { args: { request: { sessionId: 'a' }, signal: {} } }, { ...valid, path: '/api' }]) {
      expect(remoteRequestAllowed('job/list', invalid, contract), JSON.stringify(invalid)).toBe(false)
    }
  }
})
