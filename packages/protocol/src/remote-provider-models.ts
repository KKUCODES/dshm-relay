import { z } from 'zod'
import { providerRouteSchema } from './remote-provider-settings.js'
import { modelCompatSchema, modelCompatViewSchema } from './remote-model-compat.js'

const capacity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const efforts = z.partialRecord(z.enum(levels), z.string().max(1024).nullable())
const advancedView = z.object({ input: z.array(z.enum(['text', 'image'])).max(2).optional(),
  reasoningEfforts: z.union([z.literal(false), efforts, z.null()]).optional(),
}).strict()
const advancedWrite = advancedView.refine(value => {
  if (value.input && new Set(value.input).size !== value.input.length) return false
  const entries = value.reasoningEfforts
  if (entries === undefined || entries === false) return true
  return entries !== null && Object.keys(entries).some(key => key !== 'off')
    && Object.entries(entries).every(([key, value]) => key === 'off' && value === null || typeof value === 'string' && value.length > 0)
})
// source 仅为当前快照中的行标识；未公开的模型字段保留在电脑端。
export const providerModelRowSchema = z.object({ source: z.uuid().optional(), id: z.string().min(1).max(1024),
  name: z.string().max(1024).optional(), contextWindow: capacity.optional(), maxTokens: capacity.optional(),
  // 缺省保留旧客户端未编辑的字段；显式对象只替换这组已开放字段，{} 表示继承。
  advanced: advancedWrite.optional(),
  // 缺省保留未编辑的兼容配置；显式对象替换已公开字段，{} 恢复它们的继承。
  compat: modelCompatSchema.optional(),
}).strict()
const rows = z.array(providerModelRowSchema).max(1000).refine(rows => new Set(rows.map(row => row.id)).size === rows.length)
  .refine(rows => { const ids = rows.flatMap(row => row.source ? [row.source] : []); return new Set(ids).size === ids.length })
export const providerModelsViewSchema = z.object({ provider: providerRouteSchema, snapshot: z.uuid(),
  scope: z.literal('overrides').optional(), blockedByModels: z.boolean().optional(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), writable: z.boolean(),
  applies: z.enum(['live', 'restart']), overridden: z.boolean(),
  advancedEditable: z.boolean().optional(),
  compatEditable: z.boolean().optional(),
  // 原配置可能已有重复/空ID诊断，读取时仍允许修复；提交时才要求唯一且非空。
  rows: z.array(providerModelRowSchema.extend({ source: z.uuid(), id: z.string().max(1024), advanced: advancedView.optional(), compat: modelCompatViewSchema.optional() })).max(1000),
}).strict()
export const providerModelsWriteSchema = z.object({ method: z.literal('remote.providerModelsWrite'), provider: providerRouteSchema,
  scope: z.literal('overrides').optional(),
  snapshot: z.uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  change: z.discriminatedUnion('op', [z.object({ op: z.literal('set'), rows }).strict(), z.object({ op: z.literal('unset') }).strict()]),
}).strict().refine(value => value.scope !== 'overrides' || value.change.op === 'unset' || value.change.rows.every(row =>
  !['__proto__', 'constructor', 'prototype'].includes(row.id) && !/[\x00-\x1f\x7f]/.test(row.id)))
export type ProviderModelsWrite = z.infer<typeof providerModelsWriteSchema>

// 官方适配器使用 inputModalities，且没有 pi-ai 的兼容/思考映射；不接受那些字段。
const deepSeekRow = providerModelRowSchema.omit({ compat: true, advanced: true }).extend({
  id: z.string().trim().min(1).max(1024), name: z.string().min(1).max(1024).optional(),
  advanced: z.object({ input: z.array(z.enum(['text', 'image'])).min(1).max(2)
    .refine(value => new Set(value).size === value.length).optional() }).strict().optional(),
})
export const deepSeekModelsWriteSchema = z.object({ method: z.literal('remote.deepSeekModelsWrite'),
  snapshot: z.uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  change: z.discriminatedUnion('op', [z.object({ op: z.literal('unset') }).strict(), z.object({ op: z.literal('set'),
    rows: z.array(deepSeekRow).max(1000).refine(rows => new Set(rows.map(row => row.id)).size === rows.length)
      .refine(rows => { const sources = rows.flatMap(row => row.source ? [row.source] : []); return new Set(sources).size === sources.length }),
  }).strict()]),
}).strict()
