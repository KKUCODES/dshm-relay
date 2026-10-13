/** 依据已核验的旧版与固定0.2.1-alpha.1/alpha.2契约；未审阅的入口默认拒绝。 */
import { dynamicCordisCalls, cordisRequestAllowed } from './remote-cordis.js'
const basicCalls = new Set([
  'session/list', 'session/search', 'session/create', 'session/selectModel', 'session/modelCatalog',
  'session/rename', 'session/fork', 'session/prompt', 'session/attachment', 'session/updateQueue', 'session/cancel', 'session/page',
  // 原 Host 校验持久父子地址、可继续类型和当前执行归属。
  'subagents/list', 'subagents/prompt', 'subagents/interruptByParent',
  'workspace/archiveSession', 'workspace/unarchiveSession', 'skills/list', 'fileReferences/list',
  'sessionReferenceResolver/candidates',
  // 只读候选目录也供原输入框的附件菜单使用，不授予执行指令的权限。
  'commands/list', 'permissionPresets/catalog', 'terminal/list', '$events/result',
  // 仅接受下方校验的权限选择与计划模式开关，不是通用命令执行入口。
  'commands/execute',
  // 仅目录和空白会话选择，不开放预设文件、默认配置或增删预设。
  'agentPresets/list', 'agentPresets/select',
  // 原会话目标操作保留 Host 的版本校验，不接受任意工具或调度配置。
  'goals/get', 'goals/create', 'goals/edit', 'goals/pause', 'goals/resume', 'goals/complete', 'goals/clear',
  // 新版只读当前会话提醒；不开放Host总目录、创建、删除或修改。
  'schedule/list',
  // 反馈留在原会话日志，由 Host 校验消息身份、版本及配置的内容上限。
  'messageFeedback/list', 'messageFeedback/put', 'messageFeedback/delete', 'sessionFeedback/record',
  // 沿用 Host 会话解析和文件读取权限；只允许分页/有界字节窗，不开放整文件大 JSON。
  'workspaceFiles/stat', 'workspaceFiles/readBytes', 'workspaceFiles/read',
  // 只列出会话工作区内一个目录的直接子项；根目录与边界由原 Host 核验。
  'workspaceFiles/list',
  // 仅返回转换器代次，供缓存失效检查；不开放整份 PDF 的 render RPC。
  'officeToPdf/generation',
])
const managementCalls = new Set([
  // 旧版预设由原Host按已登记ID读取/复制/删除；不接受路径或组装源码。
  'agentPresets/read', 'agentPresets/copy', 'agentPresets/deletePreset',
  'settings/openAgentPresetDirectory',
  // 只允许下方固定agent-presets两字段补丁，不是通用设置写入。
  'settings/update',
  'workspace/rename', 'workspace/delete', 'workspace/insertBefore', 'workspace/insertSessionBefore',
  // 原插件页用此只读清单确认 profile 管理能力；不返回插件配置或凭据。
  'pluginInventory/list',
  'pluginManager/listPlugins', 'pluginManager/listBundles', 'pluginManager/inspect',
  'pluginManager/setPluginEnabled', 'pluginManager/setBundleEnabled', 'pluginManager/installBundle',
  'pluginManager/cancelInstall', 'pluginManager/removeBundle',
  // 新版原管理器核对丢失回执；null 只代表没有在途记录，不能推断成功或取消。
  'pluginManager/waitForInstall',
])
// alpha.1/alpha.2 已移除旧归档管理接口；中转兼容旧Host，由实际Host选择契约。
const legacyPresetCalls = new Set(['agentPresets/copy', 'agentPresets/deletePreset'])
const basicStreams = new Set(['session/follow', 'session/control', 'workspace/follow', '$events', 'workspaceFiles/changes'])
// 新版官方只对原调用计时/补答；不开放ask、askTimed或通用人机交互创建。
const targetCalls = new Set(['userQuestions/answer'])
const targetStreams = new Set(['job/list', 'userQuestions/attachWait'])
const projectionCall = 'session/projections'

