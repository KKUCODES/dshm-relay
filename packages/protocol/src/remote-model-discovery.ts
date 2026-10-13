import { z } from 'zod'
import { providerRouteSchema } from './remote-provider-settings.js'

// 请求只能指定已保存的路由，地址、认证和协议均由电脑原设置解析。
export const providerModelsDiscoverSchema = z.object({ method: z.literal('remote.providerModelsDiscover'), provider: providerRouteSchema }).strict()
export const providerModelsDiscoveryViewSchema = z.object({ provider: providerRouteSchema,
  rows: z.array(z.object({ id: z.string().min(1).max(1024), name: z.string().max(1024).optional(),
    contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    inputModalities: z.array(z.enum(['text', 'image'])).max(2).optional(),
  }).strict()).max(1000).refine(rows => new Set(rows.map(row => row.id)).size === rows.length),
}).strict()
