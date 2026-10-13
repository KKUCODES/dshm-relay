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

test.skipIf(process.env.DSHM_LATEST_CHILD_DESCRIPTOR_ANDROID !== '1')('实际 Android 拒绝缺失、损坏与未知版本的子会话身份', async () => {
  const runtime = resolve('../plugin/artifacts/latest-runtime-check')
  const sourceMode = process.env.DSHM_LATEST_SOURCE_CHECK === '1', source = resolve('../plugin/artifacts/latest-source-check')
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  const home = await mkdtemp(resolve(runtime, 'relay-homes/latest-child-descriptor-'))
  await mkdir('.test-data', { recursive: true })
  const output = await mkdtemp(resolve('.test-data/latest-child-descriptor-'))
  const report: Record<string, any> = { passed: false, at: new Date().toISOString(), home, output,
    version: '0.2.1-alpha.1', executionMode: sourceMode ? 'source' : 'npm', inferenceVerified: false, stages: [], cases: [] }
  const mark = (stage: string) => { report.stage = stage; report.stages.push(stage); console.log(JSON.stringify({ stage, output })) }
  const pack = resolve(runtime, 'candidate-package-check-yr3WGO')
  const packageReport = JSON.parse(await readFile(resolve(pack, 'report.json'), 'utf8'))
  expect(packageReport.passed).toBe(true)
  const archive = resolve(pack, 'dsh-mobile-plugin-0.1.76-latest.0.tgz')
  expect(hash(await readFile(archive))).toBe(packageReport.package.sha256)
  const plugin = resolve(pack, 'consumer/node_modules/@dsh-mobile/plugin/dist/index.js')
  const installedPlugin = await readFile(plugin)
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
    { id: 'latest-child-descriptor-fixture', name: pathToFileURL(resolve('tests/support/latest-child-descriptor-fixture.mjs')).href },
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
  let stdout = '', stderr = '', client: any, gate: any, revoked = false, cleaned = false
  let manage: ((action?: unknown) => Promise<any>) | undefined
  child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', value => { stdout += value }); child.stderr!.on('data', value => { stderr += value })
  const cleanup = async () => {
    if (cleaned) return
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
    const desktop = async (method: string, args: unknown) => {
      const response = await fetch(new URL('/api/' + method, entry), { method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(15000) })
      expect(response.status).toBe(200); const frame = await response.json()
      expect(frame.result.ok).toBe(true); return frame.result.value
    }
    const title = 'Latest child descriptor validation'
    await manage({ action: 'setup', origin, name: title }); await manage({ action: 'enable' })
    await expect.poll(async () => (await manage!()).connection, { timeout: 15000 }).toBe('online')
    const project = resolve(home, 'test-project'); await mkdir(project)
    const workspace = await desktop('workspace/create', { request: { path: project } })
    const sessionId = 'latest-relay-' + randomUUID()
    await desktop('session/create', { request: { workspaceId: workspace.workspace.workspaceId, sessionId } })
    await desktop('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: 'LATEST_CORDIS_RACE_HISTORY' }] } })
    await expect.poll(async () => (await desktop('session/list', { _request: {} })).items.find((row: any) => row.sessionId === sessionId)?.running,
      { timeout: 15000 }).toBe(false)
    await desktop('session/rename', { request: { sessionId, title } })
    const probe = async (action: string) => {
      const id = randomUUID(); await writeFile(resolve(home, 'child-control.json'), JSON.stringify({ id, action, sessionId }))
      let receipt: any
      await expect.poll(async () => { try { receipt = JSON.parse(await readFile(resolve(home, 'child-receipt.json'), 'utf8')); return receipt.id } catch { return undefined } },
        { timeout: 45000 }).toBe(id)
      expect(receipt.error).toBeUndefined(); return receipt
    }
    mark('original-provider-and-isolated-session-faults')
    const seeded = await probe('seed'); report.seeded = seeded
    expect(seeded.children).toHaveLength(4)
    for (const row of seeded.children.slice(1)) expect(row.original.projections.values.subagent).toBeNull()
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
    const openCatalog = async () => {
      await main.getByRole('button', { name: 'Remote 选项', exact: true }).click()
      await page.getByRole('button', { name: '子会话', exact: true }).click()
      await page.getByRole('region', { name: '子会话列表', exact: true }).waitFor()
    }
    for (const row of seeded.children.slice(1)) {
      mark('native-' + row.kind + '-descriptor')
      await openCatalog()
      const group = page.getByRole('group', { name: row.label, exact: true })
      await group.getByRole('button').first().click()
      await main.getByRole('button', { name: '返回父会话', exact: true }).waitFor()
      await expect.poll(() => main.evaluate((element: any) => {
        const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'))!
        for (let fiber = element[key]; fiber; fiber = fiber.return) {
          const model = fiber.memoizedProps?.model
          if (model?.getSnapshot) {
            const error = model.getSnapshot().session?.openError
            return error && { code: error.code, message: error.message }
          }
        }
      }), { timeout: 15000 }).toEqual({ code: 'gateway/internal', message: 'subagent/catalog-diagnostic' })
      await main.getByRole('alert').filter({ hasText: '无法确认这个子会话的记录，请在电脑上检查。' }).waitFor()
      expect(await main.getByText('正在确认子会话类型，暂时只能查看记录。', { exact: true }).count()).toBe(0)
      expect(await main.getByText('探索未至之境', { exact: true }).count()).toBe(0)
      expect(await main.getByRole('button', { name: '发送消息', exact: true }).isDisabled()).toBe(true)
      expect(await main.getByRole('button', { name: '停止生成', exact: true }).count()).toBe(0)
      // 用当前页面持有的原 SDK 明确核验 Host 拒绝；不经伪造 socket 或替代响应。
      const native = await main.evaluate(async (element: any, data: any) => {
        const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'))!; let model
        for (let fiber = element[key]; fiber; fiber = fiber.return) if (fiber.memoizedProps?.model?.client) { model = fiber.memoizedProps.model; break }
        if (!model) throw Error('latest_child_model_missing')
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000)
        try {
          const page = await model.remote.session.page({ address: { kind: 'subagent', parentSessionId: data.parent,
            childSessionId: data.child, mode: 'unknown' }, throughSeq: data.seq, maxMessages: 60 }, controller.signal)
          const prompt = await model.remote.subagents.prompt({ parentSessionId: data.parent, childSessionId: data.child,
            mode: 'continuable', requestId: data.requestId, delivery: 'queue', content: [{ type: 'text', text: 'MUST_NOT_BE_ACCEPTED' }] }, controller.signal)
          return { page: page.ok ? { accepted: true } : { accepted: false, code: page.error.code },
            prompt: prompt.ok ? { accepted: true } : { accepted: false, code: prompt.error.code } }
        } finally { clearTimeout(timer) }
      }, { parent: sessionId, child: row.id, seq: row.original.projections.asOfSeq, requestId: randomUUID() })
      expect(native.page).toEqual({ accepted: false, code: 'subagent/catalog-diagnostic' })
      expect(native.prompt.accepted).toBe(false)
      expect(native.prompt.code).toBe(row.kind === 'malformed' ? 'gateway/internal' : 'subagent/not-resumable')
      await page.screenshot({ path: resolve(output, row.kind + '.png') })
      report.cases.push({ kind: row.kind, native, sendDisabled: true, stopAbsent: true })
      await main.getByRole('button', { name: '返回父会话', exact: true }).click()
      await main.getByText('LATEST_CORDIS_RACE_HISTORY', { exact: true }).waitFor()
    }
    for (const row of seeded.children.slice(1)) {
      mark('native-sidebar-' + row.kind + '-descriptor')
      await openCatalog()
      await page.getByRole('group', { name: row.label, exact: true }).getByRole('button', { name: '在旁栏打开', exact: true }).click()
      const panel = page.getByRole('region', { name: '插件面板', exact: true })
      const aside = panel.getByTestId('remote-sidebar-conversation').filter({ visible: true })
      await aside.getByRole('alert').filter({ hasText: '无法确认这个子会话的记录，请在电脑上检查。' }).waitFor()
      expect(await aside.getByText('正在确认子会话类型，暂时只能查看记录。', { exact: true }).count()).toBe(0)
      expect(await aside.getByText('探索未至之境', { exact: true }).count()).toBe(0)
      expect(await aside.getByRole('button', { name: '发送消息', exact: true }).isDisabled()).toBe(true)
      expect(await aside.getByRole('button', { name: '停止生成', exact: true }).count()).toBe(0)
      await page.screenshot({ path: resolve(output, 'sidebar-' + row.kind + '.png') })
      report.cases.find((item: any) => item.kind === row.kind).sidebar = { originalDiagnosticShown: true, sendDisabled: true, stopAbsent: true }
      await panel.getByRole('button', { name: '返回聊天', exact: true }).click()
      await main.getByText('LATEST_CORDIS_RACE_HISTORY', { exact: true }).waitFor()
    }
    mark('healthy-sibling-and-original-history-unchanged')
    await openCatalog(); await page.getByRole('group', { name: seeded.children[0].label, exact: true }).getByRole('button').first().click()
    await main.getByText('LATEST_CHILD_DESCRIPTOR_HEALTHY', { exact: true }).waitFor()
    await main.getByRole('button', { name: '返回父会话', exact: true }).click()
    await main.getByText('LATEST_CORDIS_RACE_HISTORY', { exact: true }).waitFor()
    const after = await probe('inspect'); expect(after.children).toEqual(seeded.children); expect(after.parent).toEqual(seeded.parent)
    report.originalLogsAndProjectionsUnchanged = true; report.healthySiblingReadable = true
    expect((await main.locator('[data-composer-input]').innerText()).trim()).toBe('')
    expect(await page.locator('iframe').count()).toBe(0); expect(gate.report.pageErrors).toEqual([])
    report.errorsBeforeRevocation = { page: [...gate.report.pageErrors], console: [...gate.report.consoleErrors] }
    await manage({ action: 'revoke', deviceId: client.claim.deviceId }); revoked = true
    await client.verifyRevoked(); report.revokedReconnectDenied = true; report.passed = true
  } catch (error) {
    report.failure = { name: (error as Error).name, message: (error as Error).message }
    if (client) await client.page.screenshot({ path: resolve(output, 'failed.png') }).catch(() => {})
    report.hostError = stderr.replace(/https?:\/\/\S+/g, '[URL]').slice(-2500)
    throw error
  } finally {
    await cleanup(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ output, passed: report.passed, stage: report.stage }))
  }
}, 240000)
