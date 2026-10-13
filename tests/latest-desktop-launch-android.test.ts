import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, onTestFinished, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { buildGateway } from '../packages/gateway/src/app.js'
import { Store } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'
import { latestHostCleanup } from './support/latest-host-cleanup.js'

// Windows 窗口由 computer-use 在现场核对/关闭，回执不能替代原手机确认和启动请求。
test.skipIf(process.env.DSHM_LATEST_DESKTOP_LAUNCH_ANDROID !== '1')('手机实际打开电脑编辑器的专用工作区', async () => {
  const runtime = resolve('../plugin/artifacts/latest-runtime-check')
  const source = resolve('../plugin/artifacts/latest-source-check')
  const sourceMode = process.env.DSHM_LATEST_SOURCE_CHECK === '1'
  const requestedApps = (process.env.DSHM_LATEST_DESKTOP_LAUNCH_APPS ?? 'cursor,vscode,intellij').split(',')
  assert.ok(requestedApps.length > 0 && new Set(requestedApps).size === requestedApps.length)
  assert.ok(requestedApps.every(app => ['cursor', 'vscode', 'intellij'].includes(app)))
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const home = await mkdtemp(resolve(runtime, 'relay-homes/latest-desktop-launch-'))
  await mkdir('.test-data', { recursive: true })
  const output = await mkdtemp(resolve('.test-data/latest-desktop-launch-'))
  const project = resolve(home, `DSHM-open-${sourceMode ? 'source' : 'npm'}-${randomUUID().slice(0, 8)}`)
  const report: Record<string, any> = { at: new Date().toISOString(), passed: false, home, output, project,
    version: '0.2.1-alpha.1', executionMode: sourceMode ? 'source' : 'npm',
    command: sourceMode ? 'pnpm dsh web' : 'published CLI', inferenceVerified: false,
    requestedApps, allThreeEditorsVerified: false, stages: [], apps: [] }
  const mark = (stage: string) => { report.stage = stage; report.stages.push(stage); console.log(JSON.stringify({ stage, output, project })) }
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
    verifySource = verifyInstalledSource; report.sourceEvidence = await verifySource!()
  } else {
    const prepared = resolve(runtime, 'desktop-apps')
    const manifest = JSON.parse(await readFile(resolve(prepared, 'manifest.json'), 'utf8'))
    expect(manifest.version).toBe('0.2.1-alpha.1'); expect(manifest.files).toHaveLength(5)
    const original = resolve(runtime, 'node_modules/@deepseek-ai/dsh-host-open-in-app')
    for (const file of manifest.files) {
      const path = resolve(original, file.path), originalHash = hash(await readFile(path))
      expect(originalHash).toBe(file.after); installed.push({ path, sha256: originalHash })
      const payload = await readFile(resolve(prepared, file.payload)); expect(hash(payload)).toBe(file.after)
      expect(await readFile(path)).toEqual(payload)
    }
    report.desktopCandidate = { sha256: manifest.files[0].after, installed }
  }
  const overlay = resolve(home, 'plugin.patch.json')
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'dsh-mobile', name: pathToFileURL(plugin).href }] }]))
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
  let stdout = '', stderr = '', client: any, gate: any
  let manage: ((action?: unknown) => Promise<any>) | undefined
  let revoked = false, cleaned = false
  child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', value => { stdout += value }); child.stderr!.on('data', value => { stderr += value })
  const cleanup = async () => {
    if (cleaned) return
    if (!revoked && client?.claim && manage && child.exitCode === null && child.signalCode === null) {
      await manage({ action: 'revoke', deviceId: client.claim.deviceId }); revoked = true
    }
    await client?.close(); gate?.close(); stopHost(child); await closed
    await gateway.close(); await db.close()
    for (const file of installed) expect(hash(await readFile(file.path))).toBe(file.sha256)
    if (verifySource) { expect(await verifySource()).toEqual(report.sourceEvidence); report.installedSourcePayloadUnchanged = true }
    else report.installedDesktopRuntimeUnchanged = true
    report.launcherStopped = true; cleaned = true; report.transportCleanupCompleted = true
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
    const desktop = async (method: string, args: unknown) => {
      const response = await fetch(new URL('/api/' + method, entry), { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(15000) })
      expect(response.status).toBe(200); const frame = await response.json(); expect(frame.result.ok).toBe(true); return frame.result.value
    }
    await manage({ action: 'setup', origin, name: 'Latest desktop editor launch' }); await manage({ action: 'enable' })
    await expect.poll(async () => (await manage!()).connection, { timeout: 15000 }).toBe('online')
    await mkdir(project); await writeFile(resolve(project, 'README.md'), '# DSHM desktop launcher validation\n')
    const registered = await desktop('workspace/create', { request: { path: project } })
    const sessionId = 'latest-relay-' + randomUUID(), title = 'Latest desktop editor launch'
    await desktop('session/create', { request: { workspaceId: registered.workspace.workspaceId, sessionId } })
    await desktop('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'LATEST_CORDIS_RACE_HISTORY' }] } })
    await expect.poll(async () => (await desktop('session/list', { _request: {} })).items.find((row: any) => row.sessionId === sessionId)?.running,
      { timeout: 15000 }).toBe(false)
    await desktop('session/rename', { request: { sessionId, title } })
    const { createLatestNativeGate } = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/support/latest-cordis-native-gate.mjs')).href)
    const { createLatestRaceAndroid } = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/support/latest-cordis-race-android.mjs')).href)
    gate = createLatestNativeGate(gateway.websocketServer, { singleConnection: true })
    const pairing = await manage({ action: 'pair' }); mark('native-pairing')
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
    const labels = { cursor: 'Cursor', vscode: 'VS Code', intellij: 'IntelliJ IDEA' }
    for (const appId of requestedApps as (keyof typeof labels)[]) {
      const button = dialog.getByRole('button', { name: labels[appId], exact: true })
      await button.waitFor(); await button.locator('img').evaluate(async (node: HTMLImageElement) => { await node.decode() })
      await button.click(); await dialog.getByRole('button', { name: '确认在电脑打开', exact: true }).waitFor()
      expect(await dialog.locator('.remote-file-path').innerText()).toBe(project)
      await page.screenshot({ path: resolve(output, appId + '-confirmation.png') })
      await dialog.getByRole('button', { name: '确认在电脑打开', exact: true }).click()
      await dialog.getByText('已向电脑发送打开请求。', { exact: true }).waitFor()
      const token = randomUUID(), control = { token, appId, project, projectName: basename(project), stage: 'observe-and-close-owned-window' }
      await writeFile(resolve(output, 'window-control.json'), JSON.stringify(control, null, 2)); mark('windows-' + appId)
      let proof: any
      await expect.poll(async () => {
        try { proof = JSON.parse(await readFile(resolve(output, 'windows-' + appId + '.json'), 'utf8')); return proof?.token }
        catch { return undefined }
      }, { timeout: 180000 }).toBe(token)
      report.lastWindowObservation = proof
      expect(proof).toMatchObject({ token, appId, project, opened: true, closed: true, computerUseVerified: true })
      expect(proof.window.title).toContain(basename(project)); expect(proof.window.id).toBeGreaterThan(0)
      expect(proof.screenshotId).toBeTruthy(); expect(proof.window.app).toMatch(/Cursor\.exe|Code\.exe|idea64\.exe/i)
      report.apps.push(proof)
      await client.focus(); await page.screenshot({ path: resolve(output, appId + '-opened-native.png') })
      await dialog.getByRole('button', { name: '重新读取', exact: true }).click()
    }
    await dialog.getByRole('button', { name: '关闭窗口', exact: true }).click()
    expect((await page.locator('[data-composer-input]').innerText()).trim()).toBe('')
    expect(gate.report.pageErrors).toEqual([]); expect(gate.report.consoleErrors).toEqual([])
    report.errorsBeforeRevocation = { page: [...gate.report.pageErrors], console: [...gate.report.consoleErrors] }
    await manage({ action: 'revoke', deviceId: client.claim.deviceId }); revoked = true
    await client.verifyRevoked(); report.revokedReconnectDenied = true
    report.allThreeEditorsVerified = report.apps.length === 3
    report.passed = true
  } catch (error) {
    report.failure = { name: (error as Error).name, message: (error as Error).message }
    if (client) await client.page.screenshot({ path: resolve(output, 'failed.png') }).catch(() => {})
    report.hostError = stderr.replace(/https?:\/\/\S+/g, '[URL]').slice(-1500); throw error
  } finally {
    await cleanup(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ output, passed: report.passed, stage: report.stage, androidVerified: report.androidVerified }))
  }
}, 600000)
