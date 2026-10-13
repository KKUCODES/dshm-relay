import { z } from 'zod'
import { providerRouteSchema } from './remote-provider-settings.js'

export const computerKeyTargetSchema = z.union([z.literal('web-search-deepseek'), z.object({ provider: providerRouteSchema }).strict()])

// 目标由 Host 的已审阅模型适配确定，手机不能指定 credential ref 或记录地址。
export const computerKeyWriteSchema = z.object({
  method: z.literal('remote.keyWrite'), snapshot: z.uuid(),
  target: computerKeyTargetSchema.optional(),
  change: z.discriminatedUnion('op', [
    z.object({ op: z.literal('set'), value: z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/) }).strict(),
    z.object({ op: z.literal('unset') }).strict(),
  ]),
}).strict()
export type ComputerKeyWrite = z.infer<typeof computerKeyWriteSchema>
export const computerKeyViewSchema = z.object({
  snapshot: z.uuid(), provider: providerRouteSchema, configured: z.boolean(), writable: z.boolean(),
  target: z.object({ provider: providerRouteSchema }).strict().optional(),
}).strict().refine(view => view.target ? view.target.provider === view.provider : ['deepseek-official', 'deepseek-search'].includes(view.provider))