export function remotePermission(endpoint: string, stream: boolean): 'basic' | 'management' | undefined {
  if (stream) return basicStreams.has(endpoint) || targetStreams.has(endpoint) ? 'basic' : undefined
  if (endpoint === projectionCall) return 'basic'
  if (targetCalls.has(endpoint)) return 'basic'
  if (basicCalls.has(endpoint)) return 'basic'
  if (dynamicCordisCalls.includes(endpoint)) return 'basic'
  if (managementCalls.has(endpoint)) return 'management'
  return undefined
}

export function remoteEndpoints(management: boolean, dynamicCordis = false, sessionContract: 'legacy' | 'target' = 'legacy', scheduleCatalog = false) {
  const calls = [...basicCalls].filter(endpoint => (sessionContract !== 'target' || endpoint !== 'subagents/list')
    && (endpoint !== 'schedule/list' || sessionContract === 'target' && scheduleCatalog))
  return { calls: [...calls, ...(sessionContract === 'target' ? [projectionCall, ...targetCalls] : []),
    ...(dynamicCordis ? dynamicCordisCalls : []), ...(management
      ? [...managementCalls].filter(endpoint => sessionContract === 'target'
        ? !legacyPresetCalls.has(endpoint) : endpoint !== 'pluginManager/waitForInstall') : [])],
    streams: [...basicStreams, ...(sessionContract === 'target' ? targetStreams : [])] }
}

