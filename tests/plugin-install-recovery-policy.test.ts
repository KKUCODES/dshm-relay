import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { remoteEndpoints, remotePermission, remoteRequestAllowed } from '../packages/protocol/src/remote-policy.js'

test('新版丢失安装回执查询只向管理设备公布，旧版不开放', () => {
  const endpoint = 'pluginManager/waitForInstall'
  expect(remotePermission(endpoint, false)).toBe('management')
  expect(remotePermission(endpoint, true)).toBeUndefined()
  expect(remoteEndpoints(false, false, 'target').calls).not.toContain(endpoint)
  expect(remoteEndpoints(true).calls).not.toContain(endpoint)
  expect(remoteEndpoints(true, false, 'target').calls).toContain(endpoint)
  const payload = { args: { requestId: randomUUID() } }
  expect(remoteRequestAllowed(endpoint, payload)).toBe(false)
  for (const contract of ['target', 'either'] as const) {
    expect(remoteRequestAllowed(endpoint, payload, contract)).toBe(true)
    for (const invalid of [{}, { args: null }, { args: [] }, { args: {} }, { args: { requestId: '' } },
      { args: { requestId: 'x'.repeat(129) } }, { args: { requestId: payload.args.requestId + '\n' } },
      { args: { requestId: payload.args.requestId, spec: 'another-install' } },
      { args: { requestId: payload.args.requestId, signal: {} } }, { ...payload, path: '/api' }])
      expect(remoteRequestAllowed(endpoint, invalid, contract), JSON.stringify(invalid)).toBe(false)
  }
})
