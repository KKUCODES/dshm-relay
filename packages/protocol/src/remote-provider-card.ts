import { z } from 'zod'
import { providerRouteSchema } from './remote-provider-settings.js'

// 原 provider-card owner 的公开目录投影；不携带配置正文、凭据引用或原始错误。
export const providerCardViewSchema = z.object({
  provider: z.object({
    provider: providerRouteSchema, displayName: z.string().min(1).max(256),
    settingsNs: z.string().min(1).max(256),
    settingsPath: z.array(z.string().min(1).max(256).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value))).max(16),
    active: z.boolean(), declared: z.boolean().optional(), error: z.literal('提供方暂不可用').optional(),
  }).strict(),
  configured: z.boolean(), keyConfigured: z.boolean(),
}).strict()
