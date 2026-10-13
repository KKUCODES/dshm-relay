import { expect, test } from 'vitest'
import { remoteEndpoints, remotePermission, remoteRequestAllowed } from '../packages/protocol/src/remote-policy.js'

test('原插件清单只向管理设备开放，且只接受无参读取', () => {
  expect(remotePermission('pluginInventory/list', false)).toBe('management')
  expect(remotePermission('pluginInventory/list', true)).toBeUndefined()
  expect(remoteEndpoints(false).calls).not.toContain('pluginInventory/list')
  expect(remoteEndpoints(true).calls).toContain('pluginInventory/list')
  expect(remoteRequestAllowed('pluginInventory/list', { args: {} })).toBe(true)
  for (const args of [undefined, null, [], { config: true }, { credentials: true }]) {
    expect(remoteRequestAllowed('pluginInventory/list', { args })).toBe(false)
  }
})
