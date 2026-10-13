import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, onTestFinished, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import WebSocket from 'ws'
import { calculateJwkThumbprint } from 'jose'
import { buildGateway } from '../packages/gateway/src/app.js'
import { Store } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'
import { clientKey, proof } from './support/proof.js'
import { latestHostCleanup } from './support/latest-host-cleanup.js'

// 专项显式启动；不准备/覆盖正在运行的候选，不使用日常 App、Key 或配对。
test.skipIf(process.env.DSHM_LATEST_CORDIS_TWO_PAGES !== '1')('新版真实Host的双页面迟到审批、版本交错、共享运行与移除', async () => {
  const android = process.env.DSHM_LATEST_CORDIS_ANDROID === '1'
  const twoAndroid = process.env.DSHM_LATEST_CORDIS_TWO_ANDROID === '1'
  assert.ok(!twoAndroid || android, '双 Android 专项必须使用实际原生载体')
  const failures = process.env.DSHM_LATEST_CORDIS_FAILURES === '1'
  assert.ok(!failures || twoAndroid, '插件自身异常专项必须使用两个独立 Android 客户端')
  const factoryFailure = process.env.DSHM_LATEST_CORDIS_FACTORY === '1'
  const renderFailure = process.env.DSHM_LATEST_CORDIS_RENDER === '1' || factoryFailure
  assert.ok(!factoryFailure || process.env.DSHM_LATEST_CORDIS_RENDER !== '1', '两个渲染专项使用独立证据')
  assert.ok(!renderFailure || twoAndroid, '渲染异常专项必须使用两个独立 Android 客户端')
  const lateCode = process.env.DSHM_LATEST_CORDIS_LATE_CODE === '1'
  assert.ok(!lateCode || android, '迟到原生代码专项必须使用实际 Android')
  const sourceMode = process.env.DSHM_LATEST_SOURCE_CHECK === '1'
  const source = resolve('../plugin/artifacts/latest-source-check')
  let sourceEvidence: any
  if (sourceMode) {
    const { verifyInstalledSource } = await import(/* @vite-ignore */ pathToFileURL(resolve('../plugin/compatibility/latest-upstream/source-host.mjs')).href)
    sourceEvidence = await verifyInstalledSource()
  }
  const runtime = resolve('../plugin/artifacts/latest-runtime-check')
  const pack = resolve(runtime, 'candidate-package-check-yr3WGO')
  const packageReport = JSON.parse(await readFile(resolve(pack, 'report.json'), 'utf8'))
  expect(packageReport.passed).toBe(true)
  const archive = await readFile(resolve(pack, 'dsh-mobile-plugin-0.1.76-latest.0.tgz'))
  expect(createHash('sha256').update(archive).digest('hex')).toBe(packageReport.package.sha256)
  const plugin = resolve(pack, 'consumer/node_modules/@dsh-mobile/plugin/dist/index.js')
  expect(await readFile(plugin)).toEqual(execFileSync('tar', ['-xOf',
    resolve(pack, 'dsh-mobile-plugin-0.1.76-latest.0.tgz'), 'package/dist/index.js'],
    { cwd: pack, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }))
  await mkdir(resolve(runtime, 'relay-homes'), { recursive: true })
  const home = await mkdtemp(resolve(runtime, 'relay-homes/latest-cordis-race-'))
  await mkdir(resolve('.test-data'), { recursive: true })
  const output = await mkdtemp(resolve(factoryFailure ? '.test-data/latest-cordis-factory-' : renderFailure ? '.test-data/latest-cordis-render-' : failures ? '.test-data/latest-cordis-failures-' : twoAndroid ? '.test-data/latest-cordis-two-android-' : lateCode ? '.test-data/latest-cordis-late-code-' : sourceMode ? '.test-data/latest-cordis-source-' : android
    ? '.test-data/latest-cordis-android-browser-' : '.test-data/latest-cordis-two-pages-'))
  const report: Record<string, any> = { at: new Date().toISOString(), passed: false, output, home,
    version: '0.2.1-alpha.1', archiveSha256: packageReport.package.sha256,
    executionMode: sourceMode ? 'source' : 'npm', command: sourceMode ? 'pnpm dsh web' : 'published CLI',
    lateCodeRequested: lateCode, twoAndroidRequested: twoAndroid, failuresRequested: failures, renderFailureRequested: renderFailure, factoryFailureRequested: factoryFailure,
    ...(sourceMode ? { sourceEvidence } : {}),
    carriers: twoAndroid ? ['Android', 'Android'] : android ? ['browser', 'Android'] : ['browser', 'browser'],
    androidVerified: false, inferenceVerified: false, approvals: [], stages: [] }
  const mark = (stage: string) => { report.stage = stage; report.stages.push(stage); console.log('Cordis two pages: ' + stage) }
  const patches: any[] = []
  let originalUiPath: string | undefined
  let originalUiHash: string | undefined
  let originalRunnerPath: string | undefined
  let originalRunnerHash: string | undefined
  if (renderFailure && !sourceMode) {
    const { prepareLatestCordisScopes } = await import(/* @vite-ignore */ pathToFileURL(resolve('../plugin/compatibility/latest-upstream/cordis-scopes.mjs')).href)
    const candidate = await prepareLatestCordisScopes({ write: false })
    const packageRoot = resolve(home, 'cordis-host-render-sync')
    await cp(resolve(runtime, 'node_modules/@deepseek-ai/dsh-cordis-host-runner'), packageRoot, { recursive: true })
    for (const file of candidate.files) {
      const relative = file.path.slice(resolve(runtime, 'node_modules/@deepseek-ai/dsh-cordis-host-runner').length + 1)
      await writeFile(resolve(packageRoot, relative), file.modified)
    }
    originalRunnerPath = candidate.files[0].path
    originalRunnerHash = createHash('sha256').update(await readFile(originalRunnerPath!)).digest('hex')
    patches.push({ id: 'cordis-host-runner', disabled: true },
      { insert: [{ id: 'dshm-cordis-host-render-sync', name: pathToFileURL(resolve(packageRoot, 'lib/index.js')).href }] })
    report.renderSyncCandidate = { path: resolve(packageRoot, 'lib/index.js'), sha256: candidate.files[0].after,
      installedRuntimeSha256: originalRunnerHash }
  }
  if ((lateCode || twoAndroid) && !sourceMode) {
    // 原插件加载器挂载独立的同名兼容包，主模型 Host 的安装文件保持原位。
    const { prepareLatestCordisClientLifetime } = await import(/* @vite-ignore */ pathToFileURL(resolve('../plugin/compatibility/latest-upstream/cordis-client-lifetime.mjs')).href)
    const prepared = await prepareLatestCordisClientLifetime({ write: false })
    const ui = prepared.files.find((row: any) => row.path.endsWith('dsh-client-ui-cordis\\lib\\client.js') || row.path.endsWith('dsh-client-ui-cordis/lib/client.js'))
    assert.ok(ui, '缺少固定新版 UI 兼容载荷')
    originalUiPath = ui.path
    originalUiHash = createHash('sha256').update(await readFile(ui.path)).digest('hex')
    const packageRoot = resolve(home, 'ui-cordis-ready'), lib = resolve(packageRoot, 'lib')
    await mkdir(lib, { recursive: true })
    const originalPackage = resolve(runtime, 'node_modules/@deepseek-ai/dsh-client-ui-cordis')
    await writeFile(resolve(packageRoot, 'package.json'), await readFile(resolve(originalPackage, 'package.json')))
    await writeFile(resolve(lib, 'index.js'), await readFile(resolve(originalPackage, 'lib/index.js')))
    await writeFile(resolve(lib, 'client.js'), ui.modified)
    // 原 patch 的 name 是身份校验，不能用于改写；禁用原条目后挂载同包名的新来源。
    patches.push({ id: 'ui-cordis', disabled: true },
      { insert: [{ id: 'dshm-ui-cordis-ready', name: pathToFileURL(resolve(lib, 'index.js')).href }] })
    report.inventoryReadyCandidate = { path: resolve(lib, 'client.js'), sha256: ui.after, installedRuntimeSha256: originalUiHash }
  }
  const overlay = resolve(home, 'plugin.patch.json')
  await writeFile(overlay, JSON.stringify([...patches, { insert: [
    { id: 'dsh-mobile', name: pathToFileURL(plugin).href },
    { id: 'latest-cordis-race-fixture', name: pathToFileURL(resolve('tests/support/latest-cordis-race-fixture.mjs')).href },
  ] }]))
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string') throw Error('race_missing_port')
  await new Promise<void>(done => reservation.close(() => done()))
  const origin = `http://127.0.0.1:${address.port}`
  const db = new PGlite(), store = new Store(pgliteDatabase(db))
  await store.migrate()
  const gateway = await buildGateway({ store, publicOrigin: origin, registrationMode: 'open' })
  await gateway.listen({ host: '127.0.0.1', port: address.port })
  const env: NodeJS.ProcessEnv = { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMFILES'])
    if (process.env[key] !== undefined) env[key] = process.env[key]
  const hosts = new Set<ReturnType<typeof spawn>>()
  const stopHost = latestHostCleanup(hosts, true, sourceMode ? source : runtime)
  const child = spawn(process.execPath, [
    ...(sourceMode ? [resolve(source, 'node_modules/pnpm/bin/pnpm.cjs'), 'dsh', 'web']
      : [resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web']),
    '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    { cwd: sourceMode ? source : runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  hosts.add(child); report.launcherPid = child.pid
  const closed = once(child, 'close')
  let stdout = '', stderr = ''
  child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', value => { stdout += value }); child.stderr!.on('data', value => { stderr += value })
  const sockets = new Set<WebSocket>(), pages: any[] = []
  let nativeGate: any
  const nativeGates: any[] = []
  let nativeQueue: any
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    await nativeQueue?.close()
    for (const page of pages) await page.close()
    for (const gate of nativeGates) gate.close()
    for (const socket of sockets) socket.terminate()
    await gateway.close(); await db.close()
    if (originalUiPath) {
      expect(createHash('sha256').update(await readFile(originalUiPath)).digest('hex')).toBe(originalUiHash)
      report.installedUiRuntimeUnchanged = true
    }
    if (originalRunnerPath) {
      expect(createHash('sha256').update(await readFile(originalRunnerPath)).digest('hex')).toBe(originalRunnerHash)
      report.installedRunnerRuntimeUnchanged = true
    }
    cleaned = true
  }
  onTestFinished(cleanup)
  try {
    mark('host-start')
    await expect.poll(() => stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1], { timeout: 45000 }).toBeTruthy()
    const entry = stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)![1]!
    const login = await fetch(entry, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
    expect(login.status).toBe(303)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const manage = async (action?: unknown) => {
      const response = await fetch(new URL('/api/dsh-mobile', entry), { method: action ? 'POST' : 'GET',
        headers: { cookie, 'content-type': 'application/json' }, body: action ? JSON.stringify(action) : undefined,
        signal: AbortSignal.timeout(15000) })
      expect(response.status).toBe(200); return response.json()
    }
    const desktop = async (method: string, args: unknown) => {
      const response = await fetch(new URL('/api/' + method, entry), { method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(15000) })
      expect(response.status).toBe(200)
      const frame = await response.json(); expect(frame.result.ok).toBe(true); return frame.result.value
    }
    await manage({ action: 'setup', origin, name: 'Latest Cordis two pages' }); await manage({ action: 'enable' })
    await expect.poll(async () => (await manage()).connection, { timeout: 15000 }).toBe('online')
    const project = resolve(home, 'project'); await mkdir(project)
    const registered = await desktop('workspace/create', { request: { path: project } })
    const sessionId = 'latest-relay-' + randomUUID(), title = 'Latest Cordis two pages'
    await desktop('session/create', { request: { workspaceId: registered.workspace.workspaceId, sessionId } })
    // 原手机列表隐藏空会话；通过原 prompt 保存真实缺凭据记录，不注入假模型输出。
    await desktop('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: 'LATEST_CORDIS_RACE_HISTORY' }] } })
    await expect.poll(async () => (await desktop('session/list', { _request: {} })).items.find((row: any) => row.sessionId === sessionId)?.running,
      { timeout: 15000 }).toBe(false)
    await desktop('session/rename', { request: { sessionId, title } })
    const mutate = async (action: 'next' | 'request', failure?: 'host' | 'client' | 'handler' | 'render' | 'factory') => {
      const id = randomUUID(); await writeFile(resolve(home, 'race-control.json'), JSON.stringify({ id, action, sessionId, ...(failure ? { failure } : {}) }))
      let value: any
      await expect.poll(async () => {
        try { value = JSON.parse(await readFile(resolve(home, 'race-receipt.json'), 'utf8')); return value.id }
        catch { return undefined }
      }, { timeout: 15000 }).toBe(id)
      expect(value.error).toBeUndefined(); return value
    }
    const inventory = async () => (await desktop('dynamicCordisRunner/inventory', {}))[0]
    const makeDevice = async (name: string) => {
      const pairing = await manage({ action: 'pair' })
      const key = new URLSearchParams(new URL(pairing.link).hash.slice(1)).get('key'), identity = await clientKey()
      const api = async (path: string, token?: string, body?: unknown) => fetch(origin + path, { method: 'POST',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          dpop: await proof(identity, origin + path, 'POST', token), ...(token ? { authorization: 'DPoP ' + token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
      const response = await api('/v1/pairings/claim', undefined, { key, name })
      expect(response.status).toBe(201); const claim = await response.json()
      expect((await api('/v1/device/ticket', claim.token)).status).toBe(403)
      await manage({ action: 'approve', deviceId: claim.deviceId })
      const connect = async (): Promise<any> => {
        const ticketResponse = await api('/v1/device/ticket', claim.token)
        expect(ticketResponse.status).toBe(200); const { ticket } = await ticketResponse.json()
        const socket = new WebSocket(origin.replace('http:', 'ws:') + '/v1/device/socket'); sockets.add(socket)
        const frames: any[] = []
        const capture = (bytes: any) => frames.push(JSON.parse(bytes.toString()))
        socket.on('message', capture); await once(socket, 'open'); socket.send(JSON.stringify({ type: 'authenticate', ticket }))
        await expect.poll(() => frames.some(frame => frame.type === 'ready'), { timeout: 15000 }).toBe(true)
        const ready = frames.find(frame => frame.type === 'ready'); socket.off('message', capture)
        const { createLatestRacePage } = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/support/latest-cordis-race-page.mjs')).href)
        const view = await createLatestRacePage({ socket, ready, binding: { paired: true, origin,
          deviceId: claim.deviceId, fingerprint: await calculateJwkThumbprint(identity.jwk) } })
        pages.push(view)
        await view.page.getByRole('button').filter({ hasText: title }).click()
        await view.page.locator('[data-composer-input]').waitFor()
        const panel = view.page.getByRole('region', { name: '插件面板', exact: true })
        const open = async () => {
          await view.page.getByRole('button', { name: 'Remote 选项', exact: true }).click()
          await view.page.getByRole('button', { name: '插件面板', exact: true }).click()
          await panel.waitFor()
        }
        const expand = async () => {
          if (!await panel.locator('[data-cordis-panel]').isVisible()) await panel.locator('[data-cordis-badge]').click()
          await panel.locator('[data-cordis-panel]').waitFor()
        }
        return { ...view, panel, open, expand, socket, claim, api, connect }
      }
      return connect()
    }
    mark('pair-two-independent-devices')
    const makeNativeDevice = async (packageName?: string, name = 'Latest race Android', ownsReverse = true) => {
      const { createLatestNativeGate } = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/support/latest-cordis-native-gate.mjs')).href)
      const { createLatestRaceAndroid } = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/support/latest-cordis-race-android.mjs')).href)
      const gate = createLatestNativeGate(gateway.websocketServer, { singleConnection: twoAndroid })
      nativeGates.push(gate)
      const pairing = await manage({ action: 'pair' })
      const client = await createLatestRaceAndroid({ origin, pairLink: pairing.link, title, gate,
        packageName, name, ownsReverse, connectionScoped: twoAndroid,
        approve: async (fingerprint: string) => {
          let device: any
          await expect.poll(async () => {
            device = (await manage()).devices.find((item: any) => item.fingerprint === fingerprint)
            return device?.status
          }, { timeout: 15000 }).toBe('pending')
          expect(device.name).toBe(name)
          await manage({ action: 'approve', deviceId: device.id })
          const approved = (await manage()).devices.find((item: any) => item.id === device.id)
          expect(approved).toMatchObject({ status: 'active', management: false, fingerprint })
          return { deviceId: device.id, fingerprint }
        } })
      pages.push(client)
      return client
    }
    let first = twoAndroid
      ? await makeNativeDevice('dev.dshmobile.validation.latestcordispeer', 'Latest race Android peer')
      : await makeDevice('Latest race first')
    const second = android ? await makeNativeDevice(undefined, 'Latest race Android', !twoAndroid)
      : await makeDevice('Latest race second')
    if (android) { nativeGate = nativeGates.at(-1); report.native = nativeGate.report }
    if (twoAndroid) {
      report.nativeClients = nativeGates.map(gate => gate.report)
      expect(first.claim.fingerprint).not.toBe(second.claim.fingerprint)
      report.independentAndroidIdentities = [first, second].map(client => ({
        packageName: client.report.packageName, deviceId: client.claim.deviceId, fingerprint: client.claim.fingerprint }))
      expect(first.report.resourceUi.some((item: any) => item.inventoryReadyGuard)).toBe(true)
    }
    if (lateCode || twoAndroid) expect(second.report.resourceUi.some((item: any) => item.inventoryReadyGuard)).toBe(true)
    const focus = async (client: any) => { if (client.native) await client.focus() }
    expect(first.claim.deviceId).not.toBe(second.claim.deviceId)
    await first.open(); await second.open()
    let receipt: any
    for (const scenario of [
      { version: 1, winner: 'approve', late: 'decline', pending: true },
      { version: 2, winner: 'approve', late: 'approve', pending: true },
      { version: 3, winner: 'decline', late: 'approve', pending: false },
    ]) {
      mark('request-v' + scenario.version)
      receipt = (await mutate('next')).receipt
      const requested = await mutate('request')
      expect(requested.result.status).toBe('awaiting-approval')
      const row1 = first.panel.locator(`[data-cordis-row="${receipt.pluginId}"]`)
      const row2 = second.panel.locator(`[data-cordis-row="${receipt.pluginId}"]`)
      await first.expand(); await second.expand()
      await row1.locator('[data-cordis-approve]').waitFor(); await row2.locator('[data-cordis-approve]').waitFor()
      first.hold({ streams: true }); second.hold({ code: scenario.pending })
      mark('winner-' + scenario.winner + '-v' + scenario.version)
      await row2.locator(`[data-cordis-${scenario.winner}]`).click()
      await expect.poll(async () => (await inventory())?.latestRun?.status, { timeout: 15000 })
        .toBe(scenario.pending ? 'client-pending' : 'rejected')
      const before = await inventory()
      if (scenario.pending) await expect.poll(() => second.report.held.some((frame: any) => frame.endpoint.endsWith('/getClientCode'))).toBe(true)
      const count = first.report.results.length
      mark('late-' + scenario.late + '-v' + scenario.version)
      await focus(first)
      await row1.locator(`[data-cordis-${scenario.late}]`).click()
      await expect.poll(() => first.report.results.slice(count).some((result: any) => scenario.late === 'decline'
        ? result.endpoint.endsWith('/resolveRequestRun') && result.frame.value?.value?.accepted === false
        : result.endpoint.endsWith('/runHostHalf') && result.frame.value?.value?.ok === false), { timeout: 15000 }).toBe(true)
      const after = await inventory()
      expect(after.activeRun).toEqual(before.activeRun)
      expect(after.latestRun.pluginRunId).toBe(before.latestRun.pluginRunId)
      expect(after.latestRun.approvalRequestId).toBe(before.latestRun.approvalRequestId)
      expect(after.latestRun.status).toBe(before.latestRun.status)
      expect(first.report.held.length).toBeGreaterThan(0)
      await first.release(); await second.release()
      if (scenario.pending) {
        await focus(second)
        await expect.poll(async () => (await inventory())?.latestRun?.status, { timeout: 15000 }).toBe('running')
        expect((await inventory()).activeRun).toEqual(before.activeRun)
      }
      report.approvals.push({ ...scenario, originalLateOperationRejected: true, runAndRequestPreserved: true,
        activeRun: after.activeRun, approvalRequestId: after.latestRun.approvalRequestId })
      // 清单可被在途目录重新展开；必须核验旧审批已消失，不把自动收起当作结算依据。
      await focus(first); await row1.locator('[data-cordis-approve]').waitFor({ state: 'detached' })
      await focus(second); await row2.locator('[data-cordis-approve]').waitFor({ state: 'detached' })
      for (const client of [first, second]) {
        await focus(client)
        if (await client.panel.locator('[data-cordis-panel]').isVisible()) await client.panel.locator('[data-cordis-badge]').click()
        await client.panel.locator('[data-cordis-panel]').waitFor({ state: 'detached' })
      }
      if (scenario.version === 2) {
        mark('second-client-attach-same-run')
        let active = (await inventory()).activeRun
        await first.expand()
        await row1.locator('select').selectOption(active.packageId)
        await row1.locator('[data-cordis-switch="run"]').click()
        await expect.poll(() => row1.getAttribute('data-cordis-status')).toBe('running')
        expect((await inventory()).activeRun).toEqual(active)
        report.sharedOriginalRun = true
        await first.panel.locator('[data-cordis-badge]').click()
        await first.panel.locator('[data-cordis-panel]').waitFor({ state: 'detached' })
        if (android) {
          mark('native-socket-disconnect-and-automatic-reconnect')
          await second.reconnect()
          expect((await inventory()).activeRun).toEqual(active)
          expect((await manage()).devices.find((item: any) => item.id === second.claim.deviceId))
            .toMatchObject({ fingerprint: second.claim.fingerprint, status: 'active', management: false })
          report.nativeSameBindingSameRunReconnected = true
          if (lateCode) {
            mark('native-client-code-pending-before-disconnect')
            const { createLatestNativeCodeQueue } = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/support/latest-cordis-native-queue.mjs')).href)
            nativeQueue = await createLatestNativeCodeQueue(second.page)
            await second.expand()
            await row2.locator('[data-cordis-switch="stop"]').click()
            await expect.poll(async () => (await inventory()).activeRun).toBeUndefined()
            await row2.locator('select').selectOption(active.packageId)
            await row2.locator('[data-cordis-switch="run"]').click()
            await expect.poll(async () => (await nativeQueue.snapshot()).held.length).toBeGreaterThan(0)
            await expect.poll(async () => (await inventory()).latestRun.status).toBe('client-pending')
            const pending = await inventory(), old = await nativeQueue.snapshot()
            report.nativeLateCode = { oldFrames: old.held, pendingActiveRun: pending.activeRun, oldResponseIgnored: false }
            expect(pending.activeRun.packageId).toBe(active.packageId)
            expect(pending.activeRun.pluginRunId).not.toBe(active.pluginRunId)
            await nativeQueue.freeze()
            mark('native-reconnect-before-old-code-settles')
            await second.reconnect({ expectLoaded: false })
            // 原 DSH 在代码未加载完成时不自动重放用户运行；新连接由原按钮显式加载。
            await second.expand()
            await row2.locator('select').selectOption(pending.activeRun.packageId)
            await row2.locator('[data-cordis-switch="run"]').click()
            await expect.poll(() => row2.getAttribute('data-cordis-status')).toBe('running')
            active = (await inventory()).activeRun
            expect(active).toEqual(pending.activeRun)
            const fresh = await nativeQueue.snapshot()
            const newCode = fresh.requests.filter((item: any) => item.endpoint.endsWith('/getClientCode')
              && !old.held.some((frame: any) => frame.id === item.id))
            expect(newCode.length).toBeGreaterThan(0)
            expect(fresh.held).toEqual(old.held)
            const mutations = () => second.report.operations.filter((item: any) =>
              ['dynamicCordisRunner/runHostHalf', 'dynamicCordisRunner/settleUserRun', 'dynamicCordisRunner/resolveRequestRun'].includes(item.endpoint)).length
            const countBefore = mutations()
            mark('deliver-original-old-native-code-after-new-connection')
            const released = await nativeQueue.release()
            expect(released).toEqual(old.held)
            await second.page.waitForTimeout(500)
            expect(mutations()).toBe(countBefore)
            expect((await inventory()).activeRun).toEqual(active)
            expect((await inventory()).latestRun.status).toBe('running')
            await second.panel.getByRole('button', { name: '返回聊天', exact: true }).click()
            const echo = second.page.getByTestId('latest-race-echo')
            expect(await echo.getAttribute('data-version')).toBe('2')
            await echo.click(); await echo.getByText('LATEST_RACE_HOST_V2', { exact: true }).waitFor()
            await second.open()
            report.nativeLateCode = { oldFrames: released, freshRequestIds: newCode.map((item: any) => item.id),
              activeRun: active, oldResponseIgnored: true, originalBytesReplayed: true, noExtraSettlement: true }
            await nativeQueue.close(); nativeQueue = undefined
          }
        }
        mark(twoAndroid ? 'first-native-same-device-new-ticket-and-connection' : 'same-device-new-ticket-and-page')
        const firstId = first.claim.deviceId
        if (twoAndroid) {
          // 第二端刚创建了新的 Host activation；第一端尚未加载它，不能假设重连会自动运行。
          await first.reconnect({ expectLoaded: !lateCode })
          expect((await inventory()).activeRun).toEqual(active)
          expect((await manage()).devices.find((item: any) => item.id === firstId))
            .toMatchObject({ status: 'active', management: false, fingerprint: first.claim.fingerprint })
        } else {
          await first.close()
          const disconnected = once(first.socket, 'close'); first.socket.terminate(); await disconnected
          first = await first.connect()
        }
        expect(first.claim.deviceId).toBe(firstId)
        if (!twoAndroid) await first.open()
        await first.expand()
        const reconnectedRow = first.panel.locator(`[data-cordis-row="${receipt.pluginId}"]`)
        if (!twoAndroid || lateCode) {
          await reconnectedRow.locator('select').selectOption(active.packageId)
          await expect.poll(() => reconnectedRow.getAttribute('data-cordis-status')).toBe('client-pending')
          await reconnectedRow.locator('[data-cordis-switch="run"]').click()
        }
        await expect.poll(() => reconnectedRow.getAttribute('data-cordis-status')).toBe('running')
        expect((await inventory()).activeRun).toEqual(active)
        await first.panel.locator('[data-cordis-badge]').click()
        await first.panel.locator('[data-cordis-panel]').waitFor({ state: 'detached' })
        report.sameBindingNewTicketSameRun = true
      }
    }
    mark('winning-version-local-ui')
    for (const client of [first, second]) { await focus(client); await client.panel.getByRole('button', { name: '返回聊天', exact: true }).click() }
    for (const client of [first, second]) {
      await focus(client)
      const echo = client.page.getByTestId('latest-race-echo')
      await expect.poll(() => echo.getAttribute('data-version')).toBe('2')
      await echo.click(); await echo.getByText('LATEST_RACE_HOST_V2', { exact: true }).waitFor()
    }
    report.rejectedVersionDidNotLoad = true
    const expectedFailureErrors = new Map<any, string[]>()
    if (failures) {
      const knownGood = (await inventory()).activeRun.packageId
      report.pluginFailures = []
      for (const failure of ['host', 'client', 'handler'] as const) {
        mark('plugin-own-' + failure + '-failure')
        await first.open(); await first.expand(); await second.open(); await second.expand()
        const defined = await mutate('next', failure)
        const failedPackage = defined.receipt.packageId
        const marker = failure === 'host' ? 'LATEST_RACE_HOST_APPLY_V4'
          : failure === 'client' ? 'LATEST_RACE_CLIENT_APPLY_V5' : 'LATEST_RACE_HANDLER_V6'
        const request = await mutate('request')
        const errorCount = second.report.consoleErrors.length
        const selected = second.panel.locator(`[data-cordis-row="${receipt.pluginId}"]`)
        await selected.locator('[data-cordis-approve]').waitFor()
        await selected.locator('[data-cordis-approve]').click()
        if (failure === 'handler') {
          await expect.poll(async () => (await inventory()).latestRun.status).toBe('running')
          await second.panel.getByRole('button', { name: '返回聊天', exact: true }).click()
          const echo = second.page.getByTestId('latest-race-echo')
          await expect.poll(() => echo.getAttribute('data-version')).toBe('6')
          await echo.click(); await echo.getByText(new RegExp(marker)).waitFor()
          const invoke = second.report.results.filter((item: any) => item.endpoint === 'dynamicCordisRunner/invoke').at(-1)
          expect(invoke.frame.value.value).toMatchObject({ ok: false, code: 'handler-error', message: marker })
          await second.open(); await second.expand()
        } else {
          await expect.poll(async () => (await inventory()).latestRun.status).toBe('failed')
          await second.expand()
          await selected.getByRole('alert').filter({ hasText: marker }).waitFor()
        }
        const actual = await inventory()
        expect(actual.latestRun.packageId).toBe(failedPackage)
        expect(actual.latestRun.pluginRunId).toBe(request.result.pluginRunId)
        if (failure !== 'handler') {
          expect(actual.activeRun).toBeUndefined()
          expect(actual.currentPackageId).toBe(knownGood)
          expect(actual.latestRun.error).toMatchObject({ phase: failure === 'host' ? 'host-apply' : 'client-apply' })
          expect(actual.latestRun.error.message).toContain(marker)
          expect(actual.packages.some((item: any) => item.packageId === knownGood)).toBe(true)
          await first.expand()
          const peerRow = first.panel.locator(`[data-cordis-row="${receipt.pluginId}"]`)
          await peerRow.locator('select').selectOption(failedPackage)
          await expect.poll(() => peerRow.getAttribute('data-cordis-status')).toBe('failed')
          await peerRow.getByRole('alert').filter({ hasText: marker }).waitFor()
          for (const client of [first, second]) {
            await focus(client)
            await client.page.getByTestId('latest-race-echo').waitFor({ state: 'detached' })
          }
        } else {
          expect(actual.activeRun.packageId).toBe(failedPackage)
          expect(actual.latestRun.status).toBe('running')
        }
        const emitted = second.report.consoleErrors.slice(errorCount)
        if (failure === 'client') {
          expect(emitted).toHaveLength(1)
          expect(emitted[0]).toMatch(/^\[cordis-client-runner\] Client activation .* failed: Error: LATEST_RACE_CLIENT_APPLY_V5/)
          expectedFailureErrors.set(second, emitted)
        } else expect(emitted).toEqual([])
        mark('explicit-recovery-after-' + failure)
        for (const client of [first, second]) {
          await focus(client); await client.expand()
          const recovery = client.panel.locator(`[data-cordis-row="${receipt.pluginId}"]`)
          await recovery.locator('select').selectOption(knownGood)
          await recovery.locator('[data-cordis-switch="run"]').click()
          await expect.poll(() => recovery.getAttribute('data-cordis-status')).toBe('running')
          expect((await inventory()).activeRun.packageId).toBe(knownGood)
          await recovery.getByRole('alert').waitFor({ state: 'detached' })
          await client.panel.getByRole('button', { name: '返回聊天', exact: true }).click()
          const echo = client.page.getByTestId('latest-race-echo')
          await expect.poll(() => echo.getAttribute('data-version')).toBe('2')
          await echo.click(); await echo.getByText('LATEST_RACE_HOST_V2', { exact: true }).waitFor()
        }
        report.pluginFailures.push({ failure, marker, originalInventory: actual,
          bothPagesRecoveredToKnownGood: true, originalHostEcho: true, expectedConsoleErrors: emitted })
      }
    }
    if (renderFailure) {
      mark(factoryFailure ? 'plugin-own-factory-render-failure' : 'plugin-own-render-failure')
      const knownGood = (await inventory()).activeRun.packageId
      await first.open(); await first.expand(); await second.open(); await second.expand()
      const defined = await mutate('next', factoryFailure ? 'factory' : 'render')
      const marker = `LATEST_RACE_${factoryFailure ? 'FACTORY_RENDER' : 'RENDER'}_V${defined.version}`
      const failedSlot = factoryFailure ? 'factory:latest.race.factory' : 'conversation.session.header.actions'
      const request = await mutate('request')
      const selected = second.panel.locator(`[data-cordis-row="${receipt.pluginId}"]`)
      await selected.locator('[data-cordis-approve]').waitFor()
      await selected.locator('[data-cordis-approve]').click()
      await expect.poll(async () => (await inventory()).latestRun.status).toBe('running')
      await second.panel.getByRole('button', { name: '返回聊天', exact: true }).click()
      const echo = second.page.getByTestId('latest-race-echo')
      await expect.poll(() => echo.getAttribute('data-version')).toBe(String(defined.version))
      const errorCount = second.report.consoleErrors.length
      await echo.click()
      await expect.poll(async () => (await inventory()).latestRun.error?.phase).toBe('client-render')
      const actual = await inventory()
      expect(actual.activeRun).toMatchObject({ packageId: defined.receipt.packageId, pluginRunId: request.result.pluginRunId })
      expect(actual.latestRun.status).toBe('failed')
      expect(actual.latestRun.error.message).toContain(marker)
      if (factoryFailure) {
        await second.page.locator('[data-factory-error="latest.race.factory"]').waitFor({ state: 'attached' })
        await echo.waitFor({ state: 'detached' })
        const survivor = second.page.getByTestId('latest-race-survivor')
        await survivor.click(); await survivor.getByText('LATEST_RACE_FACTORY_SURVIVOR', { exact: true }).waitFor()
      }
      await second.open(); await second.expand()
      const crash = selected.locator('[data-cordis-render-failure]')
      await crash.getByText(new RegExp(marker)).waitFor()
      expect(await crash.getAttribute('data-cordis-render-failure')).toBe(failedSlot)
      expect(await crash.getAttribute('data-cordis-render-abdicated')).toBe(factoryFailure ? null : 'true')
      // 本页局部组件崩溃经原 renderer 上报；不得用整个页面被销毁代替局部失败。
      expect(second.report.pageErrors).toEqual([])
      const emitted = second.report.consoleErrors.slice(errorCount)
      expect(emitted).toHaveLength(2)
      expect(emitted.every((value: string) => value.includes(marker))).toBe(true)
      const boundaryMessage = factoryFailure ? "slot factory occurrence crashed in 'latest.race.factory':"
        : "slot entry crashed in 'conversation.session.header.actions':"
      expect(emitted.some((value: string) => value.startsWith(boundaryMessage))).toBe(true)
      expectedFailureErrors.set(second, [...(expectedFailureErrors.get(second) ?? []), ...emitted])
      await first.expand()
      const peer = first.panel.locator(`[data-cordis-row="${receipt.pluginId}"]`)
      await peer.locator('select').selectOption(defined.receipt.packageId)
      await peer.getByRole('alert').filter({ hasText: marker }).waitFor()
      const reports = second.report.operations.filter((item: any) => item.endpoint === 'dynamicCordisRunner/reportRenderFailure')
      expect(reports).toHaveLength(1)
      report.renderFailure = { marker, originalInventory: actual, originalReports: reports,
        slot: await crash.getAttribute('data-cordis-render-failure'), abdicated: await crash.getAttribute('data-cordis-render-abdicated'),
        expectedConsoleErrors: emitted, ...(factoryFailure ? { siblingSurvivedAndInvokedHost: true } : {}), bothPagesRecoveredToKnownGood: false }
      mark('explicit-recovery-after-render')
      for (const client of [first, second]) {
        await focus(client); await client.expand()
        const recovery = client.panel.locator(`[data-cordis-row="${receipt.pluginId}"]`)
        await recovery.locator('select').selectOption(knownGood)
        await recovery.locator('[data-cordis-switch="run"]').click()
        await expect.poll(() => recovery.getAttribute('data-cordis-status')).toBe('running')
        expect((await inventory()).activeRun.packageId).toBe(knownGood)
        await recovery.getByRole('alert').waitFor({ state: 'detached' })
        await recovery.locator('[data-cordis-render-failure]').waitFor({ state: 'detached' })
        await client.panel.getByRole('button', { name: '返回聊天', exact: true }).click()
        const recovered = client.page.getByTestId('latest-race-echo')
        await expect.poll(() => recovered.getAttribute('data-version')).toBe('2')
        await recovered.click(); await recovered.getByText('LATEST_RACE_HOST_V2', { exact: true }).waitFor()
      }
      report.renderFailure.bothPagesRecoveredToKnownGood = true
    }
    mark('stop-and-restart-synchronize-both-pages')
    await first.open(); await first.expand(); await second.open(); await second.expand()
    const row = first.panel.locator(`[data-cordis-row="${receipt.pluginId}"]`)
    const otherRow = second.panel.locator(`[data-cordis-row="${receipt.pluginId}"]`)
    const previousRun = (await inventory()).activeRun
    await otherRow.locator('[data-cordis-switch="stop"]').click()
    await expect.poll(async () => (await inventory()).activeRun).toBeUndefined()
    for (const client of [first, second]) { await focus(client); await client.page.getByTestId('latest-race-echo').waitFor({ state: 'detached' }) }
    report.stopUnloadedBothPages = true
    await focus(first)
    await row.locator('select').selectOption(previousRun.packageId)
    await row.locator('[data-cordis-switch="run"]').click()
    await expect.poll(() => row.getAttribute('data-cordis-status')).toBe('running')
    const restarted = (await inventory()).activeRun
    expect(restarted.packageId).toBe(previousRun.packageId)
    expect(restarted.pluginRunId).not.toBe(previousRun.pluginRunId)
    await focus(second); await otherRow.locator('select').selectOption(restarted.packageId)
    await expect.poll(() => otherRow.getAttribute('data-cordis-status')).toBe('client-pending')
    await otherRow.locator('[data-cordis-switch="run"]').click()
    await expect.poll(() => otherRow.getAttribute('data-cordis-status')).toBe('running')
    expect((await inventory()).activeRun).toEqual(restarted)
    report.restartCreatedNewSharedRun = true
    mark('remove-synchronizes-both-pages')
    await otherRow.locator('[data-cordis-remove]').click()
    await focus(first); await row.waitFor({ state: 'detached' })
    await focus(second); await second.panel.locator(`[data-cordis-row="${receipt.pluginId}"]`).waitFor({ state: 'detached' })
    expect(await desktop('dynamicCordisRunner/inventory', {})).toEqual([])
    for (const client of [first, second]) {
      await focus(client)
      await client.panel.getByRole('button', { name: '返回聊天', exact: true }).click()
      await client.page.getByTestId('latest-race-echo').waitFor({ state: 'detached' })
      await client.page.screenshot({ path: resolve(output, client === first ? 'first.png' : 'second.png') })
      expect(client.report.pageErrors).toEqual([])
        if (lateCode && client === second && client.native) {
          expect(client.report.consoleErrors).toHaveLength(1 + (expectedFailureErrors.get(client)?.length ?? 0))
          expect(client.report.consoleErrors[0]).toMatch(/^\[cordis-client-runner\] Client activation .* failed: Error: gateway\/internal: client api: dynamicCordisRunner\/getClientCode failed: connection_closed_outcome_unknown\n/)
          expect(client.report.consoleErrors.slice(1)).toEqual(expectedFailureErrors.get(client) ?? [])
        } else expect(client.report.consoleErrors).toEqual(expectedFailureErrors.get(client) ?? [])
      client.report.errorsBeforeRevocation = { page: [...client.report.pageErrors], console: [...client.report.consoleErrors] }
    }
    report.removalSynced = true
    mark('revoke-both-test-devices')
    for (const client of [first, second]) {
      if (client.native) {
        await manage({ action: 'revoke', deviceId: client.claim.deviceId })
        await client.verifyRevoked()
        expect(client.report.pageErrors).toEqual([])
        const expected = client.report.errorsBeforeRevocation.console
        expect(client.report.consoleErrors.every((value: string) => value === '[Remote] http_401' || expected.includes(value))).toBe(true)
      } else {
        const revoked = once(client.socket, 'close'); await manage({ action: 'revoke', deviceId: client.claim.deviceId }); await revoked
        expect((await client.api('/v1/device/ticket', client.claim.token)).status).toBe(401)
      }
      expect((await manage()).devices.find((item: any) => item.id === client.claim.deviceId)?.status).toBe('revoked')
    }
    report.revokedReconnectDenied = true
    report.androidVerified = android && second.report.nativePairingAndTransport && second.report.nativeRevocationObserved
      && (!twoAndroid || (first.report.nativePairingAndTransport && first.report.nativeRevocationObserved))
    report.passed = true
    expect(stderr).not.toContain('disabling profile plugin row "dsh-mobile"')
  } catch (error) { report.failure = error instanceof Error ? error.message : 'race_verification_failed'; throw error }
  finally {
    for (let i = 0; i < pages.length; i++) {
      try { await pages[i].page.screenshot({ path: resolve(output, `final-${i + 1}.png`) }) }
      catch { /* 页面已结束时仍保留协议报告。 */ }
    }
    report.pages = pages.map(page => page.report)
    stopHost(child); report.stopped = await closed
    assert.throws(() => process.kill(child.pid!, 0), error => (error as NodeJS.ErrnoException).code === 'ESRCH')
    report.launcherStopped = true
    await cleanup(); report.transportCleanupCompleted = cleaned
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ output, passed: report.passed, stage: report.stage, androidVerified: report.androidVerified }))
  }
}, process.env.DSHM_LATEST_CORDIS_FAILURES === '1' || process.env.DSHM_LATEST_CORDIS_RENDER === '1' || process.env.DSHM_LATEST_CORDIS_FACTORY === '1' ? 240000 : 180000)
