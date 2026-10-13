import { z } from 'zod'
import { providerRouteSchema } from './remote-provider-settings.js'

export const providerRemovalReadSchema = z.object({
  method: z.literal('remote.providerRemovalRead'), provider: providerRouteSchema,
}).strict()
export const providerRemovalWriteSchema = z.object({
  method: z.literal('remote.providerRemovalWrite'), provider: providerRouteSchema,
  snapshot: z.uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()
export type ProviderRemovalWrite = z.infer<typeof providerRemovalWriteSchema>
export const providerRemovalViewSchema = z.object({
  provider: providerRouteSchema, name: z.string().min(1).max(256), snapshot: z.uuid(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  writable: z.boolean(), removable: z.boolean(), removed: z.boolean(),
  keepsCredential: z.boolean(), applies: z.enum(['live', 'restart']),
}).strict()