/** 不重写 DSH 参数验证；这里只收紧手机端额外的产品边界。 */
export function remoteRequestAllowed(endpoint: string, payload: Record<string, unknown>, fileContract: 'legacy' | 'target' | 'either' = 'legacy'): boolean {
  if (fileContract === 'target' && legacyPresetCalls.has(endpoint)) return false
  if (endpoint === 'schedule/list') {
    const args = payload.args as Record<string, unknown> | undefined
    const request = args?.request as Record<string, unknown> | undefined
    return fileContract !== 'legacy' && Object.keys(payload).every(key => key === 'args')
      && !!args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every(key => key === 'request')
      && !!request && typeof request === 'object' && !Array.isArray(request) && Object.keys(request).every(key => key === 'sessionId')
      && typeof request.sessionId === 'string' && request.sessionId.length > 0 && request.sessionId.length <= 128
      && !/[\x00-\x1f\x7f]/u.test(request.sessionId)
  }
  if (endpoint === 'userQuestions/attachWait' || endpoint === 'userQuestions/answer') {
    // 使用已核对的官方Typert生成字段agentId/callId/answer；原Host继续校验live root及原问题归属。
    const args = payload.args as Record<string, unknown> | undefined
    const answering = endpoint === 'userQuestions/answer'
    const id = (value: unknown) => typeof value === 'string' && value.length > 0
      && value.length <= 200 && !/[\x00-\x1f\x7f]/u.test(value)
    if (fileContract === 'legacy' || Object.keys(payload).some(key => key !== 'args')
      || !args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['agentId', 'callId', ...(answering ? ['answer'] : [])].includes(key))
      || !id(args.agentId) || !id(args.callId)) return false
    if (!answering) return true
    const answer = args.answer as Record<string, unknown> | undefined
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)
      || Object.keys(answer).some(key => key !== 'answers') || !Array.isArray(answer.answers)
      || !answer.answers.length) return false
    const ids = new Set<string>()
    return answer.answers.every((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false
      const value = item as Record<string, unknown>
      if (Object.keys(value).some(key => !['id', 'selected', 'custom'].includes(key))
        || !id(value.id) || ids.has(value.id as string) || !Array.isArray(value.selected)
        || !value.selected.every((label: unknown) => typeof label === 'string')
        || (value.custom !== undefined && typeof value.custom !== 'string')) return false
      ids.add(value.id as string)
      return true
    })
  }
  if (endpoint === 'pluginManager/waitForInstall') {
    const args = payload.args as Record<string, unknown> | undefined
    return fileContract !== 'legacy' && Object.keys(payload).every(key => key === 'args')
      && !!args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every(key => key === 'requestId')
      && typeof args.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.requestId)
  }
  if (endpoint === 'job/list') {
    // 新版官方 job.list(request, signal) 只观察会话可见任务；归属仍由原 Host 校验。
    const args = payload.args as Record<string, unknown> | undefined
    const request = args?.request as Record<string, unknown> | undefined
    return fileContract !== 'legacy' && Object.keys(payload).every(key => key === 'args')
      && !!args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every(key => key === 'request')
      && !!request && typeof request === 'object' && !Array.isArray(request) && Object.keys(request).every(key => key === 'sessionId')
      && typeof request.sessionId === 'string' && request.sessionId.length > 0 && request.sessionId.length <= 128
      && !/[\x00-\x1f\x7f]/u.test(request.sessionId)
  }
  if (endpoint === 'subagents/list' && fileContract === 'target') return false
  if (endpoint === projectionCall) {
    const args = payload.args as Record<string, unknown> | undefined
    const request = args?.request as Record<string, unknown> | undefined
    return fileContract !== 'legacy' && Object.keys(payload).every(key => key === 'args')
      && !!args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).every(key => key === 'request')
      && !!request && typeof request === 'object' && !Array.isArray(request) && Object.keys(request).every(key => key === 'sessionId')
      && typeof request.sessionId === 'string' && request.sessionId.length > 0 && request.sessionId.length <= 128 && !request.sessionId.includes('\0')
  }
  if (endpoint === 'settings/update') {
    const args = payload.args as Record<string, unknown> | undefined
    if (Object.keys(payload).some(key => key !== 'args') || !args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['ns', 'patch', 'expectedRevision'].includes(key)) || args.ns !== 'agent-presets') return false
    const patch = args.patch as Record<string, unknown> | undefined
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length
      || Object.keys(patch).some(key => !['default', 'modeSelectionEnabled'].includes(key))) return false
    if (Object.hasOwn(patch, 'default') && (typeof patch.default !== 'string' || patch.default.length > 128 || !/^[a-z0-9][a-z0-9-]*$/.test(patch.default))) return false
    if (Object.hasOwn(patch, 'modeSelectionEnabled') && typeof patch.modeSelectionEnabled !== 'boolean') return false
    return args.expectedRevision === undefined || (Number.isSafeInteger(args.expectedRevision) && (args.expectedRevision as number) >= 0)
  }
  if (endpoint === 'settings/openAgentPresetDirectory') {
    const args = payload.args as Record<string, unknown> | undefined
    return Object.keys(payload).every(key => key === 'args') && !!args && typeof args === 'object' && !Array.isArray(args)
      && Object.keys(args).every(key => key === 'agentPreset') && typeof args.agentPreset === 'string'
      && args.agentPreset.length <= 128 && /^[a-z0-9][a-z0-9-]*$/.test(args.agentPreset)
  }
  if (['agentPresets/read', 'agentPresets/copy', 'agentPresets/deletePreset'].includes(endpoint)) {
    const args = payload.args as Record<string, unknown> | undefined
    if (Object.keys(payload).some(key => key !== 'args') || !args || typeof args !== 'object' || Array.isArray(args)) return false
    const id = (value: unknown) => typeof value === 'string' && value.length <= 128 && /^[a-z0-9][a-z0-9-]*$/.test(value)
    if (endpoint === 'agentPresets/read') return Object.keys(args).every(key => key === 'agentPreset') && id(args.agentPreset)
    if (endpoint === 'agentPresets/deletePreset') return Object.keys(args).every(key => key === 'id') && id(args.id)
    return Object.keys(args).every(key => ['from', 'id', 'name'].includes(key)) && id(args.from) && id(args.id)
      && (args.name === undefined || (typeof args.name === 'string' && args.name.length <= 256 && !/[\x00-\x1f\x7f]/.test(args.name)))
  }
  if (endpoint.startsWith('dynamicCordisRunner/')) return cordisRequestAllowed(endpoint, payload)
  if (endpoint === 'officeToPdf/generation') {
    const args = payload.args
    return Object.keys(payload).every(key => key === 'args')
      && !!args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0
  }
  if (endpoint === 'workspaceFiles/read') {
    const args = payload.args as Record<string, unknown> | undefined
    if (Object.keys(payload).some(key => key !== 'args')
      || !args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['workspaceFileScopeId', 'path', 'range'].includes(key))
      || typeof args.workspaceFileScopeId !== 'string' || !args.workspaceFileScopeId.length
      || args.workspaceFileScopeId.length > 200 || /[\x00-\x1f\x7f]/u.test(args.workspaceFileScopeId)
      || typeof args.path !== 'string' || !args.path.length || args.path.length > 4096 || args.path.includes('\0')) return false
    const range = args.range as Record<string, unknown> | undefined
    if (!range || typeof range !== 'object' || Array.isArray(range)
      || Object.keys(range).some(key => !['offset', 'limit'].includes(key))) return false
    // 原 createReadPage 只传 offset；省略 limit 时仍由 Host 使用其配置的分页上限。
    const limit = range.limit === undefined ? 5000 : range.limit
    return Number.isSafeInteger(range.offset) && (range.offset as number) >= 1
      && Number.isSafeInteger(limit) && (limit as number) >= 1 && (limit as number) <= 5000
      && Number.isSafeInteger((range.offset as number) + (limit as number))
  }
  if (endpoint === 'fileReferences/list' || endpoint === 'sessionReferenceResolver/candidates') {
    // 仅发现原 Host 已有的引用，不接受客户端指定工作区、候选上限或读取正文。
    const args = payload.args as Record<string, unknown> | undefined
    return !!args && typeof args === 'object' && !Array.isArray(args)
      && Object.keys(args).every(key => ['agentId', 'query'].includes(key))
      && typeof args.agentId === 'string' && args.agentId.length > 0 && args.agentId.length <= 200
      && !/[\x00-\x1f\x7f]/u.test(args.agentId)
      && typeof args.query === 'string' && args.query.length <= 4096 && !args.query.includes('\0')
  }
  if (endpoint === 'workspaceFiles/list') {
    const args = payload.args as Record<string, unknown> | undefined
    return !!args && typeof args === 'object' && !Array.isArray(args)
      && Object.keys(args).every(key => ['workspaceFileScopeId', 'path'].includes(key))
      && typeof args.workspaceFileScopeId === 'string' && args.workspaceFileScopeId.length > 0
      && args.workspaceFileScopeId.length <= 200 && !/[\x00-\x1f\x7f]/u.test(args.workspaceFileScopeId)
      && typeof args.path === 'string' && args.path.length > 0 && args.path.length <= 4096 && !args.path.includes('\0')
  }
  if (endpoint === 'workspaceFiles/changes') {
    // 新版观察单一目标；Host仍解析会话和实际文件类型，并限制目录在工作区内。
    // 网关接受两份已审阅契约，固定版本Host再选择其中一份，旧Host不接受新版参数。
    const args = payload.args as Record<string, unknown> | undefined
    if (Object.keys(payload).some(key => key !== 'args') || !args || typeof args !== 'object' || Array.isArray(args)
      || typeof args.workspaceFileScopeId !== 'string' || !args.workspaceFileScopeId.length
      || args.workspaceFileScopeId.length > 200 || /[\x00-\x1f\x7f]/u.test(args.workspaceFileScopeId)) return false
    if (!Object.hasOwn(args, 'path')) return fileContract !== 'target' && Object.keys(args).every(key => key === 'workspaceFileScopeId')
    return fileContract !== 'legacy' && Object.keys(args).every(key => ['workspaceFileScopeId', 'path'].includes(key))
      && typeof args.path === 'string' && args.path.length > 0 && args.path.length <= 4096 && !args.path.includes('\0')
  }
  if (endpoint === 'pluginInventory/list') {
    const args = payload.args
    return !!args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0
  }
  if (endpoint.startsWith('messageFeedback/') || endpoint.startsWith('sessionFeedback/')) {
    const fields: Record<string, string[]> = {
      'messageFeedback/list': ['sessionId'],
      'messageFeedback/put': ['sessionId', 'messageId', 'rating', 'note', 'category', 'ifVersion'],
      'messageFeedback/delete': ['sessionId', 'messageId', 'ifVersion'],
      'sessionFeedback/record': ['sessionId', 'text', 'category'],
    }
    const allowed = fields[endpoint]
    const args = payload.args as Record<string, unknown> | undefined
    const request = args?.request as Record<string, unknown> | undefined
    if (!allowed || !args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => key !== 'request')
      || !request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).some(key => !allowed.includes(key))) return false
    const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/u.test(value)
    if (!id(request.sessionId)) return false
    if (endpoint === 'messageFeedback/list') return true
    const sessionFeedback = endpoint === 'sessionFeedback/record'
    if (!sessionFeedback) {
      if (!id(request.messageId)) return false
      const version = request.ifVersion
      if (!(endpoint === 'messageFeedback/put' && version === null)
        && !(typeof version === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(version))) return false
      if (endpoint === 'messageFeedback/put' && !['positive', 'negative'].includes(request.rating as string)) return false
    }
    if (request.category !== undefined && !['task-result', 'instruction-following', 'product-interaction',
      'service-stability', 'resource-cost', 'security-privacy-permission', 'other'].includes(request.category as string)) return false
    const text = sessionFeedback ? request.text : request.note
    return text === undefined || (typeof text === 'string' && (sessionFeedback || text.trim().length > 0)
      && new TextEncoder().encode(text).byteLength <= 64 * 1024)
  }
  if (['workspace/rename', 'workspace/delete', 'workspace/insertBefore', 'workspace/insertSessionBefore'].includes(endpoint)) {
    const args = payload.args as Record<string, unknown> | undefined
    const request = args?.request as Record<string, unknown> | undefined
    if (!args || Array.isArray(args) || Object.keys(args).some(key => key !== 'request')
      || !request || typeof request !== 'object' || Array.isArray(request)) return false
    const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/u.test(value)
    if (!id(request.workspaceId)) return false
    const allowed = endpoint === 'workspace/rename' ? ['workspaceId', 'title']
      : endpoint === 'workspace/insertBefore' ? ['workspaceId', 'beforeWorkspaceId']
        : endpoint === 'workspace/insertSessionBefore' ? ['workspaceId', 'sessionId', 'beforeSessionId'] : ['workspaceId']
    if (Object.keys(request).some(key => !allowed.includes(key))) return false
    if (endpoint === 'workspace/rename') return typeof request.title === 'string' && request.title.trim().length > 0 && request.title.length <= 200 && !/[\x00-\x1f\x7f]/u.test(request.title)
    if (endpoint === 'workspace/insertBefore') return request.beforeWorkspaceId === undefined || (id(request.beforeWorkspaceId) && request.beforeWorkspaceId !== request.workspaceId)
    if (endpoint === 'workspace/insertSessionBefore') return id(request.sessionId) && (request.beforeSessionId === undefined || (id(request.beforeSessionId) && request.beforeSessionId !== request.sessionId))
    return true
  }
  if (endpoint.startsWith('goals/')) {
    const method = endpoint.slice('goals/'.length)
    if (!['get', 'create', 'edit', 'pause', 'resume', 'complete', 'clear'].includes(method)) return false
    const args = payload.args as Record<string, unknown> | undefined
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || typeof args.agentId !== 'string' || !args.agentId.length || args.agentId.length > 200) return false
    const keys = ['agentId', ...(['create', 'edit'].includes(method) ? ['request'] : []), ...(!['get', 'create'].includes(method) ? ['ref'] : [])]
    if (Object.keys(args).some(key => !keys.includes(key))) return false
    if (!['get', 'create'].includes(method)) {
      const ref = args.ref as Record<string, unknown> | undefined
      if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(key => !['id', 'revision'].includes(key))
        || typeof ref.id !== 'string' || !ref.id.length || ref.id.length > 200
        || !Number.isSafeInteger(ref.revision) || (ref.revision as number) < 1) return false
    }
    if (['create', 'edit'].includes(method)) {
      const request = args.request as Record<string, unknown> | undefined
      if (!request || typeof request !== 'object' || Array.isArray(request) || !Object.keys(request).length
        || Object.keys(request).some(key => !['objective', 'maxGoalRounds'].includes(key))
        || (method === 'create' && request.objective === undefined)) return false
      if (request.objective !== undefined && (typeof request.objective !== 'string' || !request.objective.trim() || request.objective.length > 32000)) return false
      if (request.maxGoalRounds !== undefined && (!Number.isSafeInteger(request.maxGoalRounds) || (request.maxGoalRounds as number) < 1)) return false
    }
    return true
  }
  if (endpoint === 'agentPresets/list' || endpoint === 'agentPresets/select') {
    const args = payload.args as Record<string, unknown> | undefined
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false
    if (endpoint === 'agentPresets/list') return Object.keys(args).length === 0
    return Object.keys(args).every(key => ['agentId', 'agentPreset'].includes(key))
      && typeof args.agentId === 'string' && args.agentId.length > 0 && args.agentId.length <= 200
      && typeof args.agentPreset === 'string' && args.agentPreset.length > 0 && args.agentPreset.length <= 128
      && !/[\x00-\x1f\x7f]/u.test(args.agentPreset)
  }
  if (endpoint === 'commands/execute') {
    const args = payload.args as Record<string, unknown> | undefined
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['agentId', 'line', 'submittedAttachments'].includes(key))
      || typeof args.agentId !== 'string' || !args.agentId.length || args.agentId.length > 200
      || typeof args.line !== 'string'
      || !Array.isArray(args.submittedAttachments) || args.submittedAttachments.length) return false
    // /plan 后的其他文字会触发 agent.steer；这里只切换模式，不发送模型消息。
    if (args.line === '/plan' || args.line === '/plan off') return true
    if (!args.line.startsWith('/permission ')) return false
    const preset = args.line.slice('/permission '.length)
    // 原解析器只执行首个命令，余下原样交给权限服务；不允许多行或额外附件。
    return preset.length > 0 && preset.length <= 128 && preset.trim() === preset && !/[\x00-\x1f\x7f]/u.test(preset)
  }
  if (endpoint === 'workspaceFiles/stat' || endpoint === 'workspaceFiles/readBytes') {
    const args = payload.args as Record<string, unknown> | undefined
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || typeof args.workspaceFileScopeId !== 'string' || !args.workspaceFileScopeId.length || args.workspaceFileScopeId.length > 200
      || typeof args.path !== 'string' || !args.path.length || args.path.length > 4096 || args.path.includes('\0')) return false
    if (endpoint === 'workspaceFiles/stat') return true
    const nativeOptions = Object.hasOwn(args, 'options')
    const options = args.options as Record<string, unknown> | undefined
    if (nativeOptions && (fileContract === 'legacy' || Object.hasOwn(args, 'range') || !options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['range', 'baseFile'].includes(key))
      || (options.baseFile !== undefined && (typeof options.baseFile !== 'string' || !options.baseFile.length
        || options.baseFile.length > 4096 || options.baseFile.includes('\0'))))) return false
    if (fileContract !== 'legacy' && (Object.keys(payload).some(key => key !== 'args')
      || Object.keys(args).some(key => !['workspaceFileScopeId', 'path', nativeOptions ? 'options' : 'range'].includes(key)))) return false
    const range = (nativeOptions ? options?.range : args.range) as Record<string, unknown> | undefined
    return !!range && typeof range === 'object' && !Array.isArray(range)
      && (fileContract === 'legacy' || Object.keys(range).every(key => ['offset', 'length'].includes(key)))
      && Number.isSafeInteger(range.offset) && (range.offset as number) >= 0
      && Number.isSafeInteger(range.length) && (range.length as number) >= 1 && (range.length as number) <= 64 * 1024
      && Number.isSafeInteger((range.offset as number) + (range.length as number))
  }
  if (endpoint !== 'session/create') return true
  const args = payload.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  const request = (args as Record<string, unknown>).request
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false
  const value = request as Record<string, unknown>
  return typeof value.workspaceId === 'string' && value.workspaceId.length > 0 && !Object.hasOwn(value, 'cwd')
}
