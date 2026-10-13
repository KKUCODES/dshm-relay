import { z } from 'zod'
import { presetManagementReadSchema, presetCopySchema, presetDeleteSchema } from './remote-presets.js'
export { remotePresetIdSchema, presetManagementReadSchema, presetCopySchema, presetDeleteSchema, presetManagementViewSchema } from './remote-presets.js'
export type { PresetCopy, PresetDelete } from './remote-presets.js'
import { computerSettingsWriteSchema, pluginSettingsNamespaceSchema } from './remote-settings.js'
import { computerKeyWriteSchema, computerKeyTargetSchema } from './remote-key.js'
import { providerRouteSchema, providerSettingsWriteSchema, providerKeySetupSchema } from './remote-provider-settings.js'
import { providerRemovalReadSchema, providerRemovalWriteSchema } from './remote-provider-removal.js'
import { providerCreationWriteSchema } from './remote-provider-creation.js'
export { providerCreationWriteSchema, providerCreationViewSchema } from './remote-provider-creation.js'
export type { ProviderCreationWrite } from './remote-provider-creation.js'
export { providerRemovalReadSchema, providerRemovalWriteSchema, providerRemovalViewSchema } from './remote-provider-removal.js'
export type { ProviderRemovalWrite } from './remote-provider-removal.js'
import { providerModelsWriteSchema, deepSeekModelsWriteSchema } from './remote-provider-models.js'
import { providerModelsDiscoverSchema } from './remote-model-discovery.js'
export { providerModelsDiscoverSchema, providerModelsDiscoveryViewSchema } from './remote-model-discovery.js'
import { modelProbePrepareSchema, modelProbeExecuteSchema } from './remote-model-probe.js'
export { modelProbePrepareSchema, modelProbeExecuteSchema, modelProbePreparedSchema, modelProbeResultSchema } from './remote-model-probe.js'
export type { ModelProbePrepare, ModelProbeExecute, ModelProbePrepared } from './remote-model-probe.js'
export { providerModelRowSchema, providerModelsViewSchema, providerModelsWriteSchema, deepSeekModelsWriteSchema } from './remote-provider-models.js'
export type { ProviderModelsWrite } from './remote-provider-models.js'
export { modelCompatBooleans, modelCompatEnums, modelCompatTemplates, modelCompatKeys, modelCompatSchema } from './remote-model-compat.js'
export { providerRouteSchema, providerSettingValues, providerSettingsWriteSchema, providerSettingsViewSchema, providerDirectorySchema, providerKeySetupSchema } from './remote-provider-settings.js'
export { providerCardViewSchema } from './remote-provider-card.js'
export { modelReadinessSchema } from './remote-model-readiness.js'
export type { ProviderKeySetup } from './remote-provider-settings.js'
export type { ProviderSettingsWrite } from './remote-provider-settings.js'
import { computerEndpointWriteSchema, computerEndpointReadSchema } from './remote-endpoint.js'
export { computerEndpointUrlSchema, computerEndpointReadSchema, computerEndpointWriteSchema, computerEndpointViewSchema, computerEndpointTargetSchema } from './remote-endpoint.js'
export type { ComputerEndpointWrite } from './remote-endpoint.js'
export { computerKeyWriteSchema, computerKeyViewSchema, computerKeyTargetSchema } from './remote-key.js'
export type { ComputerKeyWrite } from './remote-key.js'
export { computerSettingValues, computerSettingsWriteSchema, computerSettingsViewSchema } from './remote-settings.js'
export { pluginSettingValues, pluginSettingsViewSchema, pluginSettingsNamespaceSchema } from './remote-settings.js'
export type { ComputerSettingsWrite } from './remote-settings.js'
export { remotePermission, remoteEndpoints, remoteRequestAllowed } from './remote-policy.js'

