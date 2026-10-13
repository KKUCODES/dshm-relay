import { expect, test } from 'vitest'
import { remoteEndpoints, remotePermission, remoteRequestAllowed } from '../packages/protocol/src/remote-policy.js'

const version = '76544b78-9a2b-41b9-84ee-292881425d60'
const requests = {
  'messageFeedback/list': { sessionId: 'session' },
  'messageFeedback/put': { sessionId: 'session', messageId: 'message', rating: 'positive', ifVersion: null },
  'messageFeedback/delete': { sessionId: 'session', messageId: 'message', ifVersion: version },
  'sessionFeedback/record': { sessionId: 'session' },
}
const permits = (endpoint: string, request: unknown) => remoteRequestAllowed(endpoint, { args: { request } })

test('反馈沿用基本会话授权和原 request 信封，只开放四个审阅过的入口', () => {
  for (const [endpoint, request] of Object.entries(requests)) {
    expect(remotePermission(endpoint, false)).toBe('basic')
    expect(remotePermission(endpoint, true)).toBeUndefined()
    expect(remoteEndpoints(false).calls).toContain(endpoint)
    expect(permits(endpoint, request)).toBe(true)
    for (const invalid of [undefined, null, [], {}, { ...request, sessionId: '' }, { ...request, sessionId: 's\n' },
      { ...request, sessionId: 's'.repeat(201) }, { ...request, destination: 'https://other.example' }])
      expect(permits(endpoint, invalid)).toBe(false)
    expect(remoteRequestAllowed(endpoint, { args: { request, other: true } })).toBe(false)
    expect(remoteRequestAllowed(endpoint, { args: [] })).toBe(false)
  }
  for (const endpoint of ['messageFeedback/export', 'sessionFeedback/delete']) {
    expect(remotePermission(endpoint, false)).toBeUndefined()
    expect(permits(endpoint, { sessionId: 's' })).toBe(false)
  }
})

test('消息反馈必须携带真实消息身份和明确版本；保留原分类及 UTF-8 大小边界', () => {
  const endpoint = 'messageFeedback/put', request = requests[endpoint]
  for (const invalid of [{ messageId: '' }, { ifVersion: undefined }, { ifVersion: 'old' }, { rating: 'like' },
    { category: 'invented' }, { note: '' }, { note: '  ' }, { note: '汉'.repeat(21846) }])
    expect(permits(endpoint, { ...request, ...invalid })).toBe(false)
  expect(permits(endpoint, { ...request, ifVersion: version, rating: 'negative', note: '说明', category: 'other' })).toBe(true)
  expect(permits(endpoint, { ...request, note: 'a'.repeat(65536) })).toBe(true)
  expect(permits('messageFeedback/delete', { ...requests['messageFeedback/delete'], ifVersion: null })).toBe(false)
  expect(permits('messageFeedback/delete', { ...requests['messageFeedback/delete'], note: '不能夹带正文' })).toBe(false)
  expect(permits('sessionFeedback/record', { sessionId: 's', text: '  ' })).toBe(true)
  expect(permits('sessionFeedback/record', { sessionId: 's', text: '汉'.repeat(21846) })).toBe(false)
})
