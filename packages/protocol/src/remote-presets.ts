import { z } from 'zod'

export const remotePresetIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/)
export const presetManagementReadSchema = z.object({ method: z.literal('remote.presetManagementRead'), preset: remotePresetIdSchema }).strict()
export const presetCopySchema = z.object({ method: z.literal('remote.presetCopy'), snapshot: z.uuid(),
  id: remotePresetIdSchema, name: z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/u) }).strict()
export const presetDeleteSchema = z.object({ method: z.literal('remote.presetDelete'), snapshot: z.uuid(), confirmed: z.literal(true) }).strict()
export const presetManagementViewSchema = z.object({ snapshot: z.uuid(), preset: remotePresetIdSchema,
  canCopy: z.boolean(), canDelete: z.boolean(), defaultAfterDelete: z.string().optional() }).strict()
export type PresetCopy = z.infer<typeof presetCopySchema>
export type PresetDelete = z.infer<typeof presetDeleteSchema>