export const PROTOCOL_VERSION = 1
// 向后兼容六方法；扩展传输必须先协商，不能把旧 Host 当作完整客户端。
export const REMOTE_TRANSPORT_VERSION = 2
export const RESOURCE_CHUNK_BYTES = 64 * 1024
export const RESOURCE_WINDOW = 4
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024
export const MAX_FRAME_BYTES = 2 * 1024 * 1024
export const MAX_OFFICE_PDF_BYTES = 32 * 1024 * 1024
export const MAX_CHANGES_BYTES = 32 * 1024 * 1024
export const MAX_SESSION_EXPORT_BYTES = 256 * 1024 * 1024
export const attachmentRefSchema = z.object({
  attachmentId: z.string().min(1).max(512), name: z.string().min(1).max(255).optional(),
  bytes: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']).optional(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  originalDimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
}).strict()
export const officeMetadataSchema = z.object({
  absolutePath: z.string().min(1).max(4096), version: z.string().min(1).max(4096),
  bytes: z.number().int().min(1).max(MAX_OFFICE_PDF_BYTES), generation: z.string().min(1).max(200),
  missingFonts: z.array(z.string().max(255)).max(256),
}).strict()
export const attachmentOfficeMetadataSchema = officeMetadataSchema.omit({ absolutePath: true, version: true }).extend({
  attachmentId: z.string().min(1).max(512), name: z.string().min(1).max(255),
}).strict()
const sessionId = z.string().min(1).max(200)
const pageSize = z.number().int().min(1).max(100).optional()
const address = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId }).strict(),
  z.object({ kind: z.literal('subagent'), parentSessionId: sessionId, childSessionId: sessionId,
    mode: z.enum(['one-shot', 'continuable']) }).strict(),
])

