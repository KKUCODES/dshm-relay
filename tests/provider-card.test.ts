import { expect, test } from 'vitest'
import { operationSchema, providerCardViewSchema } from '../packages/protocol/src/index.js'

test('卡片只读请求只能指定路由，响应不接受配置或凭据', () => {
  const request = { method: 'remote.providerCardRead', provider: 'deepseek-official' }
  expect(operationSchema.safeParse(request).success).toBe(true)
  for (const extra of [{ ref: 'OTHER_KEY' }, { settingsNs: 'other' }, { settingsPath: [] }, { value: 'secret' }])
    expect(operationSchema.safeParse({ ...request, ...extra }).success).toBe(false)
  const row = { provider: { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
    configured: true, keyConfigured: true }
  expect(providerCardViewSchema.safeParse(row).success).toBe(true)
  expect(providerCardViewSchema.safeParse({ ...row, apiKey: 'secret' }).success).toBe(false)
  expect(providerCardViewSchema.safeParse({ ...row, provider: { ...row.provider, error: 'raw secret error' } }).success).toBe(false)
})
