import { expect, test } from 'vitest'
import { remotePermission, remoteRequestAllowed } from '../packages/protocol/src/remote-policy.js'

test('目标原接口保留版本身份和轮次约束，拒绝额外配置与非法输入', () => {
  const ref = { id: 'goal-1', revision: 2 }, request = { objective: '完成测试', maxGoalRounds: 3 }
  for (const method of ['get', 'create', 'edit', 'pause', 'resume', 'complete', 'clear']) {
    const endpoint = `goals/${method}`
    expect(remotePermission(endpoint, false)).toBe('basic')
    expect(remotePermission(endpoint, true)).toBeUndefined()
    const args = { agentId: 'session', ...(['create', 'edit'].includes(method) ? { request } : {}),
      ...(!['get', 'create'].includes(method) ? { ref } : {}) }
    expect(remoteRequestAllowed(endpoint, { args })).toBe(true)
    for (const invalid of [undefined, [], {}, { ...args, cwd: '/any' }, { ...args, agentId: '' }])
      expect(remoteRequestAllowed(endpoint, { args: invalid })).toBe(false)
  }
  for (const invalid of [undefined, {}, [], { ...ref, revision: 0 }, { ...ref, revision: 1.5 }, { ...ref, id: '' }, { ...ref, extra: true }])
    expect(remoteRequestAllowed('goals/pause', { args: { agentId: 's', ref: invalid } })).toBe(false)
  for (const invalid of [undefined, {}, [], { objective: '' }, { objective: '  ' }, { ...request, tools: [] },
    { ...request, maxGoalRounds: 0 }, { ...request, maxGoalRounds: 1.1 }, { ...request, objective: 'a'.repeat(32001) }])
    expect(remoteRequestAllowed('goals/create', { args: { agentId: 's', request: invalid } })).toBe(false)
  expect(remoteRequestAllowed('goals/edit', { args: { agentId: 's', ref, request: { maxGoalRounds: 6 } } })).toBe(true)
  expect(remotePermission('goals/block', false)).toBeUndefined()
})
