import { z } from 'zod'
import { computerEndpointUrlSchema } from './remote-endpoint.js'
import { providerRouteSchema } from './remote-provider-settings.js'
import { providerModelsDiscoveryViewSchema } from './remote-model-discovery.js'

// 草稿探测只覆盖原发现器明确支持的协议，不猜测其他协议的认证或目录格式。
const target = {
  baseURL: computerEndpointUrlSchema,
  api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
}
const authentication = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('temporary') }).strict(),
  z.object({ mode: z.literal('stored'), provider: providerRouteSchema }).strict(),
])
export const modelProbePrepareSchema = z.object({
  method: z.literal('remote.modelProbePrepare'), ...target, authentication,
}).strict()

// 仅返回本次用户提交的公开目标及认证来源；不返回旧headers、凭据引用或Key。
export const modelProbePreparedSchema = z.object({
  snapshot: z.uuid(), expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ...target, authentication,
}).strict()
const execution = { method: z.literal('remote.modelProbeExecute'), snapshot: z.uuid(), confirmed: z.literal(true) }
export const modelProbeExecuteSchema = z.discriminatedUnion('mode', [
  z.object({ ...execution, mode: z.literal('none') }).strict(),
  z.object({ ...execution, mode: z.literal('stored') }).strict(),
  // 只允许原生通道组装此分支；服务端不得记录请求正文或持久化该值。
  z.object({ ...execution, mode: z.literal('temporary'), apiKey: z.string().min(1).max(8192)
    .refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)) }).strict(),
])
export const modelProbeResultSchema = providerModelsDiscoveryViewSchema.pick({ rows: true })
export type ModelProbePrepare = z.infer<typeof modelProbePrepareSchema>
export type ModelProbeExecute = z.infer<typeof modelProbeExecuteSchema>
export type ModelProbePrepared = z.infer<typeof modelProbePreparedSchema>
