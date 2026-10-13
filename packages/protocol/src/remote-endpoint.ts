import { z } from 'zod'
import { providerRouteSchema } from './remote-provider-settings.js'

export const computerEndpointTargetSchema = z.union([
  z.literal('web-search-deepseek'), z.object({ provider: providerRouteSchema }).strict(),
])

export const computerEndpointUrlSchema = z.string().min(1).max(2048).refine(value => {
  if (/\s|[\\\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return /^https?:\/\//.test(value) && ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
})
export const computerEndpointReadSchema = z.object({
  method: z.literal('remote.endpointRead'), target: computerEndpointTargetSchema.optional(),
  resetPolicy: z.literal(true).optional(),
}).strict().refine(value => value.resetPolicy === undefined || typeof value.target === 'object')
export const computerEndpointWriteSchema = z.object({
  method: z.literal('remote.endpointWrite'), snapshot: z.uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  target: computerEndpointTargetSchema.optional(),
  resetPolicy: z.literal(true).optional(),
  confirmed: z.literal(true),
  change: z.discriminatedUnion('op', [
    z.object({ op: z.literal('set'), value: computerEndpointUrlSchema }).strict(),
    z.object({ op: z.literal('unset') }).strict(),
  ]),
}).strict().refine(value => value.resetPolicy === undefined || typeof value.target === 'object')
export type ComputerEndpointWrite = z.infer<typeof computerEndpointWriteSchema>
// 不返回旧路径、查询参数、用户名或密码，origin 仅用于显示请求目的站点。
const origin = computerEndpointUrlSchema.refine(value => { try { return new URL(value).origin === value } catch { return false } })
export const computerEndpointViewSchema = z.object({
  snapshot: z.uuid(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), writable: z.boolean(),
  target: computerEndpointTargetSchema.optional(),
  applies: z.enum(['live', 'restart']), protocol: z.enum(['messages', 'chat-completions', 'provider']),
  origin: origin.nullable(), inheritedOrigin: origin.nullable(), customPath: z.boolean(), overridden: z.boolean(),
  resettable: z.boolean().optional(),
}).strict().refine(view => typeof view.target === 'object'
  ? view.protocol === 'provider'
  : view.protocol !== 'provider' && view.origin !== null && view.inheritedOrigin !== null && view.resettable === undefined)