export const operationSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('remote.pluginOperationStart'), generation: z.uuid(), operationId: z.uuid(),
    endpoint: z.enum(['pluginManager/installBundle', 'pluginManager/removeBundle', 'pluginManager/setBundleEnabled', 'pluginManager/setPluginEnabled']),
    payload: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ method: z.literal('remote.pluginOperationRead'), generation: z.uuid(), operationId: z.uuid() }).strict(),
  z.object({ method: z.literal('remote.pluginOperations') }).strict(),
  z.object({ method: z.literal('remote.negotiate'), version: z.literal(REMOTE_TRANSPORT_VERSION) }).strict(),
  z.object({ method: z.literal('remote.graph') }).strict(),
  z.object({ method: z.literal('remote.graphFollow') }).strict(),
  z.object({ method: z.literal('remote.subagentStateFollow') }).strict(),
  z.object({ method: z.literal('remote.taskFollow'), previewVersion: z.literal(1).optional() }).strict(),
  z.object({ method: z.literal('remote.feedbackFollow'), sessionId: sessionId.regex(/^[^\x00-\x1f\x7f]+$/u) }).strict(),
  z.object({ method: z.literal('remote.desktop') }).strict(),
  z.object({ method: z.literal('remote.desktopApps'), sessionId }).strict(),
  z.object({ method: z.literal('remote.desktopAppIcon'), sessionId,
    appId: z.string().min(1).max(80).regex(/^[a-z][a-z0-9-]*$/) }).strict(),
  z.object({ method: z.literal('remote.prepareDesktopApp'), sessionId,
    appId: z.string().min(1).max(80).regex(/^[a-z][a-z0-9-]*$/) }).strict(),
  z.object({ method: z.literal('remote.openDesktopApp'), sessionId, snapshot: z.uuid(), confirmed: z.literal(true) }).strict(),
  z.object({ method: z.literal('remote.openFile'), source: z.enum(['presented', 'changes']), sessionId,
    seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    confirmed: z.literal(true), action: z.enum(['open', 'reveal']).optional() }).strict()
    .refine(value => value.action !== 'reveal' || value.source === 'presented'),
  z.object({ method: z.literal('remote.prepareDesktopFile'), sessionId,
    path: z.string().min(1).max(4096).refine(value => !/[\x00-\x1f\x7f]/.test(value)
      && !/^[\\/]{2}/.test(value) && (!/^[a-z][a-z\d+.-]*:/i.test(value) || /^[a-z]:[\\/]/i.test(value))) }).strict(),
  z.object({ method: z.literal('remote.openDesktopFile'), sessionId, snapshot: z.uuid(), confirmed: z.literal(true) }).strict(),
  z.object({ method: z.literal('remote.prepareDesktopAttachment'), sessionId, kind: z.enum(['file', 'image']),
    attachmentId: z.string().min(1).max(512), name: z.string().min(1).max(255).optional() }).strict(),
  z.object({ method: z.literal('remote.openDesktopAttachment'), sessionId, snapshot: z.uuid(), confirmed: z.literal(true) }).strict(),
  z.object({ method: z.literal('remote.settingsRead'), namespace: pluginSettingsNamespaceSchema.optional() }).strict(),
  z.object({ method: z.literal('remote.codingToolsRead') }).strict(),
  presetManagementReadSchema,
  presetCopySchema,
  presetDeleteSchema,
  computerSettingsWriteSchema,
  z.object({ method: z.literal('remote.providerSettingsList') }).strict(),
  z.object({ method: z.literal('remote.providerCardRead'), provider: providerRouteSchema }).strict(),
  z.object({ method: z.literal('remote.modelReadiness') }).strict(),
  z.object({ method: z.literal('remote.providerSettingsRead'), provider: providerRouteSchema }).strict(),
  providerSettingsWriteSchema,
  providerKeySetupSchema,
  providerRemovalReadSchema,
  providerRemovalWriteSchema,
  z.object({ method: z.literal('remote.providerCreationRead') }).strict(),
  providerCreationWriteSchema,
  z.object({ method: z.literal('remote.providerModelsRead'), provider: providerRouteSchema, scope: z.literal('overrides').optional() }).strict(),
  providerModelsWriteSchema,
  z.object({ method: z.literal('remote.deepSeekModelsRead') }).strict(),
  deepSeekModelsWriteSchema,
  providerModelsDiscoverSchema,
  modelProbePrepareSchema,
  modelProbeExecuteSchema,
  z.object({ method: z.literal('remote.keyRead'), target: computerKeyTargetSchema.optional() }).strict(),
  computerEndpointReadSchema,
  computerEndpointWriteSchema,
  computerKeyWriteSchema,
  z.object({ method: z.literal('remote.sessionExport'), sessionId, includeDescendants: z.boolean() }).strict(),
  z.object({ method: z.literal('remote.jobStop'), sessionId, jobId: z.string().min(1).max(200),
    startedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), generation: z.uuid() }).strict(),
  z.object({ method: z.literal('remote.jobOutput'), sessionId, jobId: z.string().min(1).max(200),
    startedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), generation: z.uuid(),
    stream: z.enum(['stdout', 'stderr']), fromByte: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      maxBytes: z.number().int().min(1).max(RESOURCE_CHUNK_BYTES) }).strict(),
  z.object({ method: z.literal('remote.commandOutput'), sessionId,
    rootCallId: z.string().min(1).max(200), callId: z.string().min(1).max(200),
    rootCallTime: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), generation: z.uuid(), outputId: z.uuid().optional(),
    stream: z.enum(['stdout', 'stderr']), fromByte: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    maxBytes: z.number().int().min(1).max(RESOURCE_CHUNK_BYTES) }).strict(),
  z.object({ method: z.literal('remote.changes'), sessionId, seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  z.object({ method: z.literal('remote.resource'), path: z.string().min(1).max(4096), verb: z.enum(['GET', 'HEAD']) }).strict(),
  z.object({ method: z.literal('remote.upload'), sessionId, name: z.string().max(255).optional() }).strict(),
  // 仅原普通/子会话 prompt；字节通过已有 uploadChunk 窗口发送。
  z.object({ method: z.literal('remote.prompt'), rpcId: z.uuid(), endpoint: z.enum(['session/prompt', 'subagents/prompt']).optional() }).strict(),
  z.object({ method: z.literal('remote.attachment'), sessionId, kind: z.enum(['file', 'image']),
    attachmentId: z.string().min(1).max(512), name: z.string().min(1).max(255).optional() }).strict(),
  z.object({ method: z.literal('remote.office'), sessionId,
    priority: z.enum(['foreground', 'background']).optional(),
    path: z.string().min(1).max(4096).regex(/\.(docx?|xlsx?|pptx?)$/i).refine(value => !value.includes('\0')) }).strict(),
  z.object({ method: z.literal('remote.attachmentOffice'), sessionId, attachmentId: z.string().min(1).max(512),
    priority: z.enum(['foreground', 'background']).optional(),
    name: z.string().min(1).max(255).regex(/\.(docx?|xlsx?|pptx?)$/i).refine(value => !/[\\/\0]/.test(value)) }).strict(),
  z.object({ method: z.enum(['remote.rpc', 'remote.stream']), endpoint: z.string().min(1).max(200),
    payload: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ method: z.literal('session.list') }).strict(),
  z.object({ method: z.literal('session.page'), address, throughSeq: z.number().int().min(-1),
    beforeSeq: z.number().int().min(0).optional(), maxMessages: pageSize }).strict(),
  z.object({ method: z.literal('session.follow'), address, maxMessages: pageSize }).strict(),
  z.object({ method: z.literal('session.control') }).strict(),
  z.object({ method: z.literal('session.prompt'), sessionId, requestId: z.uuid(),
    mode: z.enum(['queue', 'steer']), text: z.string().min(1).max(64000).refine(value => value.trim().length > 0) }).strict(),
  z.object({ method: z.literal('session.cancel'), sessionId }).strict(),
])
export type Operation = z.infer<typeof operationSchema>
const uploadChunk = z.object({ type: z.literal('uploadChunk'), id: z.uuid(),
  data: z.string().min(4).max(87384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict()
const uploadEnd = z.object({ type: z.literal('uploadEnd'), id: z.uuid() }).strict()
export const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), id: z.uuid(), operation: operationSchema }).strict(),
  z.object({ type: z.literal('cancel'), id: z.uuid() }).strict(),
  z.object({ type: z.literal('ack'), id: z.uuid(), count: z.number().int().min(1).max(RESOURCE_WINDOW) }).strict(),
  uploadChunk, uploadEnd,
])
export type ClientFrame = z.infer<typeof clientFrameSchema>
// 此信封仅由已鉴权网关生成，手机不能提交/覆盖设备、电脑或管理权限。
export const remoteContextSchema = z.object({ deviceId: z.uuid(), hostId: z.uuid(), connectionId: z.uuid(), management: z.boolean() }).strict()
export type RemoteContext = z.infer<typeof remoteContextSchema>
export const routedFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), id: z.uuid(), operation: operationSchema, context: remoteContextSchema.optional() }).strict(),
  z.object({ type: z.literal('cancel'), id: z.uuid() }).strict(),
  z.object({ type: z.literal('ack'), id: z.uuid(), count: z.number().int().min(1).max(RESOURCE_WINDOW) }).strict(),
  uploadChunk, uploadEnd,
])
export const hostFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('result'), id: z.uuid(), value: z.unknown() }).strict(),
  z.object({ type: z.literal('event'), id: z.uuid(), value: z.unknown() }).strict(),
  z.object({ type: z.literal('end'), id: z.uuid() }).strict(),
  z.object({ type: z.literal('error'), id: z.uuid(), code: z.string().min(1).max(100) }).strict(),
])
export type HostFrame = z.infer<typeof hostFrameSchema>
export const isStream = (operation: Operation): boolean => ['session.follow', 'session.control', 'remote.stream', 'remote.graphFollow', 'remote.subagentStateFollow', 'remote.feedbackFollow', 'remote.taskFollow', 'remote.resource', 'remote.upload', 'remote.prompt', 'remote.office', 'remote.attachment', 'remote.attachmentOffice', 'remote.changes', 'remote.sessionExport'].includes(operation.method)
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const labelSchema = z.string().trim().min(1).max(80)
