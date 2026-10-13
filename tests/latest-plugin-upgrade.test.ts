import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, onTestFinished, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { Store } from '../packages/gateway/src/store.js'
import { buildGateway } from '../packages/gateway/src/app.js'
import { pgliteDatabase } from './support/database.js'
import { latestHostCleanup } from './support/latest-host-cleanup.js'

// 独立的真实管理专项，不将缩短的管理测试冒充完整模型/文件组合。
test.skipIf(process.env.DSHM_LATEST_PLUGIN_INSTALL_CHECK !== '1')('新版 Android 安装、升级、Host 重启执行新版本和卸载', async () => {
  const startedAt = Date.now()
  const runtime = resolve('../plugin/artifacts/latest-runtime-check')
  const sourceMode = process.env.DSHM_LATEST_SOURCE_CHECK === '1'
  const cancellationMode = process.env.DSHM_LATEST_PLUGIN_CANCEL_CHECK === '1'
  const source = resolve('../plugin/artifacts/latest-source-check')
  if (sourceMode) await (await import(/* @vite-ignore */ pathToFileURL(resolve('../plugin/compatibility/latest-upstream/source-host.mjs')).href)).verifyInstalledSource()
  else for (const [file, method] of [
    ['pending-observer', 'prepareLatestPendingObserver'], ['foreground-observer', 'prepareLatestForegroundObserver'],
    ['client-entries', 'prepareLatestClientEntries'], ['cordis-scopes', 'prepareLatestCordisScopes'],
    ['cordis-client-lifetime', 'prepareLatestCordisClientLifetime'], ['preset-archive', 'prepareLatestPresetArchive'],
    ['model-discovery', 'prepareLatestModelDiscovery'], ['tool-cancellation', 'prepareLatestToolCancellation'],
    ['package-management', 'prepareLatestPackageProcess'], ['package-management', 'prepareLatestPluginRestartNotice'],
  ]) await (await import(/* @vite-ignore */ pathToFileURL(resolve('../plugin/compatibility/latest-upstream', file + '.mjs')).href))[method!]()
  const home = resolve(runtime, 'relay-homes', randomUUID())
  await mkdir(home, { recursive: true })
  const packageName = '@dsh-mobile/latest-upgrade-test'
  const tarballs: string[] = []
  for (const version of ['0.0.1', '0.0.2']) {
    const dir = resolve(home, 'fixtures', version, 'package')
    await mkdir(dir, { recursive: true })
    await writeFile(resolve(dir, 'package.json'), JSON.stringify({ name: packageName, version, type: 'module', exports: './index.mjs',
      peerDependencies: { '@deepseek-ai/dsh': '0.2.1-alpha.1' }, dsh: { bundle: { patch: './cordis.patch.json' } } }))
    await writeFile(resolve(dir, 'cordis.patch.json'), JSON.stringify([{ insert: [{ id: 'latest-upgrade-test', name: packageName }] }]))
    // 回执由实际被加载的包写出；不通过测试器替换 Host loader 或伪造运行版本。
    await writeFile(resolve(dir, 'index.mjs'), `import { writeFileSync, realpathSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const name = 'latest-upgrade-test';\nexport function apply() {\n const home = realpathSync(process.env.DSH_HOME);\n if (!home.replaceAll('\\\\', '/').includes('/latest-runtime-check/relay-homes/')) throw Error('isolated_home_required');\n writeFileSync(join(home, 'upgrade-receipt.json'), JSON.stringify({ version: '${version}', pid: process.pid }));\n}\n`)
    const tarball = resolve(home, `upgrade-${version}.tgz`)
    execFileSync('C:/Windows/system32/tar.exe', ['-czf', tarball, '-C', resolve(dir, '..'), 'package'], { cwd: home, windowsHide: true })
    tarballs.push(tarball)
  }
  const overlay = resolve(home, 'plugin.patch.json')
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'dsh-mobile', name: pathToFileURL(resolve(runtime, 'candidate/dist/index.js')).href }] }]))
  const db = new PGlite(), store = new Store(pgliteDatabase(db))
  await store.migrate()
  const gateway = await buildGateway({ store, publicOrigin: 'http://127.0.0.1:8787', registrationMode: 'open' })
  await gateway.listen({ host: '127.0.0.1', port: 0 })
  const address = gateway.server.address()
  if (!address || typeof address === 'string') throw Error('missing_port')
  const origin = `http://127.0.0.1:${address.port}`
  // 注册返回地址需与实际监听端口一致；由原网关配置使用显式端口。
  await gateway.close()
  const relay = await buildGateway({ store, publicOrigin: origin, registrationMode: 'open' })
  await relay.listen({ host: '127.0.0.1', port: address.port })
  const hosts = new Set<ChildProcess>(), stop = latestHostCleanup(hosts, true, runtime)
  const downloads = new Set<Socket>()
  let downloadStarted = false, downloadPort: number | undefined
  // 真正由 pnpm 下载本地 HTTP 归档；暂停传输以确定点击取消发生在下载中，不模拟管理服务。
  const archive = await readFile(tarballs[0]!)
  const download = createServer((request, response) => {
    if (request.url !== '/slow.tgz') { response.writeHead(404).end(); return }
    downloadStarted = true; downloadPort = request.socket.remotePort
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.length })
    response.write(archive.subarray(0, 32))
  })
  download.on('connection', socket => { downloads.add(socket); socket.once('close', () => downloads.delete(socket)) })
  let downloadOrigin: string | undefined
  if (cancellationMode) {
    await new Promise<void>(done => download.listen(0, '127.0.0.1', done))
    const bound = download.address(); if (!bound || typeof bound === 'string') throw Error('download_port_missing')
    downloadOrigin = `http://127.0.0.1:${bound.port}`
  }
  const env: NodeJS.ProcessEnv = { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMFILES'])
    if (process.env[key] !== undefined) env[key] = process.env[key]
  const report: Record<string, any> = { at: new Date().toISOString(), version: '0.2.1-alpha.1', executionMode: sourceMode ? 'source' : 'npm',
    command: sourceMode ? 'pnpm dsh web' : 'published CLI', home, passed: false }
  let current: ChildProcess, closed: Promise<unknown>, loginURL: string, cookie: string, deviceId: string | undefined
  const profile = resolve(home, 'profiles/web')
  const trackedFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
  let beforeCancellation: Array<Buffer | undefined> = [], cancelledPids: number[] = []
  const bytes = async (file: string) => { try { return await readFile(resolve(profile, file)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error } }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }
  const start = async () => {
    let output = '', errors = ''
    current = spawn(process.execPath, [...(sourceMode ? [resolve(source, 'node_modules/pnpm/bin/pnpm.cjs'), 'dsh', 'web']
      : [resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web']), '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open'],
      { cwd: sourceMode ? source : runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    hosts.add(current)
    closed = new Promise(done => current.once('close', (code, signal) => done({ code, signal })))
    current.stdout!.on('data', bytes => { output += bytes }); current.stderr!.on('data', bytes => { errors += bytes })
    await expect.poll(() => output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1], { timeout: 45000 }).toBeTruthy()
    loginURL = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)![1]!
    const response = await fetch(loginURL, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
    expect(response.status).toBe(303); cookie = response.headers.get('set-cookie')!.split(';')[0]!
    report.hostPids = [...hosts].map(host => host.pid)
  }
  const manage = async (action?: unknown) => {
    const response = await fetch(new URL('/api/dsh-mobile', loginURL), { method: action ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
      headers: { cookie, 'content-type': 'application/json' }, body: action ? JSON.stringify(action) : undefined })
    const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return value
  }
  const rpc = async (method: string, args: unknown) => {
    const rpcId = randomUUID()
    const response = await fetch(new URL('/api/' + method, loginURL), { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) })
    const frame = await response.json(); expect(frame.result.ok, JSON.stringify(frame.result)).toBe(true); return frame.result.value
  }
  const revoke = async () => {
    if (!deviceId) return
    await manage({ action: 'management', deviceId, enabled: false })
    await manage({ action: 'revoke', deviceId })
    report.authorization = (await manage()).devices.find((row: { id: string }) => row.id === deviceId)
    expect(report.authorization.management).toBe(false)
    expect(report.authorization.status).toBe('revoked')
    deviceId = undefined
  }
  onTestFinished(async () => {
    for (const host of hosts) stop(host)
    if (closed) await closed
    const adb = process.env.DSHM_ADB_PATH!, serial = process.env.DSHM_ANDROID_SERIAL!
    execFileSync(adb, ['-s', serial, 'shell', 'am', 'force-stop', 'dev.dshmobile.validation.latesttest'], { cwd: runtime, windowsHide: true })
    const mappings = execFileSync(adb, ['-s', serial, 'reverse', '--list'], { cwd: runtime, windowsHide: true, encoding: 'utf8' })
    if (mappings.includes(`tcp:${address.port}`)) execFileSync(adb, ['-s', serial, 'reverse', '--remove', `tcp:${address.port}`], { cwd: runtime, windowsHide: true })
    await relay.close(); await db.close()
    for (const socket of downloads) socket.destroy()
    if (download.listening) await new Promise<void>((done, fail) => download.close(error => error ? fail(error) : done()))
    report.elapsedMs = Date.now() - startedAt
    report.cleanupCompleted = true
    await writeFile(resolve(runtime, cancellationMode ? (sourceMode ? 'latest-source-plugin-cancellation.json' : 'latest-plugin-cancellation.json') : (sourceMode ? 'latest-source-plugin-upgrade.json' : 'latest-plugin-upgrade.json')), JSON.stringify(report, null, 2) + '\n')
  })
  try {
    await start()
    await manage({ action: 'setup', origin, name: 'Latest package upgrade isolated Host' })
    await manage({ action: 'enable' })
    await expect.poll(async () => (await manage()).connection, { timeout: 10000 }).toBe('online')
    const workspacePath = resolve(home, 'test-project'); await mkdir(workspacePath)
    const workspace = await rpc('workspace/create', { request: { path: workspacePath } })
    const sessionId = randomUUID(), title = 'Latest package upgrade isolated test'
    await rpc('session/create', { request: { workspaceId: workspace.workspace.workspaceId, sessionId } })
    await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: 'Isolated plugin management verification; no model credential configured.' }] } })
    await expect.poll(async () => (await rpc('session/list', { _request: {} })).items.find((row: { sessionId: string }) => row.sessionId === sessionId)?.running).toBe(false)
    await rpc('session/rename', { request: { sessionId, title } })
    report.inferenceVerified = false
    const pairing = await manage({ action: 'pair' })
    const { verifyLatestPluginUpgradeAndroid } = await import(/* @vite-ignore */ pathToFileURL(resolve('../dsh-mobile/tests/support/latest-plugin-upgrade-android.mjs')).href)
    report.android = await verifyLatestPluginUpgradeAndroid({ origin, pairLink: pairing.link, title, packageName, tarballs,
      cancellation: cancellationMode ? {
        url: downloadOrigin + '/slow.tgz',
        before: async () => { beforeCancellation = await Promise.all(trackedFiles.map(bytes)) },
        started: async () => {
          await expect.poll(() => downloadStarted, { timeout: 45000 }).toBe(true)
          const tree = JSON.parse(await readFile(resolve(profile, '.plugin-manager/run.json'), 'utf8'))
          expect(Number.isSafeInteger(tree.pid)).toBe(true)
          // socket 的本地源端口对应实际下载 Node；同时核对原 run.json 记录的 pnpm 启动进程。
          const endpoint = new URL(downloadOrigin!)
          const rows = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { cwd: runtime, windowsHide: true, encoding: 'utf8' })
            .split(/\r?\n/).map(row => row.trim().split(/\s+/))
          const owner = rows.find(row => row[0] === 'TCP' && row[1] === `127.0.0.1:${downloadPort}` && row[2] === `127.0.0.1:${endpoint.port}`)
          expect(owner).toBeTruthy()
          cancelledPids = [...new Set([tree.pid, Number(owner![4])])]
          expect(cancelledPids.every(pid => Number.isSafeInteger(pid) && pid > 0 && alive(pid))).toBe(true)
          report.cancellationProcesses = cancelledPids
        },
        settled: async () => {
          await expect.poll(() => cancelledPids.every(pid => !alive(pid)), { timeout: 15000 }).toBe(true)
          await expect.poll(() => downloads.size, { timeout: 15000 }).toBe(0)
          expect(await bytes('.plugin-manager/run.json')).toBeUndefined()
          expect(await Promise.all(trackedFiles.map(bytes))).toEqual(beforeCancellation)
          const manifest = JSON.parse((await bytes('package.json'))!.toString())
          expect(manifest.dependencies?.[packageName]).toBeUndefined()
          expect(manifest.dsh.profile.bundles).not.toContain(packageName)
          report.downloadCancellation = { processesGoneBeforeCleanup: true, socketClosed: true, originalFilesRestored: true, notSelected: true }
        },
      } : undefined,
      approve: async (fingerprint: string) => {
        let device: { id: string } | undefined
        await expect.poll(async () => { device = (await manage()).devices.find((row: { fingerprint: string; status: string }) => row.fingerprint === fingerprint && row.status === 'pending'); return device }).toBeTruthy()
        deviceId = device!.id
        await manage({ action: 'approve', deviceId }); await manage({ action: 'management', deviceId, enabled: true })
      },
      receipt: async (version: string) => {
        let value: { version: string; pid: number } | undefined
        await expect.poll(async () => { try { value = JSON.parse(await readFile(resolve(home, 'upgrade-receipt.json'), 'utf8')); return value?.version } catch { return null } }, { timeout: 15000 }).toBe(version)
        return value
      },
      restart: async () => { stop(current); await closed; await start(); await expect.poll(async () => (await manage()).connection, { timeout: 15000 }).toBe('online') },
      verifyRemoved: async () => {
        await expect.poll(async () => JSON.parse(await readFile(resolve(home, 'profiles/web/package.json'), 'utf8')).dependencies?.[packageName], { timeout: 30000 }).toBeUndefined()
        const manifest = JSON.parse(await readFile(resolve(home, 'profiles/web/package.json'), 'utf8'))
        expect(manifest.dependencies?.[packageName]).toBeUndefined(); expect(manifest.dsh.profile.bundles).not.toContain(packageName)
      }, revoke,
    })
    report.passed = true
  } catch (error) {
    report.error = String(error)
    // 保存本次隔离 pnpm 的原始诊断，避免短暂 Toast 消失后只剩等待超时。
    const logs = resolve(profile, '.plugin-manager/logs')
    const diagnosticLogs: Record<string, string> = {}
    for (const dir of await readdir(logs, { withFileTypes: true }).catch(() => [])) {
      if (!dir.isDirectory()) continue
      diagnosticLogs[dir.name] = await readFile(resolve(logs, dir.name, 'pnpm.log'), 'utf8').catch(() => '')
    }
    report.packageDiagnostics = diagnosticLogs
    throw error
  }
  finally { await revoke(); for (const host of hosts) stop(host) }
}, 240000)
