import { expect, test } from 'vitest'
import { remoteEndpoints, remotePermission, remoteRequestAllowed } from '../packages/protocol/src/index.js'

const wait = { args: { agentId: 'session-own', callId: 'call_own' } }
const answer = { args: { ...wait.args, answer: { answers: [{ id: 'choice', selected: ['绿色'] }] } } }

test('新版官方带超时提问只公开计时流和结构化补答，不宣称旧Host支持', () => {
  expect(remotePermission('userQuestions/attachWait', true)).toBe('basic')
  expect(remotePermission('userQuestions/attachWait', false)).toBeUndefined()
  expect(remotePermission('userQuestions/answer', false)).toBe('basic')
  expect(remotePermission('userQuestions/answer', true)).toBeUndefined()
  const latest = remoteEndpoints(false, false, 'target'), legacy = remoteEndpoints(false)
  expect(latest.streams).toContain('userQuestions/attachWait')
  expect(latest.calls).toContain('userQuestions/answer')
  expect(legacy.streams).not.toContain('userQuestions/attachWait')
  expect(legacy.calls).not.toContain('userQuestions/answer')
  for (const contract of ['target', 'either'] as const) {
    expect(remoteRequestAllowed('userQuestions/attachWait', wait, contract)).toBe(true)
    expect(remoteRequestAllowed('userQuestions/answer', answer, contract)).toBe(true)
    expect(remoteRequestAllowed('userQuestions/answer', { args: { ...wait.args,
      answer: { answers: [{ id: 'choice', selected: [], custom: '补充意见\n第二行' }] } } }, contract)).toBe(true)
  }
  expect(remoteRequestAllowed('userQuestions/attachWait', wait)).toBe(false)
  expect(remoteRequestAllowed('userQuestions/answer', answer)).toBe(false)
})

test('计时与补答拒绝冒用关联字段、越权参数及损坏的答案批次', () => {
  for (const payload of [ {}, { args: [] }, { args: { ...wait.args, clientId: 'other' } },
    { args: { ...wait.args, agentId: '' } }, { args: { ...wait.args, callId: 'bad\ncall' } },
    { ...wait, management: true }, { args: { ...wait.args, answer: {} } } ])
    expect(remoteRequestAllowed('userQuestions/attachWait', payload, 'target')).toBe(false)
  for (const value of [ undefined, 'allowed-once', {}, { answers: [] },
    { answers: [{ id: 'choice', selected: '绿色' }] },
    { answers: [{ id: 'choice', selected: [], permission: 'approved' }] },
    { answers: [{ id: 'choice', selected: [] }, { id: 'choice', selected: [] }] },
    { answers: [{ id: '', selected: [] }] }, { answers: [{ id: 'choice', selected: [false] }] },
    { answers: [{ id: 'choice', selected: [], custom: false }] },
    { answers: [{ id: 'choice', selected: [] }], timeout: -1 } ])
    expect(remoteRequestAllowed('userQuestions/answer', { args: { ...wait.args, answer: value } }, 'target')).toBe(false)
  expect(remotePermission('userQuestions/askTimed', false)).toBeUndefined()
  expect(remotePermission('userQuestions/ask', false)).toBeUndefined()
})
