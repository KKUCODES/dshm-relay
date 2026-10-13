import { z } from 'zod'

// 只列已核验的原 llm-deepseek 选项；配置地址、Key、schema 和自定义字段不跨网关。
export const computerSettingValues = {
  thinking: z.enum(['enabled', 'disabled']),
  reasoningEffort: z.enum(['off', 'low', 'high', 'max']),
  maxTokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  defaultContextWindow: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  streamIdleTimeoutMs: z.number().positive().max(2147483647),
} as const
const modelRoutes = z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict())
  .refine(routes => new Set(routes.map(route => `${route.provider}\0${route.model}`)).size === routes.length)
const presetId = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/)
const pluginValue = z.union([z.number(), z.boolean(), modelRoutes, presetId])
// 只投影已核验的原表单字段；shell 的 cwd、pwshPath 等配置不跨设备。
export const pluginSettingValues = {
  shell: { timeoutMs: z.number().positive().max(Number.MAX_SAFE_INTEGER), maxOutputBytes: z.number().positive().max(Number.MAX_SAFE_INTEGER) },
  'agent-loop': { maxParallelToolCalls: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) },
  subagent: { maxDepth: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).refine(value => !Object.is(value, -0)),
    maxActiveSubagents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) },
  'subagent-model-selection': { enabled: z.boolean(), allowedModels: modelRoutes },
  'web-search-deepseek': { maxUses: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) },
  'agent-preset-registry': { selectedDefault: presetId },
  'ui-settings': { enabled: z.boolean() },
} as const
export const pluginSettingsNamespaceSchema = z.enum(['shell', 'agent-loop', 'subagent', 'subagent-model-selection', 'web-search-deepseek', 'agent-preset-registry', 'ui-settings'])
export const computerSettingKeySchema = z.enum(['thinking', 'reasoningEffort', 'maxTokens', 'defaultContextWindow', 'streamIdleTimeoutMs'])
const pluginKey = z.enum(['timeoutMs', 'maxOutputBytes', 'maxParallelToolCalls', 'maxDepth', 'maxActiveSubagents', 'enabled', 'allowedModels', 'maxUses', 'selectedDefault'])
const editableKey = z.enum([...computerSettingKeySchema.options, ...pluginKey.options])
export const computerSettingEditSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), key: editableKey, value: z.union([z.string().max(16), pluginValue]) }).strict(),
  z.object({ op: z.literal('unset'), key: editableKey }).strict(),
])
export const computerSettingsWriteSchema = z.object({
  method: z.literal('remote.settingsWrite'), snapshot: z.uuid(),
  namespace: pluginSettingsNamespaceSchema.optional(),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  edits: z.array(computerSettingEditSchema).min(1).max(5)
    .refine(edits => new Set(edits.map(edit => edit.key)).size === edits.length),
}).strict().refine(operation => {
  const values: Record<string, z.ZodType> = operation.namespace ? pluginSettingValues[operation.namespace] : computerSettingValues
  return operation.edits.every(edit => Object.hasOwn(values, edit.key) && (edit.op === 'unset' || values[edit.key]!.safeParse(edit.value).success))
})
export type ComputerSettingsWrite = z.infer<typeof computerSettingsWriteSchema>
export const computerSettingsViewSchema = z.object({
  snapshot: z.uuid(), namespace: z.literal('llm-deepseek'),
  documentId: z.string().min(1).max(1024).optional(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), writable: z.boolean(), applies: z.enum(['live', 'restart']),
  fields: z.array(z.object({ key: computerSettingKeySchema, value: z.union([z.string().max(16), z.number()]).optional(), overridden: z.boolean() }).strict()
    .refine(field => field.value === undefined || computerSettingValues[field.key].safeParse(field.value).success)).length(5)
    .refine(fields => new Set(fields.map(field => field.key)).size === 5),
}).strict()

export const pluginSettingsViewSchema = z.object({
  snapshot: z.uuid(), namespace: pluginSettingsNamespaceSchema,
  documentId: z.string().min(1).max(1024).optional(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), writable: z.boolean(), applies: z.enum(['live', 'restart']),
  fields: z.array(z.object({ key: pluginKey,
    value: pluginValue.optional(), base: pluginValue.optional(), user: pluginValue.optional(), overridden: z.boolean() }).strict()).min(1).max(2),
}).strict().refine(view => {
  const values: Record<string, z.ZodType> = pluginSettingValues[view.namespace]
  return view.fields.length === Object.keys(values).length && new Set(view.fields.map(field => field.key)).size === view.fields.length
    && view.fields.every(field => Object.hasOwn(values, field.key)
      && [field.value, field.base, field.user].every(value => value === undefined || values[field.key]!.safeParse(value).success)
      && field.overridden === (field.user !== undefined))
})
