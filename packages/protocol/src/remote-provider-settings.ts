import { z } from 'zod'
import { modelCompatSchema, modelCompatViewSchema } from './remote-model-compat.js'

export const providerRouteSchema = z.string().min(1).max(256).refine(value =>
  !['__proto__', 'prototype', 'constructor'].includes(value) && !/[\x00-\x1f\x7f]/.test(value))
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
// 原pi-ai配置的标量字段；地址、headers、认证与模型列表走各自审阅过的通道。
export const providerSettingValues = {
  displayName: z.string().min(1).max(256),
  defaultContextWindow: integer, defaultMaxTokens: integer,
  streamIdleTimeoutMs: z.number().positive().max(2147483647),
  timeoutMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  cacheRetention: z.enum(['none', 'short', 'long']),
  transport: z.enum(['sse', 'websocket', 'websocket-cached', 'auto']),
} as const
export const providerSettingKeySchema = z.enum(['displayName', 'defaultContextWindow', 'defaultMaxTokens', 'streamIdleTimeoutMs', 'timeoutMs', 'cacheRetention', 'transport'])
export const providerDirectorySchema = z.object({ providers: z.array(z.object({
  provider: providerRouteSchema, name: z.string().min(1).max(256),
}).strict()).max(256).refine(rows => new Set(rows.map(row => row.provider)).size === rows.length) }).strict()
export const providerSettingsWriteSchema = z.object({
  method: z.literal('remote.providerSettingsWrite'), provider: providerRouteSchema,
  snapshot: z.uuid(), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  edits: z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('set'), key: providerSettingKeySchema, value: z.union([z.string(), z.number()]) }).strict(),
    z.object({ op: z.literal('unset'), key: providerSettingKeySchema }).strict(),
  ])).max(7).refine(edits => new Set(edits.map(edit => edit.key)).size === edits.length)
    .refine(edits => edits.every(edit => edit.op === 'unset' || providerSettingValues[edit.key].safeParse(edit.value).success)),
  compat: modelCompatSchema.optional(),
  protocolChange: z.object({ value: z.string().min(1).max(128), confirmed: z.literal(true) }).strict().optional(),
}).strict().refine(value => value.edits.length > 0 || value.compat !== undefined || value.protocolChange !== undefined)
export type ProviderSettingsWrite = z.infer<typeof providerSettingsWriteSchema>
export const providerKeySetupSchema = z.object({
  method: z.literal('remote.providerKeySetup'), provider: providerRouteSchema,
  snapshot: z.uuid(), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), confirmed: z.literal(true),
}).strict()
export type ProviderKeySetup = z.infer<typeof providerKeySetupSchema>
export const providerSettingsViewSchema = z.object({
  provider: providerRouteSchema, snapshot: z.uuid(), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  writable: z.boolean(), applies: z.enum(['live', 'restart']),
  keySetupAvailable: z.boolean().optional(),
  protocol: z.object({ value: z.string().min(1).max(128).optional(),
    choices: z.array(z.string().min(1).max(128)).min(1).max(64),
  }).strict().optional(),
  compat: z.object({ effective: modelCompatViewSchema, overrides: modelCompatViewSchema }).strict().optional(),
  fields: z.array(z.object({ key: providerSettingKeySchema, value: z.union([z.string(), z.number()]).optional(),
    overridden: z.boolean() }).strict().refine(field => field.value === undefined || providerSettingValues[field.key].safeParse(field.value).success))
    .length(7).refine(fields => new Set(fields.map(field => field.key)).size === 7),
}).strict()
