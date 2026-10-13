import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { computerEndpointWriteSchema, computerEndpointViewSchema, operationSchema } from '../packages/protocol/src/index.js'

test('提供方地址目标必须是固定结构；只有提供方响应允许目录默认地址', () => {
  expect(operationSchema.safeParse({ method: 'remote.endpointRead', target: { provider: 'openai' } }).success).toBe(true)
  for (const target of [{ provider: '__proto__' }, { provider: 'alpha', namespace: 'credentials' }, { provider: '' }, { namespace: 'llm-pi-ai' }])
    expect(operationSchema.safeParse({ method: 'remote.endpointRead', target }).success).toBe(false)
  const view = { snapshot: randomUUID(), revision: 0, writable: true, applies: 'live', protocol: 'provider', target: { provider: 'alpha' }, origin: null, inheritedOrigin: null, customPath: false, overridden: false }
  expect(computerEndpointViewSchema.safeParse(view).success).toBe(true)
  expect(computerEndpointViewSchema.safeParse({ ...view, target: undefined }).success).toBe(false)
  expect(computerEndpointViewSchema.safeParse({ ...view, protocol: 'messages' }).success).toBe(false)
})

test('地址必须确认、限定原字段，HTTP/HTTPS 路径可用，凭据及任意地址协议拒绝', () => {
  const write = { method: 'remote.endpointWrite', snapshot: randomUUID(), expectedRevision: 0, confirmed: true, change: { op: 'set', value: 'http://127.0.0.1:8787/anthropic' } }
  expect(computerEndpointWriteSchema.safeParse(write).success).toBe(true)
  for (const value of ['file:///etc/passwd', 'https://a:secret@example.invalid', 'https://example.invalid/?key=secret', 'https://example.invalid/#secret', 'https://example.invalid\\evil', ' https://example.invalid'])
    expect(computerEndpointWriteSchema.safeParse({ ...write, change: { op: 'set', value } }).success).toBe(false)
  expect(computerEndpointWriteSchema.safeParse({ ...write, confirmed: false }).success).toBe(false)
  expect(computerEndpointWriteSchema.safeParse({ ...write, namespace: 'anything' }).success).toBe(false)
  expect(() => computerEndpointViewSchema.safeParse({ snapshot: randomUUID(), revision: 0, writable: true, applies: 'live', protocol: 'messages', origin: 'invalid', inheritedOrigin: 'invalid', customPath: false, overridden: false })).not.toThrow()
})

test('恢复策略扩展仅限提供方且必须显式请求，原有读写结构继续可用', () => {
  const read = { method: 'remote.endpointRead', target: { provider: 'alpha' }, resetPolicy: true }
  expect(operationSchema.safeParse(read).success).toBe(true)
  expect(operationSchema.safeParse({ ...read, resetPolicy: undefined }).success).toBe(true)
  for (const target of [undefined, 'web-search-deepseek'])
    expect(operationSchema.safeParse({ ...read, target }).success).toBe(false)
  expect(operationSchema.safeParse({ ...read, resetPolicy: false }).success).toBe(false)
  const write = { method: 'remote.endpointWrite', target: read.target, resetPolicy: true,
    snapshot: randomUUID(), expectedRevision: 0, confirmed: true, change: { op: 'unset' } }
  expect(operationSchema.safeParse(write).success).toBe(true)
  expect(computerEndpointWriteSchema.safeParse({ ...write, target: undefined }).success).toBe(false)
  const view = { snapshot: randomUUID(), revision: 0, writable: true, applies: 'live', protocol: 'provider',
    target: read.target, origin: null, inheritedOrigin: null, customPath: false, overridden: true, resettable: false }
  expect(computerEndpointViewSchema.safeParse(view).success).toBe(true)
  expect(computerEndpointViewSchema.safeParse({ ...view, resettable: 'false' }).success).toBe(false)
  expect(computerEndpointViewSchema.safeParse({ ...view, target: undefined, protocol: 'messages',
    origin: 'https://example.invalid', inheritedOrigin: 'https://example.invalid' }).success).toBe(false)
})
