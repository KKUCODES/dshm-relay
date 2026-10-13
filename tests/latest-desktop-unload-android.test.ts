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
import { latestDesktopProbe } from './support/latest-desktop-inflight.js'

// 真实手机专项；只使用已校验的测试 UID、独立 home 和原服务，不准备主运行器。
test.skipIf(process.env.DSHM_LATEST_DESKTOP_UNLOAD_ANDROID !== '1')('电脑应用服务停用后手机在途准备与确认失效', async () => {
  const runtime = resolve('../plugin/artifacts/latest-runtime-check')
  const source = resolve('../plugin/artifacts/latest-source-check')
  const sourceMode = process.env.DSHM_LATEST_SOURCE_CHECK === '1'
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const home = await mkdtemp(resolve(runtime, 'relay-homes/latest-desktop-unload-'))
  await mkdir('.test-data', { recursive: true })
  const output = await mkdtemp(resolve('.test-data/latest-desktop-unload-'))
  const report: Record<string, any> = { at: new Date().toISOString(), passed: false, home, output,
    version: '0.2.1-alpha.1', executionMode: sourceMode ? 'source' : 'npm',
    command: sourceMode ? 'pnpm dsh web' : 'published CLI', inferenceVerified: false, stages: [] }
  const mark = (stage: string) => { report.stage = stage; report.stages.push(stage); console.log('Desktop unload Android: ' + stage) }
  const pack = resolve(runtime, 'candidate-package-check-yr3WGO')
  const packageReport = JSON.parse(await readFile(resolve(pack, 'report.json'), 'utf8'))
  expect(packageReport.passed).toBe(true)
  const archivePath = resolve(pack, 'dsh-mobile-plugin-0.1.76-latest.0.tgz')
  expect(hash(await readFile(archivePath))).toBe(packageReport.package.sha256)
  const plugin = resolve(pack, 'consumer/node_modules/@dsh-mobile/plugin/dist/index.js')
  expect(await readFile(plugin)).toEqual(execFileSync('tar', ['-xOf', archivePath, 'package/dist/index.js'],
    { cwd: pack, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }))
  report.archiveSha256 = packageReport.package.sha256
  const installed: { path: string; sha256: string }[] = []
  let verifySource: (() => Promise<any>) | undefined
  if (sourceMode) {
    const { verifyInstalledSource } = await import(/* @vite-ignore */ pathToFileURL(resolve('../plugin/compatibility/latest-upstream/source-host.mjs')).href)
    verifySource = verifyInstalledSource
    report.sourceEvidence = await verifySource!()
  } else {
    // 只消费已安装的固定载荷；另插命令行副本会覆盖原管理器的停用操作。
    const prepared = resolve(runtime, 'desktop-apps')
    const manifest = JSON.parse(await readFile(resolve(prepared, 'manifest.json'), 'utf8'))
    expect(manifest.version).toBe('0.2.1-alpha.1'); expect(manifest.files).toHaveLength(5)
    const original = resolve(runtime, 'node_modules/@deepseek-ai/dsh-host-open-in-app')
    for (const file of manifest.files) {
      const path = resolve(original, file.path), originalHash = hash(await readFile(path))
      expect(originalHash).toBe(file.after)
      installed.push({ path, sha256: originalHash })
      const payload = await readFile(resolve(prepared, file.payload)); expect(hash(payload)).toBe(file.after)
      expect(await readFile(path)).toEqual(payload)
    }
    report.desktopCandidate = { sha256: manifest.files[0].after, installed }
  }
  const overlay = resolve(home, 'plugin.patch.json')
  await writeFile(overlay, JSON.stringify([{ insert: [
    { id: 'dsh-mobile', name: pathToFileURL(plugin).href },
    { id: 'latest-desktop-fixture', name: pathToFileURL(resolve('tests/support/latest-desktop-host-fixture.mjs')).href },
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
  let stdout = '', stderr = '', client: any, gate: any, disabled = false, serviceId: string | undefined
  let desktop: ((method: string, args: unknown) => Promise<any>) | undefined
  let manage: ((action?: unknown) => Promise<any>) | undefined
  let probe: ReturnType<typeof latestDesktopProbe> | undefined
  let revoked = false, cleaned = false
  child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', value => { stdout += value }); child.stderr!.on('data', value => { stderr += value })
  const cleanup = async () => {
    if (cleaned) return
    if (probe && child.exitCode === null && child.signalCode === null) {
      const observed = await probe.control('status')
      if (observed.hold?.entered && !observed.hold.released) await probe.control('release')
      if (disabled && serviceId && desktop) await desktop('pluginManager/setPluginEnabled', { id: serviceId, enabled: true })
    }
    if (!revoked && client?.claim && manage && child.exitCode === null && child.signalCode === null) {
      await manage({ action: 'revoke', deviceId: client.claim.deviceId }); revoked = true
    }
    await client?.close(); gate?.close()
    stopHost(child); await closed
    await gateway.close(); await db.close()
    for (const file of installed) expect(hash(await readFile(file.path))).toBe(file.sha256)
    if (verifySource) {
      expect(await verifySource()).toEqual(report.sourceEvidence)
      report.installedSourcePayloadUnchanged = true
    } else report.installedDesktopRuntimeUnchanged = true
    report.launcherStopped = true
    cleaned = true; report.transportCleanupCompleted = true
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
    await manage({ action: 'setup', origin, name: 'Latest desktop service unload' }); await manage({ action: 'enable' })
    await expect.poll(async () => (await manage!()).connection, { timeout: 15000 }).toBe('online')
    const project = resolve(home, 'test-project'); await mkdir(project)
    const registered = await desktop('workspace/create', { request: { path: project } })
    const sessionId = 'latest-relay-' + randomUUID(), title = 'Latest desktop service unload'
    await desktop('session/create', { request: { workspaceId: registered.workspace.workspaceId, sessionId } })
    await desktop('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: 'LATEST_CORDIS_RACE_HISTORY' }] } })
    await expect.poll(async () => (await desktop!('session/list', { _request: {} })).items.find((row: any) => row.sessionId === sessionId)?.running,
      { timeout: 15000 }).toBe(false)
    await desktop('session/rename', { request: { sessionId, title } })
    const rows = await desktop('pluginManager/listPlugins', {})
    const services = rows.filter((row: any) => row.moduleName === '@deepseek-ai/dsh-host-open-in-app')
    expect(services).toHaveLength(1); expect(services[0].readOnlyReason).toBeUndefined(); serviceId = services[0].entryId
    report.originalDesktopEntry = services[0]
    probe = latestDesktopProbe(home, sessionId)
    expect((await probe.control('status')).servicePresent).toBe(true)
    const { createLatestNativeGate } = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/support/latest-cordis-native-gate.mjs')).href)
    const { createLatestRaceAndroid } = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/support/latest-cordis-race-android.mjs')).href)
    gate = createLatestNativeGate(gateway.websocketServer, { singleConnection: true })
    const pairing = await manage({ action: 'pair' })
    mark('native-pairing')
    client = await createLatestRaceAndroid({ origin, pairLink: pairing.link, title, gate, name: title,
      approve: async (fingerprint: string) => {
        let device: any
        await expect.poll(async () => { device = (await manage!()).devices.find((row: any) => row.fingerprint === fingerprint); return device?.status },
          { timeout: 15000 }).toBe('pending')
        expect(device.name).toBe(title); await manage!({ action: 'approve', deviceId: device.id })
        expect((await manage!()).devices.find((row: any) => row.id === device.id)).toMatchObject({ status: 'active', management: false })
        return { deviceId: device.id, fingerprint }
      } })
    report.native = gate.report; report.androidVerified = true
    const page = client.page, dialog = page.getByRole('dialog', { name: '在电脑应用中打开', exact: true })
    await page.getByRole('button', { name: 'Remote 选项', exact: true }).click()
    await page.getByRole('button', { name: '在电脑应用中打开', exact: true }).click()
    const explorer = dialog.getByRole('button', { name: '文件资源管理器', exact: true })
    await explorer.waitFor(); await explorer.locator('img').evaluate(async (node: HTMLImageElement) => { await node.decode() })
    for (const phase of ['prepare', 'open'] as const) {
      mark('original-' + phase + '-inflight-service-disable')
      if (phase === 'open') {
        await explorer.click(); await dialog.getByRole('button', { name: '确认在电脑打开', exact: true }).waitFor()
        expect(await dialog.locator('.remote-file-path').innerText()).toBe(project)
      }
      const baseline = await probe.control('arm')
      await dialog.getByRole('button', { name: phase === 'prepare' ? '文件资源管理器' : '确认在电脑打开', exact: true }).click()
      await probe.wait(value => value.hold?.entered === true)
      expect(await desktop('pluginManager/setPluginEnabled', { id: serviceId, enabled: false })).toMatchObject({ application: 'applied', enabled: false })
      disabled = true; await probe.wait(value => !value.servicePresent && value.hold?.serviceReleased === true)
      await probe.control('release'); const settled = await probe.wait(value => value.hold?.settled === true)
      expect(settled.openCalls).toBe(baseline.openCalls)
      await dialog.getByText('当前聊天或确认信息已变化，请重新选择应用。', { exact: true }).waitFor()
      expect(await dialog.getByRole('button', { name: '确认在电脑打开', exact: true }).count()).toBe(0)
      expect(await dialog.getByText('正在处理…', { exact: true }).count()).toBe(0)
      expect(await dialog.getByText('已向电脑发送打开请求。', { exact: true }).count()).toBe(0)
      await page.screenshot({ path: resolve(output, phase + '-service-disabled.png') })
      report[phase] = { originalServiceDisabled: true, heldOriginalResult: true, noLauncherInvocation: true,
        confirmationCleared: true, busyCleared: true, originalStaleCauseShown: true }
      expect(await desktop('pluginManager/setPluginEnabled', { id: serviceId, enabled: true })).toMatchObject({ application: 'applied', enabled: true })
      disabled = false; await probe.wait(value => value.servicePresent)
      await dialog.getByRole('button', { name: '重新读取', exact: true }).click(); await explorer.waitFor()
    }
    mark('service-reenabled-native-read-and-prepare')
    await explorer.click(); await dialog.getByRole('button', { name: '确认在电脑打开', exact: true }).waitFor()
    expect(await dialog.locator('.remote-file-path').innerText()).toBe(project)
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await explorer.waitFor()
    expect((await probe.control('status')).openCalls).toBe(0)
    report.serviceRecovered = true; report.noActualLaunchCalls = true
    await dialog.getByRole('button', { name: '关闭窗口', exact: true }).click()
    expect((await page.locator('[data-composer-input]').innerText()).trim()).toBe('')
    expect(gate.report.pageErrors).toEqual([]); expect(gate.report.consoleErrors).toEqual([])
    report.errorsBeforeRevocation = { page: [...gate.report.pageErrors], console: [...gate.report.consoleErrors] }
    await manage({ action: 'revoke', deviceId: client.claim.deviceId }); revoked = true
    await client.verifyRevoked(); report.revokedReconnectDenied = true
    report.passed = true
  } catch (error) {
    report.failure = { name: (error as Error).name, message: (error as Error).message }
    if (probe && child.exitCode === null && child.signalCode === null) report.failureObservation = await probe.control('status')
    if (client) await client.page.screenshot({ path: resolve(output, 'failed.png') }).catch(() => {})
    report.hostError = stderr.replace(/https?:\/\/\S+/g, '[URL]').slice(-1500)
    throw error
  } finally {
    await cleanup(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ output, passed: report.passed, stage: report.stage, androidVerified: report.androidVerified }))
  }
}, 180000)
