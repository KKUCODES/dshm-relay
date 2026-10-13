import { expect, test } from 'vitest'
import { remoteEndpoints, remotePermission, remoteRequestAllowed } from '../packages/protocol/src/remote-policy.js'

test('引用只读候选沿用真实 Agent 参数，不允许扩展目录、内容或查询上限', () => {
  for (const endpoint of ['fileReferences/list', 'sessionReferenceResolver/candidates']) {
    const args = { agentId: 'session-owner', query: '目录 name/' }
    expect(remotePermission(endpoint, false)).toBe('basic')
    expect(remotePermission(endpoint, true)).toBeUndefined()
    expect(remoteEndpoints(false).calls).toContain(endpoint)
    expect(remoteRequestAllowed(endpoint, { args })).toBe(true)
    expect(remoteRequestAllowed(endpoint, { args: { ...args, query: '' } })).toBe(true)
    for (const extra of [{ cwd: 'C:/' }, { limit: 99999 }, { includeContent: true }, { query: 'x'.repeat(4097) }, { query: '\0' }, { agentId: '' }, { agentId: '\n' }]) {
      expect(remoteRequestAllowed(endpoint, { args: { ...args, ...extra } })).toBe(false)
    }
    for (const args of [null, [], {}, { sessionId: 'wrong-wire', query: '' }]) expect(remoteRequestAllowed(endpoint, { args })).toBe(false)
  }
  expect(remotePermission('sessionReferenceResolver/prepare', false)).toBeUndefined()
})
