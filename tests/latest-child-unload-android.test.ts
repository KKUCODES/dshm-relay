import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, onTestFinished, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { buildGateway } from '../packages/gateway/src/app.js'
import { Store } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'
import { latestHostCleanup } from './support/latest-host-cleanup.js'

test.skipIf(process.env.DSHM_LATEST_CHILD_UNLOAD_ANDROID !== '1')('实际 Android 的子会话服务在途卸载与原历史恢复', async () => {
  const runtime = resolve('../plugin/artifacts/latest-runtime-check')
  const sourceMode = process.env.DSHM_LATEST_SOURCE_CHECK === '1', source = resolve('../plugin/artifacts/latest-source-check')
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  const home = await mkdtemp(resolve(runtime, 'relay-homes/latest-child-unload-'))
  await mkdir('.test-data', { recursive: true })
  const output = await mkdtemp(resolve('.test-data/latest-child-unload-'))
  const report: Record<string, any> = { passed: false, at: new Date().toISOString(), home, output,
    version: '0.2.1-alpha.1', executionMode: sourceMode ? 'source' : 'npm', inferenceVerified: false, stages: [], cases: [] }
  const mark = (stage: string) => { report.stage = stage; report.stages.push(stage); console.log(JSON.stringify({ stage, output })) }
  const packName = process.env.DSHM_LATEST_CHILD_UNLOAD_PACKAGE ?? 'candidate-package-check-yr3WGO'
  assert.match(packName, /^candidate-package-check-[A-Za-z0-9]+$/)
  const pack = resolve(runtime, packName)
  const packageReport = JSON.parse(await readFile(resolve(pack, 'report.json'), 'utf8'))
  expect(packageReport.passed).toBe(true)
  const archive = resolve(pack, 'dsh-mobile-plugin-0.1.76-latest.0.tgz')
  expect(hash(await readFile(archive))).toBe(packageReport.package.sha256)
  const plugin = resolve(pack, 'consumer/node_modules/@dsh-mobile/plugin/dist/index.js'), installedPlugin = await readFile(plugin)
  expect(installedPlugin).toEqual(execFileSync('tar', ['-xOf', archive, 'package/dist/index.js'],
    { cwd: pack, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }))
  report.archiveSha256 = packageReport.package.sha256
  let verifySource: (() => Promise<any>) | undefined
  if (sourceMode) {
    const module = await import(/* @vite-ignore */ pathToFileURL(resolve('../plugin/compatibility/latest-upstream/source-host.mjs')).href)
    verifySource = module.verifyInstalledSource; report.sourceEvidence = await verifySource!()
  }
  const overlay = resolve(home, 'plugin.patch.json')
  await writeFile(overlay, JSON.stringify([{ insert: [
    { id: 'dsh-mobile', name: pathToFileURL(plugin).href },
    { id: 'latest-child-unload-fixture', name: pathToFileURL(resolve('tests/support/latest-child-unload-fixture.mjs')).href },
  ] }]))
  const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const address = reservation.address(); assert.ok(address && typeof address !== 'string')
  await new Promise<void>(done => reservation.close(() => done()))
  const origin = `http://127.0.0.1:${address.port}`
  const db = new PGlite(), store = new Store(pgliteDatabase(db)); await store.migrate()
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
  hosts.add(child); report.launcherPid = child.pid; const closed = once(child, 'close')
  let stdout = '', stderr = '', client: any, gate: any, revoked = false, cleaned = false, disabled = false, serviceId: string
  let providerIds: string[] = []
  let manage: ((action?: unknown) => Promise<any>) | undefined
  let desktop: ((method: string, args: unknown) => Promise<any>) | undefined
  let control: ((action: string) => Promise<any>) | undefined
  child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', value => { stdout += value }); child.stderr!.on('data', value => { stderr += value })
  const cleanup = async () => {
    if (cleaned) return
    if (control && child.exitCode === null && child.signalCode === null) {
      const observed = await control('status')
      if (observed.observation?.hold?.entered && !observed.observation.hold.released) await control('release')
      if (disabled && serviceId && desktop) {
        await desktop('pluginManager/setPluginEnabled', { id: serviceId, enabled: true })
        for (const id of providerIds) await desktop('pluginManager/setPluginEnabled', { id, enabled: true })
      }
    }
    if (!revoked && client?.claim && manage && child.exitCode === null && child.signalCode === null) {
      await manage({ action: 'revoke', deviceId: client.claim.deviceId }); revoked = true
    }
    await client?.close(); gate?.close(); stopHost(child); await closed
    await gateway.close(); await db.close()
    expect(await readFile(plugin)).toEqual(installedPlugin)
    if (verifySource) { expect(await verifySource()).toEqual(report.sourceEvidence); report.installedSourcePayloadUnchanged = true }
    report.launcherStopped = true; report.transportCleanupCompleted = true; cleaned = true
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
  }
  onTestFinished(cleanup)
  try {
    mark('host-start')
    const pattern = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/
    await expect.poll(() => stdout.match(pattern)?.[1], { timeout: 45000 }).toBeTruthy()
    const entry = stdout.match(pattern)![1]!
    const login = await fetch(entry, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
    expect(login.status).toBe(303); const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    manage = async action => {
      const response = await fetch(new URL('/api/dsh-mobile', entry), { method: action ? 'POST' : 'GET',
        headers: { cookie, 'content-type': 'application/json' }, body: action ? JSON.stringify(action) : undefined,
        signal: AbortSignal.timeout(15000) })
      expect(response.status).toBe(200); return response.json()
    }
    desktop = async (method, args) => {
      const response = await fetch(new URL('/api/' + method, entry), { method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(15000) })
      expect(response.status).toBe(200); const frame = await response.json()
      expect(frame.result.ok).toBe(true); return frame.result.value
    }
    const title = 'Latest child service unload', sessionId = 'latest-relay-' + randomUUID()
    await manage({ action: 'setup', origin, name: title }); await manage({ action: 'enable' })
    await expect.poll(async () => (await manage!()).connection, { timeout: 15000 }).toBe('online')
    const project = resolve(home, 'test-project'); await mkdir(project)
    const workspace = await desktop('workspace/create', { request: { path: project } })
    await desktop('session/create', { request: { workspaceId: workspace.workspace.workspaceId, sessionId } })
    await desktop('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: 'LATEST_CORDIS_RACE_HISTORY' }] } })
    await expect.poll(async () => (await desktop!('session/list', { _request: {} })).items.find((row: any) => row.sessionId === sessionId)?.running,
      { timeout: 15000 }).toBe(false)
    await desktop('session/rename', { request: { sessionId, title } })
    const plugins = await desktop('pluginManager/listPlugins', {})
    const rows = plugins.filter((row: any) => row.moduleName === '@deepseek-ai/dsh-subagent')
    expect(rows).toHaveLength(1); expect(rows[0].readOnlyReason).toBeUndefined(); serviceId = rows[0].entryId
    report.originalSubagentEntry = rows[0]
    for (const name of ['@deepseek-ai/dsh-subagent-spawn-in-process', '@deepseek-ai/dsh-subagent-fork-in-process']) {
      const found = plugins.filter((row: any) => row.moduleName === name)
      expect(found).toHaveLength(1); expect(found[0].readOnlyReason).toBeUndefined(); expect(found[0].enabled).toBe(true)
      providerIds.push(found[0].entryId)
    }
    report.originalProviderEntries = plugins.filter((row: any) => providerIds.includes(row.entryId))
    control = async action => {
      const id = randomUUID(); await writeFile(resolve(home, 'child-control.json'), JSON.stringify({ id, action, sessionId }))
      let receipt: any
      await expect.poll(async () => { try { receipt = JSON.parse(await readFile(resolve(home, 'child-receipt.json'), 'utf8')); return receipt.id } catch { return undefined } },
        { timeout: 45000 }).toBe(id)
      expect(receipt.error).toBeUndefined(); return receipt
    }
    const observe = async (predicate: (value: any) => boolean) => {
      let receipt: any
      await expect.poll(async () => { receipt = await control!('status'); return predicate(receipt.observation) }, { timeout: 15000 }).toBe(true)
      return receipt.observation
    }
    mark('original-continuable-child')
    const seeded = await control('seed'); report.seeded = seeded
    const { createLatestNativeGate } = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/support/latest-cordis-native-gate.mjs')).href)
    const { createLatestRaceAndroid } = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/support/latest-cordis-race-android.mjs')).href)
    gate = createLatestNativeGate(gateway.websocketServer, { singleConnection: true })
    client = await createLatestRaceAndroid({ origin, pairLink: (await manage({ action: 'pair' })).link, title, gate, name: title,
      approve: async (fingerprint: string) => {
        let device: any
        await expect.poll(async () => { device = (await manage!()).devices.find((row: any) => row.fingerprint === fingerprint); return device?.status },
          { timeout: 15000 }).toBe('pending')
        expect(device.name).toBe(title); await manage!({ action: 'approve', deviceId: device.id })
        expect((await manage!()).devices.find((row: any) => row.id === device.id)).toMatchObject({ status: 'active', management: false })
        return { deviceId: device.id, fingerprint }
      } })
    report.native = gate.report; report.androidVerified = true
    const page = client.page, main = page.getByTestId('remote-workspace')
    const openChild = async (sidebar: boolean) => {
      await main.getByRole('button', { name: 'Remote 选项', exact: true }).click()
      await page.getByRole('button', { name: '子会话', exact: true }).click()
      const group = page.getByRole('group', { name: seeded.label, exact: true })
      await (sidebar ? group.getByRole('button', { name: '在旁栏打开', exact: true }) : group.getByRole('button').first()).click()
      return sidebar ? page.getByTestId('remote-sidebar-conversation').filter({ visible: true }) : main
    }
    const back = async (sidebar: boolean, view: any) => {
      if (sidebar) await page.getByRole('region', { name: '插件面板', exact: true }).getByRole('button', { name: '返回聊天', exact: true }).click()
      else await view.getByRole('button', { name: '返回父会话', exact: true }).click()
      await main.getByText('LATEST_CORDIS_RACE_HISTORY', { exact: true }).waitFor()
    }
    const snapshot = (view: any) => view.evaluate((element: any) => {
      const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'))!
      for (let fiber = element[key]; fiber; fiber = fiber.return) {
        const model = fiber.memoizedProps?.model
        if (model?.getSnapshot && model.remote) {
          const state = model.getSnapshot(), id = state.selected
          return { selected: id, target: state.selectedTarget, openState: state.session?.openState,
            openError: state.session?.openError && { code: state.session.openError.code, message: state.session.openError.message },
            connectionState: state.connectionState, draft: state.drafts[id], running: state.session?.running,
            sending: model.sending?.has(id), parentAvailable: state.session?.subagent?.parentAvailable,
            subagentServiceAvailable: state.subagentServiceAvailable,
            originalNamespacePresent: model.ctx.get('remote.subagents') !== undefined }
        }
      }
      throw Error('latest_child_model_missing')
    })
    for (const sidebar of [false, true]) for (const phase of ['read', 'submit']) {
      mark((sidebar ? 'sidebar-' : 'main-') + phase + '-service-unload')
      let view: any
      if (phase === 'submit') {
        view = await openChild(sidebar); await view.getByText('LATEST_CHILD_UNLOAD_HISTORY', { exact: false }).waitFor()
        // 旁栏可以保留已打开标签；重新读取必须由真实按钮发起，不能命中缓存冒充在途请求。
        await control('arm-submit')
        await view.locator('[data-composer-input]').fill('MUST_NOT_BE_ACCEPTED_' + randomUUID())
        await view.getByRole('button', { name: '发送消息', exact: true }).click()
      } else {
        await control('arm-read'); view = await openChild(sidebar)
      }
      await observe(value => value.hold?.entered === true)
      disabled = true
      // 原管理器将依赖缺失的 pending 条目算作失败；先按原依赖顺序停用两个 provider。
      for (const id of providerIds) expect(await desktop('pluginManager/setPluginEnabled', { id, enabled: false })).toMatchObject({ application: 'applied', enabled: false })
      const operation = await desktop('pluginManager/setPluginEnabled', { id: serviceId, enabled: false })
      report.serviceDisableResult = operation
      expect(operation).toMatchObject({ application: 'applied', enabled: false })
      const unloaded = await observe(value => !value.servicePresent && value.hold?.serviceReleased === true)
      await control('release')
      const settled = await observe(value => value.hold?.settled === true)
      const after = await snapshot(view)
      report.cases.push({ entry: sidebar ? 'sidebar' : 'main', phase, unloaded, settled, after })
      await expect.poll(async () => (await snapshot(view)).subagentServiceAvailable, { timeout: 15000 }).toBe(false)
      await expect.poll(async () => { const value = await snapshot(view); return value.openState !== 'opening' && value.sending !== true },
        { timeout: 20000 }).toBe(true)
      await expect.poll(() => view.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), { timeout: 15000 }).toBe(true)
      expect(await view.getByRole('button', { name: '停止生成', exact: true }).count()).toBe(0)
      if (phase === 'read') expect((await snapshot(view)).openError).toBeTruthy()
      else {
        expect(settled.hold.result).toBeTruthy()
        expect(settled.hold.result.accepted === false || settled.hold.result.thrown === true).toBe(true)
        expect((await view.locator('[data-composer-input]').innerText()).trim()).toMatch(/^MUST_NOT_BE_ACCEPTED_/)
      }
      await page.screenshot({ path: resolve(output, (sidebar ? 'sidebar-' : 'main-') + phase + '-disabled.png') })
      expect(await desktop('pluginManager/setPluginEnabled', { id: serviceId, enabled: true })).toMatchObject({ application: 'applied', enabled: true })
      for (const id of providerIds) expect(await desktop('pluginManager/setPluginEnabled', { id, enabled: true })).toMatchObject({ application: 'applied', enabled: true })
      disabled = false; await observe(value => value.servicePresent && value.serviceGeneration > unloaded.serviceGeneration)
      await back(sidebar, view)
      view = await openChild(sidebar)
      if ((await snapshot(view)).openError) await view.getByRole('button', { name: '重试读取', exact: true }).click()
      await view.getByText('LATEST_CHILD_UNLOAD_HISTORY', { exact: false }).waitFor()
      await expect.poll(async () => (await snapshot(view)).openState, { timeout: 15000 }).toBe('open')
      await expect.poll(async () => (await snapshot(view)).subagentServiceAvailable, { timeout: 15000 }).toBe(true)
      await view.locator('[data-composer-input]').fill('')
      await back(sidebar, view)
    }
    mark('original-history-and-cleanup')
    const after = await control('inspect'); expect(after.original).toEqual(seeded.original); expect(after.parent).toEqual(seeded.parent)
    report.originalLogsAndProjectionsUnchanged = true
    expect((await main.locator('[data-composer-input]').innerText()).trim()).toBe('')
    expect(await page.locator('iframe').count()).toBe(0); expect(gate.report.pageErrors).toEqual([])
    report.errorsBeforeRevocation = { page: [...gate.report.pageErrors], console: [...gate.report.consoleErrors] }
    await manage({ action: 'revoke', deviceId: client.claim.deviceId }); revoked = true
    await client.verifyRevoked(); report.revokedReconnectDenied = true; report.passed = true
  } catch (error) {
    report.failure = { name: (error as Error).name, message: (error as Error).message }
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
    if (control && child.exitCode === null && child.signalCode === null) report.failureObservation = await control('status')
    if (client) await client.page.screenshot({ path: resolve(output, 'failed.png') }).catch(() => {})
    report.hostError = stderr.replace(/https?:\/\/\S+/g, '[URL]').slice(-2500)
    throw error
  } finally {
    await cleanup(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ output, passed: report.passed, stage: report.stage }))
  }
}, 240000)
