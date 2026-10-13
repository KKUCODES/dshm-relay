/** DSH 0.1.6-alpha.2 原生成 Remote 签名；不开放 define、代码上传或任意服务方法。 */
const fields = {
  getClientCode: ['agentId', 'pluginId', 'pluginRunId'],
  inventory: [],
  invoke: ['pluginId', 'pluginRunId', 'method', 'args'],
  reportClientGuardFailure: ['agentId', 'pluginId', 'pluginRunId', 'failure'],
  reportRenderFailure: ['agentId', 'pluginId', 'pluginRunId', 'failure'],
  resolveInspectQuery: ['agentId', 'requestId', 'resolution'],
  resolveRequestRun: ['requestId', 'resolution'],
  runHostHalf: ['agentId', 'pluginId', 'packageId', 'mode', 'requestId', 'approveFutureVersions'],
  settleUserRun: ['agentId', 'pluginId', 'resolution'],
  stopFromPanel: ['agentId', 'pluginId'],
  syncInspectManifest: ['providers'],
  undefineFromPanel: ['agentId', 'pluginId'],
} as const

export const dynamicCordisCalls: readonly string[] = Object.keys(fields).map(method => `dynamicCordisRunner/${method}`)

export function cordisRequestAllowed(endpoint: string, payload: Record<string, unknown>): boolean {
  const method = endpoint.slice('dynamicCordisRunner/'.length)
  if (!Object.hasOwn(fields, method) || Object.keys(payload).some(key => key !== 'args')) return false
  const args = payload.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  const names: readonly string[] = fields[method as keyof typeof fields]
  const record = args as Record<string, unknown>
  if (Object.keys(record).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(record, key))) return false
  for (const key of ['agentId', 'pluginId', 'pluginRunId', 'packageId', 'requestId']) {
    if (!Object.hasOwn(record, key)) continue
    const value = record[key]
    if (method === 'runHostHalf' && key === 'requestId' && value === null) continue
    if (typeof value !== 'string' || value.length === 0 || value.length > 200 || /[\x00-\x1f\x7f]/u.test(value)) return false
  }
  // 复杂定义/结果不另造解码器，交给电脑原生成 codec 和 runner 状态机。
  return true
}
