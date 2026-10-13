import { z } from 'zod'
import { providerRouteSchema } from './remote-provider-settings.js'
import { computerEndpointUrlSchema } from './remote-endpoint.js'
import { providerModelRowSchema } from './remote-provider-models.js'

// 创建没有历史行source；只接受原创建界面公开的模型属性。
const creationRow = providerModelRowSchema.pick({ id: true, name: true, contextWindow: true, maxTokens: true }).extend({
  input: z.array(z.enum(['text', 'image'])).min(1).max(2)
    .refine(values => new Set(values).size === values.length).optional(),
}).strict()
const creationModels = z.union([
  z.array(z.string().min(1).max(1024)).min(1).max(1000),
  z.array(creationRow).min(1).max(1000),
]).refine(rows => new Set(rows.map(row => typeof row === 'string' ? row : row.id)).size === rows.length)

const common = { method: z.literal('remote.providerCreationWrite'), snapshot: z.uuid(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), useKey: z.boolean(),
  name: z.string().max(256), confirmed: z.literal(true) }
export const providerCreationWriteSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('catalog'), provider: providerRouteSchema }).strict(),
  z.object({ ...common, kind: z.literal('custom'), provider: providerRouteSchema.refine(value => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)),
    api: z.string().min(1).max(128), baseURL: computerEndpointUrlSchema,
    models: creationModels,
  }).strict(),
])
export type ProviderCreationWrite = z.infer<typeof providerCreationWriteSchema>
export const providerCreationViewSchema = z.object({
  snapshot: z.uuid(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), writable: z.boolean(),
  applies: z.enum(['live', 'restart']), keyAvailable: z.boolean(),
  protocols: z.array(z.string().min(1).max(128)).min(1).max(64),
  taken: z.array(providerRouteSchema).max(2048),
  available: z.array(z.object({ provider: providerRouteSchema, name: z.string().min(1).max(256) }).strict()).max(1024),
  created: z.object({ provider: providerRouteSchema, useKey: z.boolean() }).strict().optional(),
}).strict()
