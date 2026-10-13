import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, expect, test } from 'vitest'
import WebSocket from 'ws'
import { PGlite } from '@electric-sql/pglite'
import { buildGateway } from '../packages/gateway/src/app.js'
import { Store, secret } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'
import { clientKey, proof } from './support/proof.js'
import { clientFrameSchema } from '../packages/protocol/src/index.js'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const next = (socket: WebSocket) => once(socket, 'message').then(([data]) => JSON.parse(data.toString()))

test('separate desktop grants, authentic identity routing, ticket invalidation and stream cancellation use real HTTP/WS/SQL', async () => {
  const db = new PGlite(), store = new Store(pgliteDatabase(db)); cleanup.push(() => db.close())
  await store.migrate(); await store.migrate()
  const publicOrigin = 'http://127.0.0.1:8787'
  const app = await buildGateway({ store, publicOrigin, registrationMode: 'open' })
  const origin = await app.listen({ host: '127.0.0.1', port: 0 }); cleanup.push(() => app.close())
  const host = await store.enrollHost('own'), other = await store.enrollHost('other')
  const key = secret(), who = await clientKey()
  await store.createPairing(host.id, key, 300)
  const binding = (await app.inject({ method: 'POST', url: '/v1/pairings/claim', payload: { key, name: 'device' },
    headers: { dpop: await proof(who, publicOrigin + '/v1/pairings/claim', 'POST') } })).json()
  const permission = (enabled: boolean, token = host.token) => app.inject({ method: 'POST',
    url: `/v1/host/devices/${binding.deviceId}/management`, headers: { authorization: 'Bearer ' + token }, payload: { enabled } })
  expect((await permission(true)).statusCode).toBe(404)
  await store.changeDevice(host.id, binding.deviceId, 'active')
  expect((await store.activeDevice(binding.deviceId))?.management).toBe(false)
  expect((await permission(true, other.token)).statusCode).toBe(404)
  expect((await permission(true, binding.token)).statusCode).toBe(401)
  const ticket = async () => (await app.inject({ method: 'POST', url: '/v1/device/ticket', headers: {
    authorization: 'DPoP ' + binding.token, dpop: await proof(who, publicOrigin + '/v1/device/ticket', 'POST', binding.token),
  } })).json().ticket
  const connect = async (path: string, token?: string) => {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + path, { headers: token ? { authorization: 'Bearer ' + token } : {} })
    cleanup.push(() => socket.terminate()); await once(socket, 'open'); return socket
  }
  const device = async () => {
    const credential = await ticket(), socket = await connect('/v1/device/socket'), ready = next(socket)
    socket.send(JSON.stringify({ type: 'authenticate', ticket: credential })); await ready; return socket
  }
  const desktop = await connect('/v1/host/socket?transport=2', host.token), phone = await device()
  const serviceId = randomUUID(), serviceRoute = next(desktop)
  phone.send(JSON.stringify({ type: 'request', id: serviceId, operation: { method: 'remote.subagentStateFollow' } }))
  const service = await serviceRoute
  expect(service.context).toMatchObject({ hostId: host.id, deviceId: binding.deviceId, management: false })
  const serviceState = next(phone)
  desktop.send(JSON.stringify({ type: 'event', id: service.id, value: { available: false } }))
  expect(await serviceState).toEqual({ type: 'event', id: serviceId, value: { available: false } })
  const serviceCancel = next(desktop), serviceEnd = next(phone)
  phone.send(JSON.stringify({ type: 'cancel', id: serviceId }))
  expect(await serviceCancel).toEqual({ type: 'cancel', id: service.id })
  expect(await serviceEnd).toEqual({ type: 'end', id: serviceId })
  for (const extra of [{ service: 'credentials' }, { management: true }, { available: true }])
    expect(clientFrameSchema.safeParse({ type: 'request', id: randomUUID(), operation: { method: 'remote.subagentStateFollow', ...extra } }).success).toBe(false)
  const taskId = randomUUID(), taskRouted = next(desktop)
  phone.send(JSON.stringify({ type: 'request', id: taskId, operation: { method: 'remote.taskFollow' } }))
  const task = await taskRouted
  expect(task.context).toMatchObject({ hostId: host.id, deviceId: binding.deviceId, management: false })
  const taskReady = next(phone)
  desktop.send(JSON.stringify({ type: 'event', id: task.id, value: { type: 'ready', generation: randomUUID() } }))
  expect(await taskReady).toMatchObject({ type: 'event', id: taskId, value: { type: 'ready' } })
  const taskCancelled = next(desktop), taskEnded = next(phone)
  phone.send(JSON.stringify({ type: 'cancel', id: taskId }))
  expect(await taskCancelled).toEqual({ type: 'cancel', id: task.id })
  expect(await taskEnded).toEqual({ type: 'end', id: taskId })
  // 同一连接重订阅必须生成新的Host路由；旧流迟到事件不能落入新订阅。
  const retryRoute = next(desktop)
  phone.send(JSON.stringify({ type: 'request', id: taskId, operation: { method: 'remote.taskFollow' } }))
  const retryTask = await retryRoute
  expect(retryTask.id).not.toBe(task.id)
  const retryReady = next(phone), noticeGeneration = randomUUID()
  desktop.send(JSON.stringify({ type: 'event', id: task.id, value: { type: 'stale' } }))
  desktop.send(JSON.stringify({ type: 'event', id: retryTask.id, value: { type: 'ready', generation: noticeGeneration } }))
  expect(await retryReady).toEqual({ type: 'event', id: taskId, value: { type: 'ready', generation: noticeGeneration } })
  const overflow = next(phone)
  desktop.send(JSON.stringify({ type: 'error', id: retryTask.id, code: 'notification_overflow' }))
  expect(await overflow).toEqual({ type: 'error', id: taskId, code: 'notification_overflow' })
  const afterErrorRoute = next(desktop)
  phone.send(JSON.stringify({ type: 'request', id: taskId, operation: { method: 'remote.taskFollow' } }))
  const afterError = await afterErrorRoute
  expect(afterError.id).not.toBe(retryTask.id)
  const afterErrorReady = next(phone)
  desktop.send(JSON.stringify({ type: 'event', id: retryTask.id, value: { type: 'stale' } }))
  desktop.send(JSON.stringify({ type: 'event', id: afterError.id, value: { type: 'ready', generation: noticeGeneration } }))
  expect(await afterErrorReady).toEqual({ type: 'event', id: taskId, value: { type: 'ready', generation: noticeGeneration } })
  const afterErrorEnd = next(phone)
  desktop.send(JSON.stringify({ type: 'end', id: afterError.id }))
  expect(await afterErrorEnd).toEqual({ type: 'end', id: taskId })
  expect(clientFrameSchema.safeParse({ type: 'request', id: randomUUID(), operation: { method: 'remote.taskFollow', previewVersion: 1 } }).success).toBe(true)
  for (const extra of [{ since: 0 }, { sessionId: 'anything' }, { management: true }, { previewVersion: 2 }, { previewVersion: '1' }])
    expect(clientFrameSchema.safeParse({ type: 'request', id: randomUUID(), operation: { method: 'remote.taskFollow', ...extra } }).success).toBe(false)
  const feedbackStreamId = randomUUID(), feedbackStreamRoute = next(desktop)
  phone.send(JSON.stringify({ type: 'request', id: feedbackStreamId, operation: { method: 'remote.feedbackFollow', sessionId: 'cold' } }))
  const feedbackStream = await feedbackStreamRoute
  expect(feedbackStream.context).toMatchObject({ hostId: host.id, deviceId: binding.deviceId, management: false })
  const feedbackReady = next(phone)
  desktop.send(JSON.stringify({ type: 'event', id: feedbackStream.id, value: { type: 'ready', revision: 0 } }))
  expect(await feedbackReady).toMatchObject({ type: 'event', id: feedbackStreamId, value: { type: 'ready' } })
  const feedbackCancelled = next(desktop), feedbackEnded = next(phone)
  phone.send(JSON.stringify({ type: 'cancel', id: feedbackStreamId }))
  expect(await feedbackCancelled).toEqual({ type: 'cancel', id: feedbackStream.id })
  expect(await feedbackEnded).toEqual({ type: 'end', id: feedbackStreamId })
  for (const extra of [{ sessionId: '' }, { sessionId: 'bad\n' }, { scope: 'all' }])
    expect(clientFrameSchema.safeParse({ type: 'request', id: randomUUID(), operation: { method: 'remote.feedbackFollow', sessionId: 'cold', ...extra } }).success).toBe(false)
  const call = (socket: WebSocket, operation: object) => {
    const result = next(socket), id = randomUUID(); socket.send(JSON.stringify({ type: 'request', id, operation })); return result
  }
  // 真实HTTP/票据/SQL/WS路由：聊天授权即可回答原问题，身份来自连接，不能由参数冒用。
  const questionArgs = { agentId: 'session-own', callId: 'call-own' }
  const lateAnswer = { method: 'remote.rpc', endpoint: 'userQuestions/answer', payload: {
    args: { ...questionArgs, answer: { answers: [{ id: 'choice', selected: ['绿色'] }] } },
  } }
  const lateRouted = next(desktop), lateReceived = call(phone, lateAnswer)
  const lateRoute = await lateRouted
  expect(lateRoute.operation).toEqual(lateAnswer)
  expect(lateRoute.context).toMatchObject({ hostId: host.id, deviceId: binding.deviceId, management: false })
  desktop.send(JSON.stringify({ type: 'result', id: lateRoute.id, value: { ok: true, value: true } }))
  expect(await lateReceived).toMatchObject({ type: 'result', value: { ok: true, value: true } })
  const waitId = randomUUID(), waitRouteReceived = next(desktop), waitOpening = next(phone)
  phone.send(JSON.stringify({ type: 'request', id: waitId, operation: { method: 'remote.stream',
    endpoint: 'userQuestions/attachWait', payload: { args: questionArgs } } }))
  const waitRoute = await waitRouteReceived
  expect(waitRoute.context.management).toBe(false)
  desktop.send(JSON.stringify({ type: 'event', id: waitRoute.id, value: { remainingMs: 12000 } }))
  expect(await waitOpening).toEqual({ type: 'event', id: waitId, value: { remainingMs: 12000 } })
  const waitCancelled = next(desktop), waitEnded = next(phone)
  phone.send(JSON.stringify({ type: 'cancel', id: waitId }))
  expect(await waitCancelled).toEqual({ type: 'cancel', id: waitRoute.id })
  expect(await waitEnded).toEqual({ type: 'end', id: waitId })
  expect(await call(phone, { method: 'remote.rpc', endpoint: 'userQuestions/answer',
    payload: { args: { ...questionArgs, answer: 'allowed-once' } } }))
    .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
  expect(await call(phone, { method: 'remote.stream', endpoint: 'userQuestions/attachWait',
    payload: { args: { ...questionArgs, clientId: 'another-device' } } }))
    .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
  const pageArgs = { workspaceFileScopeId: 'own', path: '正文.txt', range: { offset: 1 } }
  const generationRouted = next(desktop), generationResult = call(phone, { method: 'remote.rpc', endpoint: 'officeToPdf/generation', payload: { args: {} } })
  const generation = await generationRouted
  expect(generation.context.management).toBe(false)
  desktop.send(JSON.stringify({ type: 'result', id: generation.id, value: { ok: true, value: 'office-generation' } }))
  expect(await generationResult).toMatchObject({ type: 'result', value: { ok: true, value: 'office-generation' } })
  expect(await call(phone, { method: 'remote.rpc', endpoint: 'officeToPdf/generation', payload: { args: { path: '/' } } }))
    .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
  const pageRouted = next(desktop), pageResult = call(phone, { method: 'remote.rpc', endpoint: 'workspaceFiles/read', payload: { args: pageArgs } })
  const page = await pageRouted
  expect(page.context).toMatchObject({ hostId: host.id, deviceId: binding.deviceId, management: false })
  expect(page.operation.payload.args).toEqual(pageArgs)
  desktop.send(JSON.stringify({ type: 'result', id: page.id, value: { ok: true, value: { offset: 1, text: '正文', lines: 1, eof: true } } }))
  expect(await pageResult).toMatchObject({ type: 'result', value: { ok: true, value: { text: '正文' } } })
  for (const args of [{ ...pageArgs, workspaceRoot: '/' }, { ...pageArgs, range: { offset: 0 } },
    { ...pageArgs, range: { offset: 1, limit: 5001 } }]) {
    expect(await call(phone, { method: 'remote.rpc', endpoint: 'workspaceFiles/read', payload: { args } }))
      .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
  }
  for (const operation of [{ method: 'remote.desktop' }, { method: 'remote.openFile', source: 'presented', sessionId: 'own', seq: 2, index: 1, confirmed: true },
    { method: 'remote.openFile', source: 'presented', sessionId: 'own', seq: 2, index: 1, confirmed: true, action: 'reveal' },
    { method: 'remote.prepareDesktopFile', sessionId: 'own', path: 'file.txt' },
    { method: 'remote.desktopApps', sessionId: 'own' },
    { method: 'remote.desktopAppIcon', sessionId: 'own', appId: 'vscode' },
    { method: 'remote.prepareDesktopApp', sessionId: 'own', appId: 'vscode' },
    { method: 'remote.openDesktopApp', sessionId: 'own', snapshot: randomUUID(), confirmed: true },
    { method: 'remote.prepareDesktopAttachment', sessionId: 'own', kind: 'file', attachmentId: 'saved', name: 'file.txt' },
    { method: 'remote.openDesktopAttachment', sessionId: 'own', snapshot: randomUUID(), confirmed: true },
    { method: 'remote.openDesktopFile', sessionId: 'own', snapshot: randomUUID(), confirmed: true }]) {
    const routed = next(desktop), result = call(phone, operation), frame = await routed
    expect(frame.operation).toEqual(operation); expect(frame.context.management).toBe(false)
    desktop.send(JSON.stringify({ type: 'result', id: frame.id, value: { opened: true } }))
    expect((await result).type).toBe('result')
  }
  const exportRoute = next(desktop), exportId = randomUUID()
  phone.send(JSON.stringify({ type: 'request', id: exportId, operation: { method: 'remote.sessionExport', sessionId: 'own', includeDescendants: false } }))
  const exporting = await exportRoute
  expect(exporting.context.management).toBe(false)
  const exportAck = next(desktop)
  phone.send(JSON.stringify({ type: 'ack', id: exportId, count: 1 }))
  expect(await exportAck).toEqual({ type: 'ack', id: exporting.id, count: 1 })
  const exportEnd = next(phone)
  desktop.send(JSON.stringify({ type: 'end', id: exporting.id }))
  expect(await exportEnd).toEqual({ type: 'end', id: exportId })
  expect(clientFrameSchema.safeParse({ type: 'request', id: randomUUID(), operation: { method: 'remote.sessionExport', sessionId: 'own', includeDescendants: false, url: '/etc/passwd' } }).success).toBe(false)
  for (const [endpoint, args] of [
    ['subagents/list', { parentSessionId: 'parent' }],
    ['subagents/prompt', { request: { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable', requestId: randomUUID(), delivery: 'queue', content: [{ type: 'text', text: 'continue' }] } }],
    ['subagents/interruptByParent', { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' }],
  ] as const) {
    const routed = next(desktop), response = call(phone, { method: 'remote.rpc', endpoint, payload: { args } })
    const request = await routed
    expect(request.context.deviceId).toBe(binding.deviceId)
    expect(request.operation.payload.args).toEqual(args)
    desktop.send(JSON.stringify({ type: 'result', id: request.id, value: { ok: false, error: { code: 'subagent/unauthorized', message: 'ownership conflict', details: {} } } }))
    expect(await response).toMatchObject({ type: 'result', value: { ok: false, error: { code: 'subagent/unauthorized' } } })
  }
  expect(await call(phone, { method: 'remote.rpc', endpoint: 'pluginManager/installBundle', payload: { args: {} } }))
    .toMatchObject({ type: 'error', code: 'management_required' })
  expect(await call(phone, { method: 'remote.rpc', endpoint: 'pluginInventory/list', payload: { args: {} } }))
    .toMatchObject({ type: 'error', code: 'management_required' })
  expect(await call(phone, { method: 'remote.rpc', endpoint: 'pluginManager/waitForInstall', payload: { args: { requestId: randomUUID() } } }))
    .toMatchObject({ type: 'error', code: 'management_required' })
  const workspaceOperations = [
    ['workspace/rename', { workspaceId: 'w', title: '新名称' }],
    ['workspace/delete', { workspaceId: 'w' }],
    ['workspace/insertBefore', { workspaceId: 'w', beforeWorkspaceId: 'b' }],
  ] as const
    const settingsOperations = [
    { method: 'remote.rpc', endpoint: 'settings/update', payload: { args: { ns: 'agent-presets', patch: { default: 'standard' } } } },
    { method: 'remote.rpc', endpoint: 'settings/openAgentPresetDirectory', payload: { args: { agentPreset: 'test-copy' } } },
    { method: 'remote.rpc', endpoint: 'agentPresets/read', payload: { args: { agentPreset: 'standard' } } },
    { method: 'remote.rpc', endpoint: 'agentPresets/copy', payload: { args: { from: 'standard', id: 'test-copy' } } },
    { method: 'remote.rpc', endpoint: 'agentPresets/deletePreset', payload: { args: { id: 'test-copy' } } },
    { method: 'remote.pluginOperations' },
      { method: 'remote.providerKeySetup', provider: 'openai', confirmed: true, snapshot: randomUUID(), expectedRevision: 0 },
    { method: 'remote.providerCreationRead' },
    { method: 'remote.providerCreationWrite', kind: 'custom', provider: 'test-model-rows', name: '', useKey: false,
      confirmed: true, snapshot: randomUUID(), expectedRevision: 0, api: 'openai-completions', baseURL: 'https://example.invalid/v1',
      models: [{ id: 'a', name: 'A', contextWindow: 128000, maxTokens: 8000, input: ['text', 'image'] }] },
    { method: 'remote.providerCreationWrite', kind: 'catalog', provider: 'openai', name: '', useKey: false,
      confirmed: true, snapshot: randomUUID(), expectedRevision: 0 },
    { method: 'remote.providerRemovalRead', provider: 'configured-route' },
    { method: 'remote.providerRemovalWrite', provider: 'configured-route', snapshot: randomUUID(), expectedRevision: 0 },
    { method: 'remote.providerModelsDiscover', provider: 'configured-route' },
    { method: 'remote.modelProbePrepare', baseURL: 'http://127.0.0.1:12345/v1', api: 'openai-completions', authentication: { mode: 'none' } },
    { method: 'remote.modelProbeExecute', snapshot: randomUUID(), confirmed: true, mode: 'temporary', apiKey: 'synthetic-permission-test' },
    { method: 'remote.providerSettingsList' },
    { method: 'remote.providerCardRead', provider: 'deepseek-official' },
    { method: 'remote.modelReadiness' },
    { method: 'remote.deepSeekModelsRead' },
    { method: 'remote.deepSeekModelsWrite', snapshot: randomUUID(), expectedRevision: 0, change: { op: 'set', rows: [{ id: 'test-model' }] } },
    { method: 'remote.providerModelsRead', provider: 'configured-route', scope: 'overrides' },
    { method: 'remote.providerModelsWrite', provider: 'configured-route', scope: 'overrides', snapshot: randomUUID(), expectedRevision: 0, change: { op: 'unset' } },
    { method: 'remote.providerSettingsWrite', provider: 'configured-route', snapshot: randomUUID(), expectedRevision: 0, edits: [], compat: { supportsStore: false } },
    { method: 'remote.providerSettingsWrite', provider: 'configured-route', snapshot: randomUUID(), expectedRevision: 0,
      edits: [], protocolChange: { value: 'anthropic-messages', confirmed: true } },
    { method: 'remote.providerModelsRead', provider: 'configured-route' },
    { method: 'remote.providerModelsWrite', provider: 'configured-route', snapshot: randomUUID(), expectedRevision: 0, change: { op: 'set', rows: [{ id: 'test-model' }] } },
    { method: 'remote.providerSettingsRead', provider: 'configured-route' },
    { method: 'remote.providerSettingsWrite', provider: 'configured-route', snapshot: randomUUID(), expectedRevision: 0,
      edits: [{ op: 'set', key: 'timeoutMs', value: 12000 }] },
    { method: 'remote.pluginOperationRead', generation: randomUUID(), operationId: randomUUID() },
    { method: 'remote.pluginOperationStart', generation: randomUUID(), operationId: randomUUID(), endpoint: 'pluginManager/installBundle', payload: { args: { spec: 'fixture' } } },
    { method: 'remote.settingsRead', namespace: 'shell' },
    { method: 'remote.presetManagementRead', preset: 'standard' },
    { method: 'remote.presetCopy', snapshot: randomUUID(), id: 'copied', name: 'Copied' },
    { method: 'remote.presetDelete', snapshot: randomUUID(), confirmed: true },
    { method: 'remote.settingsRead', namespace: 'agent-preset-registry' },
    { method: 'remote.settingsWrite', namespace: 'agent-preset-registry', snapshot: randomUUID(), expectedRevision: 0,
      edits: [{ op: 'set', key: 'selectedDefault', value: 'standard' }] },
    { method: 'remote.settingsWrite', namespace: 'agent-loop', snapshot: randomUUID(), expectedRevision: 0, edits: [{ op: 'set', key: 'maxParallelToolCalls', value: 2 }] },
    { method: 'remote.settingsRead' }, { method: 'remote.settingsWrite', snapshot: randomUUID(), expectedRevision: 0,
    edits: [{ op: 'set', key: 'maxTokens', value: 1024 }] }, { method: 'remote.keyRead' },
    { method: 'remote.keyWrite', snapshot: randomUUID(), change: { op: 'set', value: 'TEST_KEY_ONLY' } },
    { method: 'remote.settingsRead', namespace: 'web-search-deepseek' },
    { method: 'remote.settingsWrite', namespace: 'web-search-deepseek', snapshot: randomUUID(), expectedRevision: 0, edits: [{ op: 'set', key: 'maxUses', value: 6 }] },
    { method: 'remote.keyRead', target: 'web-search-deepseek' },
    { method: 'remote.keyRead', target: { provider: 'alpha' } },
    { method: 'remote.keyWrite', target: { provider: 'alpha' }, snapshot: randomUUID(), change: { op: 'set', value: 'TEST_PROVIDER_ONLY' } },
    { method: 'remote.keyWrite', target: 'web-search-deepseek', snapshot: randomUUID(), change: { op: 'set', value: 'TEST_SEARCH_ONLY' } },
    { method: 'remote.endpointRead', target: 'web-search-deepseek' },
    { method: 'remote.endpointRead', target: { provider: 'openai' } },
    { method: 'remote.endpointWrite', target: { provider: 'openai' }, snapshot: randomUUID(), expectedRevision: 0, confirmed: true, change: { op: 'set', value: 'https://example.invalid' } },
    { method: 'remote.endpointWrite', target: 'web-search-deepseek', snapshot: randomUUID(), expectedRevision: 0, confirmed: true, change: { op: 'set', value: 'https://example.invalid' } },
    { method: 'remote.endpointRead' }, { method: 'remote.endpointWrite', snapshot: randomUUID(), expectedRevision: 0, confirmed: true, change: { op: 'set', value: 'https://example.invalid' } }]
  for (const operation of settingsOperations)
    expect(await call(phone, operation)).toMatchObject({ type: 'error', code: 'management_required' })
  for (const [endpoint, request] of workspaceOperations)
    expect(await call(phone, { method: 'remote.rpc', endpoint, payload: { args: { request } } })).toMatchObject({ type: 'error', code: 'management_required' })
  expect(await call(phone, { method: 'remote.rpc', endpoint: 'terminal/write', payload: { args: {} } }))
    .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
  expect(await call(phone, { method: 'remote.rpc', endpoint: 'commands/execute', payload: { args: {
    agentId: 'session', line: '/clear', submittedAttachments: [],
  } } })).toMatchObject({ type: 'error', code: 'remote_operation_denied' })
  const permissionRoute = next(desktop), permissionResponse = call(phone, { method: 'remote.rpc', endpoint: 'commands/execute', payload: { args: {
    agentId: 'session', line: '/permission read-only', submittedAttachments: [],
  } } })
  const permissionFrame = await permissionRoute
  expect(permissionFrame.context.management).toBe(false)
  expect(permissionFrame.operation.payload.args.line).toBe('/permission read-only')
  desktop.send(JSON.stringify({ type: 'result', id: permissionFrame.id, value: { ok: true } })); await permissionResponse
  for (const line of ['/plan', '/plan off']) {
    const route = next(desktop), response = call(phone, { method: 'remote.rpc', endpoint: 'commands/execute', payload: { args: { agentId: 'session', line, submittedAttachments: [] } } })
    const frame = await route
    expect(frame.operation.payload.args.line).toBe(line)
    expect(frame.context.management).toBe(false)
    desktop.send(JSON.stringify({ type: 'result', id: frame.id, value: { ok: true } })); await response
  }
  for (const line of ['/plan on', '/plan message', '/plan off\n/clear', '/plan ']) {
    expect(await call(phone, { method: 'remote.rpc', endpoint: 'commands/execute', payload: { args: { agentId: 'session', line, submittedAttachments: [] } } }))
      .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
  }
  const presetRoute = next(desktop), presetResponse = call(phone, { method: 'remote.rpc', endpoint: 'agentPresets/select', payload: { args: {
    agentId: 'blank-session', agentPreset: 'minimal',
  } } })
  const presetFrame = await presetRoute
  expect(presetFrame.operation.payload.args).toEqual({ agentId: 'blank-session', agentPreset: 'minimal' })
  expect(presetFrame.context.management).toBe(false)
  desktop.send(JSON.stringify({ type: 'result', id: presetFrame.id, value: { ok: true, value: 'minimal' } })); await presetResponse
  expect(await call(phone, { method: 'remote.rpc', endpoint: 'agentPresets/select', payload: { args: { agentId: 'blank', agentPreset: 'minimal', cwd: '/any' } } }))
    .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
  const feedbackRequest = { sessionId: 'test', messageId: 'assistant-message', rating: 'positive', ifVersion: null }
  const feedbackRoute = next(desktop), feedbackResponse = call(phone, { method: 'remote.rpc', endpoint: 'messageFeedback/put', payload: { args: { request: feedbackRequest } } })
  const feedbackFrame = await feedbackRoute
  expect(feedbackFrame.context.management).toBe(false)
  expect(feedbackFrame.operation.payload.args.request).toEqual(feedbackRequest)
  desktop.send(JSON.stringify({ type: 'result', id: feedbackFrame.id, value: { ok: true, value: { ok: false, error: { code: 'version-conflict', current: null } } } }))
  expect(await feedbackResponse).toMatchObject({ type: 'result', value: { value: { ok: false, error: { code: 'version-conflict' } } } })
  expect(await call(phone, { method: 'remote.rpc', endpoint: 'messageFeedback/put', payload: { args: { request: { ...feedbackRequest, ifVersion: undefined } } } }))
    .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
  const goalRoute = next(desktop), goalArgs = { agentId: 'session', ref: { id: 'goal', revision: 2 } }
  const goalResponse = call(phone, { method: 'remote.rpc', endpoint: 'goals/pause', payload: { args: goalArgs } })
  const goalFrame = await goalRoute
  expect(goalFrame.operation.payload.args).toEqual(goalArgs)
  expect(goalFrame.context.management).toBe(false)
  desktop.send(JSON.stringify({ type: 'result', id: goalFrame.id, value: { ok: false, error: { code: 'GOAL_STALE_REF', message: 'stale' } } }))
  expect(await goalResponse).toMatchObject({ type: 'result', value: { ok: false, error: { code: 'GOAL_STALE_REF' } } })
  expect(await call(phone, { method: 'remote.rpc', endpoint: 'goals/resume', payload: { args: { ...goalArgs, ref: { id: 'goal', revision: 0 } } } }))
    .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
  const jobRoute = next(desktop), jobResponse = call(phone, { method: 'remote.jobStop', sessionId: 'own', jobId: 'pwsh-1', startedAt: 1, generation: randomUUID() })
  const jobFrame = await jobRoute
  expect(jobFrame.context.management).toBe(false)
  expect(jobFrame.operation.method).toBe('remote.jobStop')
  desktop.send(JSON.stringify({ type: 'result', id: jobFrame.id, value: { status: 'requested' } }))
  expect(await jobResponse).toMatchObject({ type: 'result', value: { status: 'requested' } })
  const outputOperation = { method: 'remote.jobOutput', sessionId: 'own', jobId: 'pwsh-1', startedAt: 1,
    generation: randomUUID(), stream: 'stdout', fromByte: 0, maxBytes: 65536 }
  const outputRoute = next(desktop), outputResponse = call(phone, outputOperation)
  const outputFrame = await outputRoute
  expect(outputFrame.context.management).toBe(false)
  expect(outputFrame.operation).toEqual(outputOperation)
  desktop.send(JSON.stringify({ type: 'result', id: outputFrame.id, value: { state: 'available', status: 'running',
    data: 'eA==', startOffset: 0, nextOffset: 1, totalBytes: 1, lossy: false } }))
  expect(await outputResponse).toMatchObject({ type: 'result', value: { data: 'eA==', nextOffset: 1 } })
  const routed = next(desktop), response = call(phone, { method: 'remote.graph' })
  const frame = await routed
  expect(frame.context).toMatchObject({ deviceId: binding.deviceId, hostId: host.id, management: false })
  expect(frame.context.connectionId).toMatch(/^[a-f0-9-]{36}$/)
  desktop.send(JSON.stringify({ type: 'result', id: frame.id, value: { rev: 'test' } })); await response

  const oldTicket = await ticket(), closed = once(phone, 'close')
  expect((await permission(true)).statusCode).toBe(200); await closed
  const stale = await connect('/v1/device/socket'), staleClosed = once(stale, 'close')
  stale.send(JSON.stringify({ type: 'authenticate', ticket: oldTicket })); expect((await staleClosed)[0]).toBe(1008)
  const granted = await device()
  const inventoryOperation = { method: 'remote.rpc', endpoint: 'pluginInventory/list', payload: { args: {} } }
  const inventoryRoute = next(desktop), inventoryResponse = call(granted, inventoryOperation)
  const inventoryFrame = await inventoryRoute
  expect(inventoryFrame.context.management).toBe(true)
  expect(inventoryFrame.operation).toEqual(inventoryOperation)
  desktop.send(JSON.stringify({ type: 'result', id: inventoryFrame.id, value: { ok: true, value: { entries: [], managementAvailable: true } } }))
  expect(await inventoryResponse).toMatchObject({ type: 'result', value: { ok: true } })
  for (const operation of settingsOperations) {
    const routed = next(desktop), response = call(granted, operation)
    const frame = await routed
    expect(frame.operation).toEqual(operation); expect(frame.context.management).toBe(true)
    desktop.send(JSON.stringify({ type: 'error', id: frame.id, code: 'remote_settings_stale' }))
    expect(await response).toMatchObject({ type: 'error', code: 'remote_settings_stale' })
  }
  for (const [endpoint, request] of workspaceOperations) {
    const routed = next(desktop), response = call(granted, { method: 'remote.rpc', endpoint, payload: { args: { request } } })
    const frame = await routed
    expect(frame.context.management).toBe(true)
    expect(frame.operation.payload.args.request).toEqual(request)
    desktop.send(JSON.stringify({ type: 'result', id: frame.id, value: { ok: true, value: {} } })); await response
    expect(await call(granted, { method: 'remote.rpc', endpoint, payload: { args: { request: { ...request, deleteFiles: true } } } })).toMatchObject({ type: 'error', code: 'remote_operation_denied' })
  }
  const streamRouted = next(desktop), id = randomUUID()
  granted.send(JSON.stringify({ type: 'request', id, operation: { method: 'remote.stream', endpoint: '$events', payload: { args: {} } } }))
  const stream = await streamRouted
  expect(stream.context.management).toBe(true)
  const fileWatchRouted = next(desktop), fileWatchId = randomUUID()
  granted.send(JSON.stringify({ type: 'request', id: fileWatchId, operation: { method: 'remote.stream', endpoint: 'workspaceFiles/changes', payload: { args: { workspaceFileScopeId: 'fixture-session' } } } }))
  const fileWatch = await fileWatchRouted
  expect(fileWatch.operation).toEqual({ method: 'remote.stream', endpoint: 'workspaceFiles/changes', payload: { args: { workspaceFileScopeId: 'fixture-session' } } })
  const targetWatchRouted = next(desktop), targetWatchId = randomUUID()
  const targetWatchOperation = { method: 'remote.stream', endpoint: 'workspaceFiles/changes', payload: { args: { workspaceFileScopeId: 'fixture-session', path: 'a.txt' } } }
  granted.send(JSON.stringify({ type: 'request', id: targetWatchId, operation: targetWatchOperation }))
  const targetWatch = await targetWatchRouted
  expect(targetWatch.operation).toEqual(targetWatchOperation)
  const boundedRead = { method: 'remote.rpc', endpoint: 'workspaceFiles/readBytes', payload: { args: {
    workspaceFileScopeId: 'fixture-session', path: 'a.txt', options: { range: { offset: 0, length: 1 } },
  } } }
  const boundedReadRouted = next(desktop), boundedReadResponse = call(granted, boundedRead)
  const boundedReadFrame = await boundedReadRouted
  expect(boundedReadFrame.operation).toEqual(boundedRead)
  desktop.send(JSON.stringify({ type: 'result', id: boundedReadFrame.id, value: { ok: true, value: {} } })); await boundedReadResponse
  expect(await call(granted, { ...boundedRead, payload: { args: { ...boundedRead.payload.args, options: {} } } }))
    .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
  expect(await call(granted, { method: 'remote.stream', endpoint: 'workspaceFiles/changes', payload: { args: { workspaceFileScopeId: 's', workspaceRoot: '/' } } }))
    .toMatchObject({ type: 'error', code: 'remote_operation_denied' })

  const uploadRouted = next(desktop), uploadId = randomUUID()
  granted.send(JSON.stringify({ type: 'request', id: uploadId, operation: { method: 'remote.upload', sessionId: 'fixture-session', name: 'test.txt' } }))
  const upload = await uploadRouted
  expect(upload.context.connectionId).toBe(stream.context.connectionId)
  // 即使属于同一批准设备，另一条 socket 也不能向既有上传注入字节。
  const rival = await device(), barrier = next(desktop)
  rival.send(JSON.stringify({ type: 'uploadChunk', id: uploadId, data: 'eA==' }))
  const barrierReply = call(rival, { method: 'remote.graph' }), barrierFrame = await barrier
  expect(barrierFrame.operation.method).toBe('remote.graph')
  desktop.send(JSON.stringify({ type: 'result', id: barrierFrame.id, value: {} })); await barrierReply
  const routedChunk = next(desktop)
  granted.send(JSON.stringify({ type: 'uploadChunk', id: uploadId, data: 'eA==' }))
  expect(await routedChunk).toEqual({ type: 'uploadChunk', id: upload.id, data: 'eA==' })
  const routedEnd = next(desktop)
  granted.send(JSON.stringify({ type: 'uploadEnd', id: uploadId }))
  expect(await routedEnd).toEqual({ type: 'uploadEnd', id: upload.id })

  const officeRouted = next(desktop), officeId = randomUUID()
  granted.send(JSON.stringify({ type: 'request', id: officeId, operation: { method: 'remote.office', sessionId: 'fixture-session', path: 'report.docx' } }))
  const office = await officeRouted
  const officeProgress = next(granted)
  desktop.send(JSON.stringify({ type: 'event', id: office.id, value: { type: 'converting' } }))
  expect(await officeProgress).toMatchObject({ type: 'event', id: officeId })
  const officeBarrier = next(desktop)
  rival.send(JSON.stringify({ type: 'ack', id: officeId, count: 1 }))
  const officeBarrierReply = call(rival, { method: 'remote.graph' }), officeBarrierFrame = await officeBarrier
  expect(officeBarrierFrame.operation.method).toBe('remote.graph')
  desktop.send(JSON.stringify({ type: 'result', id: officeBarrierFrame.id, value: {} })); await officeBarrierReply
  const officeCredit = next(desktop)
  granted.send(JSON.stringify({ type: 'ack', id: officeId, count: 1 }))
  expect(await officeCredit).toEqual({ type: 'ack', id: office.id, count: 1 })

  const attachmentRouted = next(desktop), attachmentId = randomUUID()
  granted.send(JSON.stringify({ type: 'request', id: attachmentId, operation: { method: 'remote.attachment', sessionId: 'fixture-session', kind: 'file', attachmentId: 'opaque', name: 'a.txt' } }))
  const attachment = await attachmentRouted, attachmentBarrier = next(desktop)
  rival.send(JSON.stringify({ type: 'ack', id: attachmentId, count: 1 }))
  const attachmentBarrierReply = call(rival, { method: 'remote.graph' }), attachmentBarrierFrame = await attachmentBarrier
  expect(attachmentBarrierFrame.operation.method).toBe('remote.graph')
  desktop.send(JSON.stringify({ type: 'result', id: attachmentBarrierFrame.id, value: {} })); await attachmentBarrierReply
  const attachmentCredit = next(desktop)
  granted.send(JSON.stringify({ type: 'ack', id: attachmentId, count: 1 }))
  expect(await attachmentCredit).toEqual({ type: 'ack', id: attachment.id, count: 1 })

  const attachmentOfficeId = randomUUID(), attachmentOfficeRouted = next(desktop)
  granted.send(JSON.stringify({ type: 'request', id: attachmentOfficeId, operation: { method: 'remote.attachmentOffice', sessionId: 'fixture-session', attachmentId: 'opaque-office', name: 'a.docx' } }))
  const attachmentOffice = await attachmentOfficeRouted, attachmentOfficeBarrier = next(desktop)
  rival.send(JSON.stringify({ type: 'ack', id: attachmentOfficeId, count: 1 }))
  const attachmentOfficeBarrierReply = call(rival, { method: 'remote.graph' }), attachmentOfficeBarrierFrame = await attachmentOfficeBarrier
  expect(attachmentOfficeBarrierFrame.operation.method).toBe('remote.graph')
  desktop.send(JSON.stringify({ type: 'result', id: attachmentOfficeBarrierFrame.id, value: {} })); await attachmentOfficeBarrierReply
  const attachmentOfficeCredit = next(desktop)
  granted.send(JSON.stringify({ type: 'ack', id: attachmentOfficeId, count: 1 }))
  expect(await attachmentOfficeCredit).toEqual({ type: 'ack', id: attachmentOffice.id, count: 1 })

  const promptId = randomUUID(), promptRouted = next(desktop)
  granted.send(JSON.stringify({ type: 'request', id: promptId, operation: { method: 'remote.prompt', rpcId: randomUUID() } }))
  const prompt = await promptRouted, promptBarrier = next(desktop)
  rival.send(JSON.stringify({ type: 'uploadChunk', id: promptId, data: 'eA==' }))
  rival.send(JSON.stringify({ type: 'uploadEnd', id: promptId }))
  const promptBarrierReply = call(rival, { method: 'remote.graph' }), promptBarrierFrame = await promptBarrier
  expect(promptBarrierFrame.operation.method).toBe('remote.graph')
  desktop.send(JSON.stringify({ type: 'result', id: promptBarrierFrame.id, value: {} })); await promptBarrierReply
  const promptChunk = next(desktop)
  granted.send(JSON.stringify({ type: 'uploadChunk', id: promptId, data: 'eA==' }))
  expect(await promptChunk).toEqual({ type: 'uploadChunk', id: prompt.id, data: 'eA==' })
  const changesId = randomUUID(), changesRouted = next(desktop)
  granted.send(JSON.stringify({ type: 'request', id: changesId, operation: { method: 'remote.changes', sessionId: 'fixture-session', seq: 3, index: 0 } }))
  const changes = await changesRouted, changesBarrier = next(desktop)
  rival.send(JSON.stringify({ type: 'ack', id: changesId, count: 1 }))
  const changesBarrierReply = call(rival, { method: 'remote.graph' }), changesBarrierFrame = await changesBarrier
  expect(changesBarrierFrame.operation.method).toBe('remote.graph')
  desktop.send(JSON.stringify({ type: 'result', id: changesBarrierFrame.id, value: {} })); await changesBarrierReply
  const changesCredit = next(desktop)
  granted.send(JSON.stringify({ type: 'ack', id: changesId, count: 1 }))
  expect(await changesCredit).toEqual({ type: 'ack', id: changes.id, count: 1 })
  const cancelled: unknown[] = [], onCancel = (raw: WebSocket.RawData) => cancelled.push(JSON.parse(raw.toString()))
  desktop.on('message', onCancel)
  const grantClosed = once(granted, 'close')
  expect((await permission(false)).statusCode).toBe(200)
  await expect.poll(() => cancelled.length).toBe(9)
  expect(cancelled).toEqual(expect.arrayContaining([{ type: 'cancel', id: fileWatch.id }, { type: 'cancel', id: stream.id }, { type: 'cancel', id: upload.id }, { type: 'cancel', id: office.id }, { type: 'cancel', id: attachment.id }, { type: 'cancel', id: attachmentOffice.id }, { type: 'cancel', id: prompt.id }, { type: 'cancel', id: changes.id }]))
  desktop.off('message', onCancel); await grantClosed
  expect(cancelled).toContainEqual({ type: 'cancel', id: targetWatch.id })
  expect((await store.activeDevice(binding.deviceId))?.management).toBe(false)

  const forged = await device(), forgedClosed = once(forged, 'close')
  forged.send(JSON.stringify({ type: 'request', id: randomUUID(), context: { ...frame.context, management: true }, operation: { method: 'remote.graph' } }))
  expect((await forgedClosed)[0]).toBe(1008)
  await store.changeDevice(host.id, binding.deviceId, 'revoked')
  expect((await permission(true)).statusCode).toBe(404)
})

test('migration keeps an already-approved old device at basic permission', async () => {
  const db = new PGlite(), store = new Store(pgliteDatabase(db)); cleanup.push(() => db.close())
  await store.migrate()
  const host = await store.enrollHost('before-upgrade'), key = secret()
  await store.createPairing(host.id, key, 300)
  const device = await store.claimPairing(key, 'old', 'thumb')
  await store.changeDevice(host.id, device.deviceId, 'active')
  await db.exec('ALTER TABLE devices DROP COLUMN management')
  await store.migrate()
  expect(await store.activeDevice(device.deviceId)).toMatchObject({ status: 'active', management: false })
})
