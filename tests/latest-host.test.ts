import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, writeFile, readFile, unlink, stat, utimes } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, onTestFinished, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import WebSocket from 'ws'
import { calculateJwkThumbprint } from 'jose'
import { clientFrameSchema, MAX_OFFICE_PDF_BYTES, RESOURCE_CHUNK_BYTES, officeMetadataSchema } from '@dsh-mobile/protocol'
import { buildGateway } from '../packages/gateway/src/app.js'
import { Store } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'
import { clientKey, proof } from './support/proof.js'
import { latestModelListing } from './support/latest-model-listing.js'
import { verifyLatestOfficeAttachments } from './support/latest-office-attachments.js'
import { verifyLatestOfficeTransmission } from './support/latest-office-transmission.js'
import { latestOfficeMobileCancellation, type OfficeCancellationPhase } from './support/latest-office-mobile-cancellation.js'
import { latestOfficeSocketDrop } from './support/latest-office-socket-drop.js'
import { latestOfficeSession } from './support/latest-office-session.js'
import { latestOfficeEngine, type OfficeEnginePhase } from './support/latest-office-engine.js'
import { latestFileTransfer, type FileTransferPhase } from './support/latest-file-transfer.js'
import { latestHostCleanup } from './support/latest-host-cleanup.js'
import { latestExplorerObservation } from './support/latest-explorer-observation.js'
import { verifyLatestDesktopConnection } from './support/latest-desktop-connection.js'
import { latestDesktopProbe, verifyLatestDesktopInFlight } from './support/latest-desktop-inflight.js'

// 固定新版的不同入口共用同一套验收；不使用日常 DSH 或网关的数据。
test('新版真实 Host 经真实网关配对、协商、读取及取消实时订阅，并在撤销后拒绝重连', async () => {
  const { latestFinalScope, latestRemoteAndroidPackage } = await import(/* @vite-ignore */ pathToFileURL(resolve('../dsh-mobile/scripts/latest-final-test-scope.mjs')).href)
  const finalScope = latestFinalScope()
  const androidPackageName = process.env.DSHM_LATEST_ANDROID_CHECK === '1' ? latestRemoteAndroidPackage() : undefined
  const testStartedAt = Date.now()
  const officeLifetime = process.env.DSHM_LATEST_OFFICE_LIFETIME_CHECK === '1'
  const officeMetadata = process.env.DSHM_LATEST_OFFICE_METADATA_CHECK === '1'
  if (officeMetadata && (!officeLifetime || ['DSHM_LATEST_OFFICE_ENGINE_CHECK', 'DSHM_LATEST_FILE_TRANSFERS_CHECK',
    'DSHM_LATEST_OFFICE_CANCEL_CHECK'].some(key => process.env[key] === '1'))) throw Error('office_metadata_requires_separate_android_scope')
  const officeEngine = process.env.DSHM_LATEST_OFFICE_ENGINE_CHECK === '1'
  const officeEngineShared = process.env.DSHM_LATEST_OFFICE_ENGINE_SHARED_CHECK === '1'
  const officeEngineJoinedCancel = process.env.DSHM_LATEST_OFFICE_ENGINE_JOINED_CANCEL_CHECK === '1'
  const officeEngineNetworkDrop = process.env.DSHM_LATEST_OFFICE_ENGINE_NETWORK_CHECK === '1'
  const officeEngineLifecycle = process.env.DSHM_LATEST_OFFICE_ENGINE_LIFECYCLE_CHECK === '1'
  if (officeEngineNetworkDrop && (!officeEngine || officeEngineShared)) throw Error('office_engine_network_requires_separate_single_reader_scope')
  if (officeEngineJoinedCancel && !officeEngineShared) throw Error('office_engine_joined_cancel_requires_shared_engine')
  if (officeEngineShared && !officeEngine) throw Error('office_engine_shared_requires_engine')
  if (officeEngine && !officeLifetime) throw Error('office_engine_requires_isolated_office_android')
  const officeCancellation = process.env.DSHM_LATEST_OFFICE_CANCEL_CHECK === '1'
  const officeRecovery = process.env.DSHM_LATEST_OFFICE_RECOVERY_CHECK === '1'
  const officeAuthority = process.env.DSHM_LATEST_OFFICE_AUTHORITY_CHECK === '1'
  const officeSession = process.env.DSHM_LATEST_OFFICE_SESSION_CHECK === '1'
  const fileTransfers = process.env.DSHM_LATEST_FILE_TRANSFERS_CHECK === '1'
  if (officeEngineNetworkDrop && (officeCancellation || fileTransfers)) throw Error('office_engine_network_requires_separate_single_reader_scope')
  if (officeEngineLifecycle && (!officeEngine || officeEngineJoinedCancel || officeEngineNetworkDrop || officeCancellation || fileTransfers))
    throw Error('office_engine_lifecycle_requires_separate_scope')
  const fileFormats = process.env.DSHM_LATEST_FILE_FORMATS_CHECK === '1'
  const fileFormatGroup = process.env.DSHM_LATEST_FILE_FORMATS_GROUP
  if (fileFormats && !['word-and-xlsx', 'xls-and-slides'].includes(fileFormatGroup ?? '')) throw Error('file_formats_requires_explicit_group')
  if (fileFormats && (!fileTransfers || officeEngine || ['DSHM_LATEST_FILE_PICKER_CHECK', 'DSHM_LATEST_FILE_WRITE_DEATH_CHECK',
    'DSHM_LATEST_FILE_SHARE_DEATH_CHECK'].some(key => process.env[key] === '1'))) throw Error('file_formats_requires_separate_file_transfer_scope')
  if (process.env.DSHM_LATEST_FILE_PICKER_CHECK === '1' && !fileTransfers) throw Error('file_picker_requires_file_transfer')
  if (process.env.DSHM_LATEST_FILE_WRITE_DEATH_CHECK === '1' && (!fileTransfers || process.env.DSHM_LATEST_FILE_PICKER_CHECK === '1'))
    throw Error('file_write_death_requires_separate_file_transfer_scope')
  if (process.env.DSHM_LATEST_FILE_SHARE_DEATH_CHECK === '1' && (!fileTransfers || process.env.DSHM_LATEST_FILE_PICKER_CHECK === '1'
    || process.env.DSHM_LATEST_FILE_WRITE_DEATH_CHECK === '1')) throw Error('file_share_death_requires_separate_file_transfer_scope')
  if (fileTransfers && !officeLifetime) throw Error('file_transfers_requires_isolated_office_android')
  if (process.env.DSHM_LATEST_OFFICE_FILE_PERMISSION_UI_CHECK === '1' && (!officeRecovery || !process.env.DSHM_PWSH_PATH))
    throw Error('office_file_permission_ui_requires_recovery_and_inspected_pwsh')
  if (process.env.DSHM_LATEST_OFFICE_FILE_PERMISSION_CHECK === '1'
    && (process.env.DSHM_LATEST_OFFICE_TRANSMISSION_CHECK !== '1' || !process.env.DSHM_PWSH_PATH))
    throw Error('office_file_permission_requires_transmission_and_inspected_pwsh')
  if (process.env.DSHM_LATEST_OFFICE_SESSION_INFLIGHT_CHECK === '1' && !officeSession)
    throw Error('office_session_inflight_requires_office_session')
  if (process.env.DSHM_LATEST_OFFICE_SIDEBAR_INFLIGHT_CHECK === '1'
    && process.env.DSHM_LATEST_OFFICE_SESSION_INFLIGHT_CHECK !== '1')
    throw Error('office_sidebar_inflight_requires_office_session_inflight')
  if (officeSession && !officeRecovery) throw Error('office_session_requires_office_recovery')
  if (officeAuthority && !officeRecovery) throw Error('office_authority_requires_office_recovery')
  if (officeRecovery && !officeCancellation) throw Error('office_recovery_requires_office_cancel')
  if (officeCancellation && !officeLifetime) throw Error('office_cancel_requires_office_lifetime')
  if (officeLifetime && (process.env.DSHM_LATEST_ANDROID_CHECK !== '1' || process.env.DSHM_LATEST_OFFICE_CHECK !== '1'))
    throw Error('office_lifetime_requires_android_and_office')
  const runtime = resolve('../plugin/artifacts/latest-runtime-check')
  const sourceMode = process.env.DSHM_LATEST_SOURCE_CHECK === '1'
  const sdkMode = process.env.DSHM_LATEST_SDK_CHECK === '1'
  const electronMode = process.env.DSHM_LATEST_ELECTRON_CHECK === '1'
  if (sdkMode && finalScope?.mode !== 'sdk') throw Error('sdk_requires_explicit_final_android_scope')
  if (electronMode && finalScope?.mode !== 'electron') throw Error('electron_requires_explicit_final_android_scope')
  const sdk = sdkMode ? await (await import(/* @vite-ignore */ pathToFileURL(resolve('scripts/latest-sdk-carrier.mjs')).href))
    .readLatestSdkCarrier(runtime) : undefined
  const executionMode = electronMode ? 'electron' : sdk ? 'sdk-sea' : sourceMode ? 'source' : 'npm'
  const deliveryRun = process.env.DSHM_LATEST_DELIVERY_RUN
  if (deliveryRun && (!sourceMode || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deliveryRun)
    || process.env.DSHM_LATEST_ANDROID_CHECK === '1' || officeEngine || fileFormats))
    throw Error('source_delivery_requires_separate_source_protocol_scope')
  const source = resolve('../plugin/artifacts/latest-source-check')
  if (sourceMode || electronMode) {
    const { verifyInstalledSource } = await import(/* @vite-ignore */ pathToFileURL(resolve('../plugin/compatibility/latest-upstream/source-host.mjs')).href)
    await verifyInstalledSource()
  } else if (!sdk) for (const [name, prepare] of [['file-version-watch', 'prepareLatestFileVersionWatch'], ['pending-observer', 'prepareLatestPendingObserver'],
    ['foreground-observer', 'prepareLatestForegroundObserver'], ['client-entries', 'prepareLatestClientEntries'],
    ['cordis-scopes', 'prepareLatestCordisScopes'], ['cordis-client-lifetime', 'prepareLatestCordisClientLifetime'], ['preset-archive', 'prepareLatestPresetArchive'],
    ['model-discovery', 'prepareLatestModelDiscovery'], ['tool-cancellation', 'prepareLatestToolCancellation'],
    ['package-management', 'prepareLatestPackageProcess'], ['package-management', 'prepareLatestPluginRestartNotice']] as const) {
    const patch = await import(/* @vite-ignore */ pathToFileURL(resolve('../plugin/compatibility/latest-upstream', name + '.mjs')).href)
    await patch[prepare]()
  }
  if (!sourceMode && !sdk && !electronMode) {
    const desktop = await import(/* @vite-ignore */ pathToFileURL(resolve('../plugin/compatibility/latest-upstream/desktop-apps.mjs')).href)
    await desktop.prepareLatestDesktopApps()
    await desktop.installLatestDesktopApps('apply')
  }
  const home = resolve(runtime, 'relay-homes', electronMode ? finalScope.run : randomUUID())
  if (electronMode) await mkdir(home)
  else await mkdir(home, { recursive: true })
  let candidateEntry = resolve(runtime, 'candidate/dist/index.js')
  let reviewedPackage: { path: string; sha256: string; files: number } | undefined
  if (officeEngine || fileFormats || deliveryRun || finalScope) {
    const review = resolve(runtime, 'candidate-package-check-1xqe3A')
    const pack = JSON.parse(await readFile(resolve(review, 'report.json'), 'utf8'))
    const integrity = JSON.parse(await readFile(resolve(review, 'source-integrity-recheck.json'), 'utf8'))
    expect(pack.passed).toBe(true); expect(pack.targetVersion).toBe('0.2.1-alpha.1')
    expect(integrity.passed).toBe(true); expect(integrity.currentSourcesIdentical).toBe(true)
    reviewedPackage = pack.package
    expect(createHash('sha256').update(await readFile(pack.package.path)).digest('hex')).toBe(pack.package.sha256)
    for (const source of integrity.sourceFiles)
      expect(createHash('sha256').update(await readFile(resolve('../plugin/src', source.path))).digest('hex')).toBe(source.sha256)
    candidateEntry = resolve(review, 'consumer/node_modules/@dsh-mobile/plugin/dist/index.js')
    expect(await readFile(candidateEntry)).toEqual(await readFile(resolve(review, 'package/dist/index.js')))
  }
  const overlay = resolve(home, 'plugin.patch.json')
  await writeFile(overlay, JSON.stringify([{ insert: [
    { id: 'dsh-mobile', name: pathToFileURL(candidateEntry).href },
    { id: 'latest-cordis-fixture', name: pathToFileURL(resolve('tests/support/latest-cordis-host-fixture.mjs')).href },
    ...(officeEngine ? [{ id: 'latest-office-engine-observer', name: pathToFileURL(resolve('tests/support/latest-office-engine-observer.mjs')).href }] : []),
    ...(process.env.DSHM_LATEST_DESKTOP_RACE_CHECK === '1'
      ? [{ id: 'latest-desktop-fixture', name: pathToFileURL(resolve('tests/support/latest-desktop-host-fixture.mjs')).href }] : []),
    { id: 'latest-preset-fault-source', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'fault-source', name: 'Isolated rollback fixture',
      plugins: [{ id: 'fault-leaf', name: pathToFileURL(resolve('tests/support/latest-preset-failure-fixture.mjs')).href }] } },
  ] }]))
  const electronPreparation = electronMode ? await import(/* @vite-ignore */ pathToFileURL(resolve('../plugin/scripts/prepare-latest-electron-project.mjs')).href) : undefined
  const electron = electronPreparation ? await electronPreparation.prepareLatestElectronProject(runtime,home,
    {finalRun:finalScope.run,overlay}) : undefined
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string') throw Error('missing_port')
  await new Promise<void>(done => reservation.close(() => done()))
  const origin = `http://127.0.0.1:${address.port}`
  const db = new PGlite(), store = new Store(pgliteDatabase(db))
  await store.migrate()
  const gateway = await buildGateway({ store, publicOrigin: origin, registrationMode: 'open' })
  await gateway.listen({ host: '127.0.0.1', port: address.port })
  const env: NodeJS.ProcessEnv = { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMFILES'])
    if (process.env[key] !== undefined) env[key] = process.env[key]
  if (electron) Object.assign(env,{DSH_DESKTOP_DSH_DIR:electron.project,DSH_DESKTOP_PRIMARY_RUNTIME_DIR:electron.primary,
    DSH_DESKTOP_OPEN_DEVTOOLS:'0',DSH_DESKTOP_DIAGNOSTIC_FILE:resolve(electron.directory,'private-startup-error.txt'),
    DSHM_LATEST_FINAL_RUN:finalScope.run})
  if (officeEngine) {
    env.TEMP = env.TMP = resolve(home, 'office-engine-tmp')
    await mkdir(env.TEMP, { recursive: true })
  }
  const ownedHosts = new Set<ChildProcess>()
  const ownedDesktopHostPids = new Set<number>()
  let electronRestartProfile: unknown
  const stopHost = latestHostCleanup(ownedHosts, sourceMode || officeEngine || fileFormats || !!finalScope, source)
  const launchHost = async (patch?: string) => {
    if (electron && !patch) electronRestartProfile = await electronPreparation!.prepareLatestFinalElectronRestart(electron)
    const host = spawn(electron?.executable ?? sdk?.executable ?? process.execPath, electron ? [
      `--inspect=127.0.0.1:${electron.mainPort}`,`--remote-debugging-port=${electron.rendererPort}`,
      `--user-data-dir=${electron.userData}`,electron.app,
    ] : [
    ...(sdk ? ['web'] : sourceMode ? [resolve(source, 'node_modules/pnpm/bin/pnpm.cjs'), 'dsh', 'web']
      : [resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web']),
    ...(patch ? ['--patch', patch] : []), '--host', '127.0.0.1', '--port', '0', '--no-open',
    ], { cwd: electron?.app ?? sdk?.root ?? (sourceMode ? source : runtime), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    ownedHosts.add(host)
    return host
  }
  const reportName = finalScope?.reportName ?? (officeMetadata ? (sourceMode ? 'latest-source-office-metadata-' : 'latest-office-metadata-') + randomUUID()
    : deliveryRun ? 'latest-source-delivery-' + deliveryRun : officeEngine ? (sourceMode ? 'latest-source-office-engine-' : 'latest-office-engine-') + randomUUID()
    : fileFormats ? (sourceMode ? 'latest-source-file-formats-' : 'latest-file-formats-') + randomUUID() : (sourceMode ? 'latest-source-relay' : 'latest-relay'))
  const child = await launchHost(overlay)
  const stopped = new Promise((done, fail) => { child.once('close', (code, signal) => done({ code, signal })); child.once('error', fail) })
  let stdout = '', stderr = '', socket: WebSocket | undefined
  let officeEngineControl: ReturnType<typeof latestOfficeEngine> | undefined
  // Vitest的测试时限先于异步函数finally生效；结束钩子仍必须回收本次资源。
  onTestFinished(async () => {
    socket?.terminate()
    for (const host of ownedHosts) stopHost(host)
    for (const pid of ownedDesktopHostPids) await expect.poll(() => {
      try { process.kill(pid,0); return false }
      catch(error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error }
    }).toBe(true)
    if (process.env.DSHM_LATEST_ANDROID_CHECK === '1') {
      const adb = process.env.DSHM_ADB_PATH!, serial = process.env.DSHM_ANDROID_SERIAL!
      const packageName = androidPackageName!
      execFileSync(adb, ['-s', serial, 'shell', 'am', 'force-stop', packageName], { cwd: runtime, windowsHide: true, stdio: 'ignore' })
      const mappings = execFileSync(adb, ['-s', serial, 'reverse', '--list'], { cwd: runtime, windowsHide: true, encoding: 'utf8' })
      if (mappings.split('\n').some(row => row.trim().split(/\s+/)[1] === `tcp:${address.port}`))
        execFileSync(adb, ['-s', serial, 'reverse', '--remove', `tcp:${address.port}`], { cwd: runtime, windowsHide: true, stdio: 'ignore' })
    }
    await writeFile(resolve(runtime, reportName + '-cleanup.json'), JSON.stringify({ at: new Date().toISOString(),
      executionMode, ownedHostPids: [...ownedHosts].map(host => host.pid),
      ...(electron ? {ownedDesktopHostPids:[...ownedDesktopHostPids]} : {}),
      cleanupCompleted: true }, null, 2) + '\n')
  })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
  const report: Record<string, unknown> = { at: new Date().toISOString(), version: '0.2.1-alpha.1', pid: child.pid,
    executionMode, command: electron ? 'official Electron desktop main' : sdk ? 'SDK executable web' : sourceMode ? 'pnpm dsh web' : 'published CLI',
    ...(sdk ? { sdkCarrier: sdk } : {}),
    ...(electron ? {electronCarrier:electron} : {}),
    ...(officeMetadata || officeEngine || fileFormats || deliveryRun || finalScope ? { reportName, home, reviewedPackage } : {}),
    ...(finalScope ? { finalAndroidRun: finalScope.run, packageName: finalScope.packageName } : {}),
    ...(deliveryRun ? { deliveryRun } : {}),
    ...(fileFormats ? { fileFormatGroup } : {}) }
  const stages: { stage: string; elapsedMs: number }[] = []
  let explorer: Awaited<ReturnType<typeof latestExplorerObservation>> | undefined
  onTestFinished(async () => { await explorer?.close() })
  const markStage = async (stage: string) => {
    stages.push({ stage, elapsedMs: Date.now() - testStartedAt })
    report.stages = stages
    // 单独保留阶段时间；外层测试超时也能定位，不记录凭据、响应或登录链接。
    await writeFile(resolve(runtime, reportName + '-progress.json'), JSON.stringify({ version: report.version, executionMode: report.executionMode, pid: child.pid, stages }, null, 2) + '\n')
  }
  await markStage('host-starting')
  const listing = await latestModelListing()
  const verifyElectronIdentity = async (output: () => string, host: ChildProcess) => {
    if (!electron) return undefined
    await expect.poll(() => output().match(/dshm electron identity: (\{[^\n]+\})/)?.[1], {timeout:45000}).toBeTruthy()
    const identity = JSON.parse(output().match(/dshm electron identity: (\{[^\n]+\})/)![1]!)
    expect(identity.home).toBe(home); expect(identity.parentPid).toBe(host.pid); expect(identity.electron).toBe('44.0.0')
    expect(Number.isSafeInteger(identity.hostPid) && identity.hostPid > 0).toBe(true)
    expect(identity.hostPid).not.toBe(host.pid); process.kill(identity.hostPid,0)
    expect(JSON.parse(await readFile(resolve(electron.directory,`host-identity-${identity.hostPid}.json`),'utf8'))).toEqual(identity)
    ownedDesktopHostPids.add(identity.hostPid)
    return identity
  }
  try {
    await expect.poll(() => stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1], { timeout: 45000 }).toBeTruthy()
    if (electron) report.electronIdentity = await verifyElectronIdentity(() => stdout,child)
    const loginURL = stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)![1]!
    const login = await fetch(loginURL, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
    expect(login.status).toBe(303)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const manage = async (action?: unknown) => {
      const response = await fetch(new URL('/api/dsh-mobile', loginURL), { method: action ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
        headers: { cookie, 'content-type': 'application/json' }, body: action ? JSON.stringify(action) : undefined })
      const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return value
    }
    const desktopRpc = async (method: string, args: unknown) => {
      const rpcId = randomUUID()
      const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
      const freshFileRead = officeEngineShared && officeEngineLifecycle && method === 'workspaceFiles/stat'
      let response: Response
      try {
        response = await fetch(new URL('/api/' + method, loginURL), { method: 'POST', signal: AbortSignal.timeout(15000),
          headers: { cookie, 'content-type': 'application/json', ...(freshFileRead ? { connection: 'close' } : {}) }, body })
      } catch (error) {
        const cause = (error as Error & { cause?: NodeJS.ErrnoException }).cause
        let hostAlive = true
        try { process.kill(child.pid!, 0) } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe
          hostAlive = false
        }
        const diagnostic = { method, code: cause?.code, hostAlive, exitCode: child.exitCode,
          signalCode: child.signalCode, freshFileRead }
        ;((report.rpcTransportFailures ??= []) as typeof diagnostic[]).push(diagnostic)
        throw error
      }
      expect(response.status).toBe(200)
      const frame = await response.json(); expect(frame.rpcId).toBe(rpcId); expect(frame.result.ok, JSON.stringify(frame.result)).toBe(true)
      return frame.result.value
    }
    expect(await manage({ action: 'setup', origin, name: 'Isolated latest Host' })).toEqual({ configured: true })
    await manage({ action: 'enable' })
    await expect.poll(async () => (await manage()).connection, { timeout: 10000 }).toBe('online')
    const pairing = await manage({ action: 'pair' })
    const key = new URLSearchParams(new URL(pairing.link).hash.slice(1)).get('key')
    const identity = await clientKey()
    const api = async (path: string, token?: string, body?: unknown) => fetch(origin + path, { method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), dpop: await proof(identity, origin + path, 'POST', token), ...(token ? { authorization: 'DPoP ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) })
    const claimed = await api('/v1/pairings/claim', undefined, { key, name: 'Isolated latest relay client' })
    expect(claimed.status).toBe(201)
    const claim = await claimed.json()
    expect((await api('/v1/device/ticket', claim.token)).status).toBe(403)
    await manage({ action: 'approve', deviceId: claim.deviceId })
    const ticketResponse = await api('/v1/device/ticket', claim.token)
    expect(ticketResponse.status).toBe(200)
    const { ticket } = await ticketResponse.json()
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/v1/device/socket')
    const frames: Record<string, any>[] = []
    socket.on('message', raw => frames.push(JSON.parse(raw.toString())))
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'authenticate', ticket }))
    const receive = async (match: (frame: Record<string, any>) => boolean, timeout = 10000) => {
      await expect.poll(() => frames.some(match), { timeout }).toBe(true)
      return frames.splice(frames.findIndex(match), 1)[0]!
    }
    expect(await receive(frame => frame.type === 'ready')).toMatchObject({ hostOnline: true, protocol: 1 })
    const request = (operation: unknown) => {
      const id = randomUUID()
      // 与真实手机相同的严格协议；夹具拼错字段时立即报错，避免误判为电脑写入超时。
      const frame = clientFrameSchema.parse({ type: 'request', id, operation })
      socket!.send(JSON.stringify(frame)); return id
    }
    const result = async (operation: unknown, timeout = 10000) => { const id = request(operation); return receive(frame => frame.id === id, timeout) }
    const negotiation = await result({ method: 'remote.negotiate', version: 2 })
    expect(negotiation).toMatchObject({ type: 'result', value: { dshVersion: '0.2.1-alpha.1', management: false, jobOutput: true, jobOutputCoordinates: 'ring' } })
    expect(negotiation.value.commandOutputGeneration).toEqual(expect.any(String))
    expect(negotiation.value.endpoints.calls).toContain('session/projections')
    expect(negotiation.value.endpoints.calls).not.toContain('subagents/list')
    expect(negotiation.value.endpoints.streams).toContain('job/list')
    expect(await result({ method: 'remote.rpc', endpoint: 'session/projections', payload: { args: { request: { sessionId: 'x', cwd: '/' } } } }))
      .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
    expect(negotiation.value.presetProfileDirectory).toBe(true)
    expect(negotiation.value.presetProfileManagement).toBe(true)
    expect(negotiation.value.codingToolsSettings).toBe(true)
    expect(negotiation.value.providerModelProbe).toBe(true)
    expect(await result({ method: 'remote.codingToolsRead' })).toMatchObject({ type: 'result', value: { enabled: true, documentId: expect.any(String) } })
    expect(await result({ method: 'remote.settingsRead', namespace: 'ui-settings' })).toMatchObject({ type: 'error', code: 'management_required' })
    expect(negotiation.value.endpoints.calls).toContain('dynamicCordisRunner/syncInspectManifest')
    const list = await result({ method: 'remote.rpc', endpoint: 'session/list', payload: { args: { _request: {} } } })
    expect(list, JSON.stringify(list)).toMatchObject({ type: 'result', value: { ok: true, value: { items: [] } } })
    const jobRosterStream = request({ method: 'remote.stream', endpoint: 'job/list', payload: { args: { request: { sessionId: 'job-roster-empty' } } } })
    expect(await receive(frame => frame.id === jobRosterStream)).toMatchObject({ type: 'event', value: { type: 'rows', jobs: [] } })
    socket.send(JSON.stringify({ type: 'cancel', id: jobRosterStream }))
    expect(await result({ method: 'remote.stream', endpoint: 'job/list', payload: { args: { request: { sessionId: 'x', jobId: 'pwsh-1' } } } }))
      .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
    const denied = await result({ method: 'remote.settingsRead' })
    expect(denied).toMatchObject({ type: 'error', code: 'management_required' })
    expect(await result({ method: 'remote.presetManagementRead', preset: 'standard' })).toMatchObject({ type: 'error', code: 'management_required' })
    expect(await result({ method: 'remote.rpc', endpoint: 'settings/openAgentPresetDirectory', payload: { args: { agentPreset: 'standard' } } }))
      .toMatchObject({ type: 'error', code: 'management_required' })
    const streams = ['session/control', 'workspace/follow', '$events']
    for (const endpoint of streams) {
      const id = request({ method: 'remote.stream', endpoint, payload: { args: {} } })
      const event = await receive(frame => frame.id === id)
      expect(event, endpoint).toMatchObject({ type: 'event' })
      expect(event.value).toBeTruthy()
      socket.send(JSON.stringify({ type: 'cancel', id }))
      // 同一 socket 的后续 RPC 必须不被已取消的流拖住。
      expect(await result({ method: 'remote.rpc', endpoint: 'session/list', payload: { args: { _request: {} } } })).toMatchObject({ type: 'result', value: { ok: true } })
    }
    const cordisCall = (endpoint: string, args: unknown) => result({ method: 'remote.rpc', endpoint: 'dynamicCordisRunner/' + endpoint, payload: { args } })
    const expectCordisDisconnected = async () => {
      const denied = await cordisCall('syncInspectManifest', { providers: [] })
      expect(denied).toMatchObject({ type: 'error' })
      // 取消清理异步执行：调用可能在清理前进入、在完成前失去连接，两种路径都必须拒绝。
      expect(['remote_cordis_connection_required', 'remote_cordis_connection_expired']).toContain(denied.code)
      expect(await cordisCall('syncInspectManifest', { providers: [] }))
        .toMatchObject({ type: 'error', code: 'remote_cordis_connection_required' })
    }
    await expectCordisDisconnected()
    const cordisEvents = request({ method: 'remote.stream', endpoint: '$events', payload: { args: {} } })
    expect(await receive(frame => frame.id === cordisEvents)).toMatchObject({ type: 'event', value: { type: 'ready' } })
    const inspectManifest = (id: string) => ({ id, description: 'Isolated connection fixture', methods: [{ name: 'read', description: 'Read fixture',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputSchema: { type: 'string' } }] })
    await desktopRpc('dynamicCordisRunner/syncInspectManifest', { providers: [inspectManifest('isolated-desktop')] })
    expect(await cordisCall('syncInspectManifest', { providers: [inspectManifest('isolated-phone')] })).toMatchObject({ type: 'result', value: { ok: true, value: null } })
    expect(await cordisCall('inventory', {})).toMatchObject({ type: 'result', value: { ok: true, value: [] } })
    socket.send(JSON.stringify({ type: 'cancel', id: cordisEvents }))
    await expectCordisDisconnected()
    await desktopRpc('dynamicCordisRunner/syncInspectManifest', { providers: [] })
    report.cordisConnectionLifetime = true
    const workspacePath = resolve(home, 'test-project')
    await mkdir(workspacePath, { recursive: true })
    if (process.env.DSHM_LATEST_DESKTOP_OPEN_CHECK === '1' || process.env.DSHM_LATEST_DESKTOP_RACE_CHECK === '1')
      explorer = await latestExplorerObservation(workspacePath)
    const registered = await desktopRpc('workspace/create', { request: { path: workspacePath } })
    const sessionId = 'latest-relay-' + randomUUID()
    const mutateCordis = async (action: 'define' | 'update' | 'request' | 'remove') => {
      const id = randomUUID()
      await writeFile(resolve(home, 'cordis-control.json'), JSON.stringify({ id, action, sessionId }))
      let response: { id: string; error?: string; receipt?: { pluginId: string; packageId: string } | null } | undefined
      await expect.poll(async () => {
        try { response = JSON.parse(await readFile(resolve(home, 'cordis-receipt.json'), 'utf8')); return response?.id }
        catch { return undefined }
      }).toBe(id)
      expect(response?.error).toBeUndefined()
      return response?.receipt
    }
    const prepareSidebar = async () => {
      const id = randomUUID()
      await writeFile(resolve(home, 'cordis-control.json'), JSON.stringify({ id, action: 'sidebar', sessionId }))
      let response: { id: string; error?: string; sidebar?: { id: string; workspacePath: string; label: string; source: string } } | undefined
      await expect.poll(async () => {
        try { response = JSON.parse(await readFile(resolve(home, 'cordis-receipt.json'), 'utf8')); return response?.id }
        catch { return undefined }
      }, { timeout: 45000 }).toBe(id)
      expect(response?.error).toBeUndefined()
      expect(response?.sidebar).toMatchObject({ id: expect.any(String), workspacePath, label: 'Latest sidebar child' })
      const sidebar = response!.sidebar!
      const children = await result({ method: 'remote.rpc', endpoint: 'session/projections', payload: { args: { request: { sessionId } } } })
      expect(children, JSON.stringify(children)).toMatchObject({ type: 'result', value: { ok: true } })
      expect(children.value.value.values.subagentCatalog).toEqual(expect.arrayContaining([expect.objectContaining({ id: sidebar.id, mode: 'one-shot' })]))
      const rows = await desktopRpc('session/list', { _request: {} })
      expect(rows.items.find((row: { sessionId: string }) => row.sessionId === sidebar.id))
        .toMatchObject({ parentSessionId: sessionId, origin: 'subagent', cwd: workspacePath, agentAvailable: false })
      report.nativeSidebarChild = sidebar
      return sidebar
    }
    const created = await result({ method: 'remote.rpc', endpoint: 'session/create', payload: { args: { request: { workspaceId: registered.workspace.workspaceId, sessionId } } } })
    expect(created, JSON.stringify(created)).toMatchObject({ type: 'result', value: { ok: true, value: { sessionId } } })
    // 真实原 Host 探测电脑应用与图标；只准备确认快照，不启动用户应用。
    expect(negotiation.value.desktopApps).toBe(true)
    expect(negotiation.value.desktopAppIcons).toBe(true)
    const desktopApps = await result({ method: 'remote.desktopApps', sessionId }, 45000)
    expect(desktopApps, JSON.stringify(desktopApps)).toMatchObject({ type: 'result', value: { available: true, workspacePath } })
    expect(desktopApps.value.apps).toContain('explorer')
    const originalApps = await fetch(new URL('/open-in-app/apps', loginURL), { headers: { cookie }, signal: AbortSignal.timeout(10000) })
    expect(originalApps.status).toBe(200)
    expect((await originalApps.json()).apps).toEqual(desktopApps.value.apps)
    const explorerIcon = await result({ method: 'remote.desktopAppIcon', sessionId, appId: 'explorer' }, 45000)
    expect(explorerIcon, JSON.stringify(explorerIcon)).toMatchObject({ type: 'result', value: { appId: 'explorer', contentType: 'image/png' } })
    const iconBytes = Buffer.from(explorerIcon.value.data, 'base64')
    expect(iconBytes.length).toBeGreaterThan(0); expect(iconBytes.length).toBeLessThanOrEqual(256 * 1024)
    const originalIcon = await fetch(new URL('/open-in-app/icon/explorer', loginURL), { headers: { cookie }, signal: AbortSignal.timeout(10000) })
    expect(originalIcon.status).toBe(200)
    expect(Buffer.from(await originalIcon.arrayBuffer())).toEqual(iconBytes)
    expect(await result({ method: 'remote.desktopApps', sessionId: 'not-visible-' + randomUUID() }))
      .toMatchObject({ type: 'error', code: 'remote_desktop_workspace_missing' })
    expect(await result({ method: 'remote.desktopAppIcon', sessionId, appId: 'unknown-app' }))
      .toMatchObject({ type: 'error', code: 'remote_desktop_app_missing' })
    const preparedApp = await result({ method: 'remote.prepareDesktopApp', sessionId, appId: 'explorer' })
    expect(preparedApp).toMatchObject({ type: 'result', value: { appId: 'explorer', workspacePath, snapshot: expect.any(String) } })
    const replacementApp = await result({ method: 'remote.prepareDesktopApp', sessionId, appId: 'explorer' })
    expect(replacementApp.value.snapshot).not.toBe(preparedApp.value.snapshot)
    expect(await result({ method: 'remote.openDesktopApp', sessionId, snapshot: preparedApp.value.snapshot, confirmed: true }))
      .toMatchObject({ type: 'error', code: 'remote_desktop_stale' })
    report.nativeDesktopAppsIcons = { apps: desktopApps.value.apps, explorerIconBytes: iconBytes.length,
      originalWebCatalogAndIconMatch: true, missingSessionAndAppDenied: true, supersededConfirmationDenied: true,
      actualAppLaunchVerified: false, androidPageVerified: false }
    report.nativeDesktopConnection = await verifyLatestDesktopConnection(origin, sessionId, async () => {
      const response = await api('/v1/device/ticket', claim.token)
      expect(response.status).toBe(200)
      return (await response.json()).ticket
    }, result)
    if (process.env.DSHM_LATEST_DESKTOP_RACE_CHECK === '1')
      report.nativeDesktopInFlight = await verifyLatestDesktopInFlight(origin, home, sessionId, manage, desktopRpc)
    const fileName = 'latest-file-refresh.txt', filePath = resolve(workspacePath, fileName)
    const fileOriginal = 'DSHM 文件第一版 🐳\n', fileUpdated = 'DSHM 第二版，长度不同且包含中文 🐬\n'
    const fileArgs = { workspaceFileScopeId: sessionId, path: fileName }
    await writeFile(filePath, fileOriginal)
    const fileWatch = request({ method: 'remote.stream', endpoint: 'workspaceFiles/changes', payload: { args: fileArgs } })
    expect(await receive(frame => frame.id === fileWatch)).toMatchObject({ type: 'event', value: { kind: 'ready' } })
    const fileRead = await result({ method: 'remote.rpc', endpoint: 'workspaceFiles/readBytes', payload: { args: {
      ...fileArgs, options: { range: { offset: 0, length: 65536 } } } } })
    expect(fileRead, JSON.stringify(fileRead)).toMatchObject({ type: 'result', value: { ok: true } })
    expect(Buffer.from(fileRead.value.value.data, 'base64').toString('utf8')).toBe(fileOriginal)
    const fileStat = async () => {
      const response = await result({ method: 'remote.rpc', endpoint: 'workspaceFiles/stat', payload: { args: fileArgs } })
      expect(response, JSON.stringify(response)).toMatchObject({ type: 'result', value: { ok: true } })
      return response.value.value as { absolutePath: string; version: string; bytes: number }
    }
    const initialFile = await fileStat()
    expect(initialFile.bytes).toBe(Buffer.byteLength(fileOriginal))
    await writeFile(filePath, fileUpdated)
    expect(await receive(frame => frame.id === fileWatch && frame.value?.kind === 'change'
      && frame.value?.change?.version && frame.value.change.version !== initialFile.version))
      .toMatchObject({ type: 'event', value: { change: { absolutePath: initialFile.absolutePath } } })
    const updatedFile = await fileStat()
    expect(updatedFile.bytes).toBe(Buffer.byteLength(fileUpdated)); expect(updatedFile.version).not.toBe(initialFile.version)
    const canonicalRead = await result({ method: 'remote.rpc', endpoint: 'workspaceFiles/readBytes',
      payload: { args: { ...fileArgs, range: { offset: 0, length: 65536 } } } })
    expect(canonicalRead, JSON.stringify(canonicalRead)).toMatchObject({ type: 'result', value: { ok: true, value: updatedFile } })
    expect(Buffer.from(canonicalRead.value.value.data, 'base64').toString('utf8')).toBe(fileUpdated)
    await unlink(filePath)
    expect(await receive(frame => frame.id === fileWatch && frame.value?.change?.absent === true))
      .toMatchObject({ type: 'event', value: { kind: 'change', change: { absolutePath: initialFile.absolutePath, absent: true } } })
    expect(await result({ method: 'remote.rpc', endpoint: 'workspaceFiles/stat', payload: { args: fileArgs } }))
      .toMatchObject({ type: 'result', value: { ok: false, error: { code: 'workspace-file/not-found' } } })
    await writeFile(filePath, fileOriginal)
    expect(await receive(frame => frame.id === fileWatch && frame.value?.change?.version && frame.value.change.version !== updatedFile.version))
      .toMatchObject({ type: 'event', value: { kind: 'change', change: { absolutePath: initialFile.absolutePath } } })
    expect((await fileStat()).bytes).toBe(Buffer.byteLength(fileOriginal))
    socket.send(JSON.stringify({ type: 'cancel', id: fileWatch }))
    // 原Host仍拒绝工作区外的目录；不能将单文件读取权限扩大为任意目录树。
    const directoryArgs = { workspaceFileScopeId: sessionId, path: home }
    expect(await result({ method: 'remote.rpc', endpoint: 'workspaceFiles/list', payload: { args: directoryArgs } }))
      .toMatchObject({ type: 'result', value: { ok: false, error: { code: 'workspace-file/outside-workspace' } } })
    expect(await result({ method: 'remote.stream', endpoint: 'workspaceFiles/changes', payload: { args: directoryArgs } }))
      .toMatchObject({ type: 'error', code: 'workspace-file/outside-workspace' })
    expect(await result({ method: 'remote.rpc', endpoint: 'workspaceFiles/readBytes', payload: { args: { ...fileArgs, options: {} } } }))
      .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
    report.nativeFileWatchBytesDeleteRestore = true
    const officeSources: { extension: string; bytes: Uint8Array }[] = []
    let officeCancellationControl: ReturnType<typeof latestOfficeMobileCancellation> | undefined
    let officeSocketDrop: ReturnType<typeof latestOfficeSocketDrop> | undefined
    let officeUpdatedSource: Uint8Array | undefined
    let officeSessionSources: { source: Uint8Array; differentSource: Uint8Array; sourceText: string; differentText: string } | undefined
    let officeMetadataSources: typeof officeSessionSources
    const fixedOfficeTime = new Date('2020-01-01T00:00:00.000Z')
    let officeAttachments: Awaited<ReturnType<typeof verifyLatestOfficeAttachments>> | undefined
    if (process.env.DSHM_LATEST_OFFICE_CHECK === '1') {
      const { loadOfficeFixture, largeOfficeBytes, sessionOfficeBytes, sameSizeOfficeBytes } = await import(/* @vite-ignore */ pathToFileURL(resolve('../dsh-mobile/scripts/office-fixture.mjs')).href)
      const { realOfficeBytes } = await loadOfficeFixture()
      officeUpdatedSource = realOfficeBytes('docx', 'DSHM Cache Version Test Font')
      if (officeMetadata) {
        officeMetadataSources = await sameSizeOfficeBytes()
        officeUpdatedSource = officeMetadataSources!.differentSource
      }
      if (officeEngine) officeEngineControl = latestOfficeEngine(home, sessionId, workspacePath, await largeOfficeBytes(1200), desktopRpc,
        officeEngineShared ? { request, receive, send: frame => socket!.send(JSON.stringify(frame)),
          pending: id => frames.filter(frame => frame.id === id) } : undefined,
        // 双读者加入及原管理接口核验需要更多真实转换工作量；不暂停引擎或延迟分片。
        officeEngineLifecycle ? await largeOfficeBytes(officeEngineShared ? 2399 : 1201) : undefined)
      if (officeEngineNetworkDrop) {
        officeSocketDrop = latestOfficeSocketDrop(gateway.websocketServer, sessionId, 'latest-mobile-engine.docx')
        onTestFinished(() => officeSocketDrop!.close())
      }
      if (officeSession) officeSessionSources = await sessionOfficeBytes()
      if (officeCancellation) {
        officeCancellationControl = latestOfficeMobileCancellation({ request, receive, desktopRpc,
          send: frame => socket!.send(JSON.stringify(frame)), pending: id => frames.filter(frame => frame.id === id) },
        sessionId, workspacePath, await largeOfficeBytes())
        onTestFinished(async () => { if (socket?.readyState === WebSocket.OPEN) await officeCancellationControl!.cleanup() })
        if (officeRecovery) {
          officeSocketDrop = latestOfficeSocketDrop(gateway.websocketServer, sessionId, 'latest-mobile-inflight.docx')
          onTestFinished(() => officeSocketDrop!.close())
        }
      }
      if (process.env.DSHM_LATEST_OFFICE_TRANSMISSION_CHECK === '1') {
        report.nativeOfficeTransmission = await verifyLatestOfficeTransmission({ request, receive, desktopRpc,
          send: frame => socket!.send(JSON.stringify(frame)), pending: id => frames.filter(frame => frame.id === id) },
        sessionId, workspacePath, await largeOfficeBytes(), officeUpdatedSource!)
        await markStage('office-transmission-complete')
      }
      const formats = ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt'] as const
      const converted: Record<string, unknown> = {}
      for (const extension of formats) {
        const officeName = 'latest-native-office.' + extension, officePath = resolve(workspacePath, officeName)
        const source = officeMetadata && extension === 'docx' ? officeMetadataSources!.source : realOfficeBytes(extension)
        officeSources.push({ extension, bytes: source })
        await writeFile(officePath, source)
        if (officeMetadata && extension === 'docx') await utimes(officePath, fixedOfficeTime, fixedOfficeTime)
        const sourceMetadata = await desktopRpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path: officeName })
        const id = request({ method: 'remote.office', sessionId, path: officeName, priority: 'foreground' })
        let metadata: ReturnType<typeof officeMetadataSchema.parse> | undefined, offset = 0
        const chunks: Buffer[] = []
        for (;;) {
          const frame = await receive(frame => frame.id === id, 120000)
          if (frame.type === 'end') break
          expect(frame, JSON.stringify(frame)).toMatchObject({ type: 'event' })
          if (frame.value.type === 'converting') continue
          if (frame.value.type === 'metadata') {
            const { type: _type, ...value } = frame.value
            expect(metadata).toBeUndefined(); metadata = officeMetadataSchema.parse(value)
            expect(metadata).toMatchObject({ absolutePath: sourceMetadata.absolutePath, version: sourceMetadata.version })
            continue
          }
          expect(metadata).toBeDefined()
          expect(frame.value.type).toBe('chunk'); expect(frame.value.offset).toBe(offset)
          const bytes = Buffer.from(frame.value.data, 'base64')
          expect(bytes.toString('base64')).toBe(frame.value.data)
          expect(bytes.length).toBeGreaterThan(0); expect(bytes.length).toBeLessThanOrEqual(RESOURCE_CHUNK_BYTES)
          offset += bytes.length; expect(offset).toBeLessThanOrEqual(MAX_OFFICE_PDF_BYTES)
          chunks.push(bytes); socket.send(JSON.stringify(clientFrameSchema.parse({ type: 'ack', id, count: 1 })))
        }
        expect(metadata).toBeDefined(); expect(offset).toBe(metadata?.bytes)
        expect(Buffer.concat(chunks).subarray(0, 8).toString('ascii')).toMatch(/^%PDF-\d\.\d/u)
        expect(await readFile(officePath)).toEqual(Buffer.from(source))
        converted[extension] = { bytes: offset, generation: metadata?.generation, missingFonts: metadata?.missingFonts }
      }
      report.nativeOfficeConvertedAndSourcePreserved = converted.docx
      report.nativeOfficeSixFormatsConvertedAndSourcePreserved = converted
    }
    let officeServiceId: string | undefined
    let officeSessionControl: ReturnType<typeof latestOfficeSession> | undefined
    let fileTransferControl: Awaited<ReturnType<typeof latestFileTransfer>> | undefined
    const verifyFiles = async (phase: 'prepare' | 'update' | 'delete' | 'restore' | 'same' | 'office-update' | 'office-restore'
      | 'office-service-disable' | 'office-service-enable' | 'office-connection-stat' | 'office-network-drop'
      | 'office-engine-network-drop' | 'office-engine-service-disable' | 'office-engine-service-enable'
      | 'office-session-prepare' | 'office-session-finish' | OfficeCancellationPhase | OfficeEnginePhase | FileTransferPhase,
      details?: { requestId: string }): Promise<Record<string, any>> => {
      if (phase === 'office-engine-network-drop') {
        expect(officeEngineNetworkDrop).toBe(true)
        expect(officeSocketDrop).toBeDefined()
        expect(details?.requestId).toEqual(expect.any(String))
        // 切断前再次核对真实引擎存活；转换完成后的传输中断不属于本专项。
        const running = await officeEngineControl!.verify('office-engine-running')
        return { ...await officeSocketDrop!.drop(details!.requestId), runningAtDrop: running }
      }
      if (phase === 'office-engine-service-disable' || phase === 'office-engine-service-enable') {
        expect(officeEngineLifecycle).toBe(true)
        const running = phase === 'office-engine-service-disable' ? await officeEngineControl!.verify('office-engine-running') : undefined
        const result = await verifyFiles(phase === 'office-engine-service-disable' ? 'office-service-disable' : 'office-service-enable')
        if (running) {
          if (!('generation' in running)) throw new Error('Original engine running observation has no generation')
          expect(result.generation).toBe(running.generation)
        }
        return { ...result, runningAtDisable: running }
      }
      if (phase.startsWith('office-engine-')) {
        expect(officeEngineControl).toBeDefined()
        return officeEngineControl!.verify(phase as OfficeEnginePhase)
      }
      if (phase.startsWith('file-transfer-')) {
        expect(fileTransfers).toBe(true)
        if (!fileTransferControl) {
          expect(phase).toBe('file-transfer-prepare')
          expect(officeAttachments?.files[0]).toBeDefined()
          fileTransferControl = await latestFileTransfer(gateway.websocketServer, sessionId, workspacePath,
            officeSources.find(item => item.extension === 'docx')!.bytes, officeAttachments!.files[0]!,
            fileFormats ? { sources: officeSources, attachments: officeAttachments!.files } : undefined)
        }
        return fileTransferControl.verify(phase as FileTransferPhase, details)
      }
      if (phase === 'office-session-prepare' || phase === 'office-session-finish') {
        expect(officeSession).toBe(true)
        if (!officeSessionControl) {
          expect(phase).toBe('office-session-prepare')
          expect(officeAttachments?.files[0]).toBeDefined()
          expect(officeSessionSources).toBeDefined()
          officeSessionControl = latestOfficeSession(desktopRpc, home, sessionId, registered.workspace.workspaceId,
            workspacePath, officeSessionSources!.source, officeSessionSources!.differentSource,
            officeAttachments!.files[0]!, { source: officeSessionSources!.sourceText, different: officeSessionSources!.differentText })
        }
        return officeSessionControl.verify(phase)
      }
      if (phase === 'office-network-drop') {
        expect(officeRecovery).toBe(true)
        expect(officeSocketDrop).toBeDefined()
        expect(details?.requestId).toEqual(expect.any(String))
        return officeSocketDrop!.drop(details!.requestId)
      }
      if (phase.startsWith('office-cancel-')) {
        expect(officeCancellationControl).toBeDefined()
        return officeCancellationControl!.verify(phase as OfficeCancellationPhase)
      }
      if (phase === 'office-connection-stat') {
        expect(officeCancellation).toBe(true)
        const officeName = 'latest-native-office.docx'
        expect(await readFile(resolve(workspacePath, officeName)))
          .toEqual(Buffer.from(officeSources.find(item => item.extension === 'docx')!.bytes))
        return { sessionId, metadata: await desktopRpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path: officeName }),
          generation: await desktopRpc('officeToPdf/generation', {}) }
      }
      if (phase === 'office-service-disable' || phase === 'office-service-enable') {
        expect(officeLifetime).toBe(true)
        if (!officeServiceId) {
          const services = (await desktopRpc('pluginManager/listPlugins', {}))
            .filter((row: { moduleName: string }) => row.moduleName === '@deepseek-ai/dsh-office-to-pdf')
          expect(services).toHaveLength(1); expect(services[0].readOnlyReason).toBeUndefined()
          officeServiceId = services[0].entryId
        }
        const source = officeSources.find(item => item.extension === 'docx')!.bytes
        const officeName = 'latest-native-office.docx'
        expect(await readFile(resolve(workspacePath, officeName))).toEqual(Buffer.from(source))
        const metadata = await desktopRpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path: officeName })
        const enabled = phase === 'office-service-enable'
        let generation = enabled ? undefined : await desktopRpc('officeToPdf/generation', {})
        const applied = await desktopRpc('pluginManager/setPluginEnabled', { id: officeServiceId, enabled })
        expect(applied, JSON.stringify(applied)).toMatchObject({ application: 'applied', enabled })
        if (enabled) generation = await desktopRpc('officeToPdf/generation', {})
        expect(generation).toEqual(expect.any(String))
        return { fileName: officeName, metadata, generation }
      }
      if (phase === 'office-update' || phase === 'office-restore') {
        const source = phase === 'office-update' ? officeUpdatedSource : officeSources.find(item => item.extension === 'docx')?.bytes
        if (!source) throw Error('missing_office_source_fixture')
        const officeName = 'latest-native-office.docx', path = resolve(workspacePath, officeName)
        const before = officeMetadata ? await stat(path, { bigint: true }) : undefined
        const beforeMetadata = officeMetadata ? await desktopRpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path: officeName }) : undefined
        await writeFile(path, source)
        if (officeMetadata) await utimes(path, fixedOfficeTime, fixedOfficeTime)
        expect(await readFile(path)).toEqual(Buffer.from(source))
        const metadata = await desktopRpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path: officeName })
        expect(metadata.bytes).toBe(source.byteLength)
        if (officeMetadata) {
          const after = await stat(path, { bigint: true })
          expect(after.size).toBe(before!.size); expect(after.mtimeNs).toBe(before!.mtimeNs)
          expect(after.dev).toBe(before!.dev); expect(after.ino).toBe(before!.ino)
          expect(after.ctimeNs).not.toBe(before!.ctimeNs)
          expect(metadata.version).not.toBe(beforeMetadata.version)
          return { fileName: officeName, metadata, sourceText: phase === 'office-update'
            ? officeMetadataSources!.differentText : officeMetadataSources!.sourceText,
            sameSizeAndMtime: { bytes: Number(after.size), mtimeNs: String(after.mtimeNs),
              beforeCtimeNs: String(before!.ctimeNs), afterCtimeNs: String(after.ctimeNs),
              beforeVersion: beforeMetadata.version, afterVersion: metadata.version,
              sameFileIdentity: true, contentSha256: createHash('sha256').update(source).digest('hex') } }
        }
        return { fileName: officeName, metadata }
      }
      if (phase === 'delete') {
        await unlink(filePath)
        return { code: 'workspace-file/not-found' }
      }
      const content = phase === 'update' || phase === 'same' ? fileUpdated : fileOriginal
      if (phase !== 'same') await writeFile(filePath, content)
      const metadata = await desktopRpc('workspaceFiles/stat', fileArgs)
      expect(metadata.bytes).toBe(Buffer.byteLength(content))
      return { fileName, content, metadata,
        ...(process.env.DSHM_LATEST_OFFICE_CHECK === '1'
          ? { officeFileNames: ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt'].map(extension => 'latest-native-office.' + extension),
            officeAttachments: officeAttachments?.files, officeServiceLifetime: officeLifetime,
            officeMetadata: officeMetadata ? { sourceText: officeMetadataSources!.sourceText, differentText: officeMetadataSources!.differentText } : undefined,
            officeCancellation, officeRecovery, officeEngine, officeEngineShared, officeEngineJoinedCancel, officeEngineNetworkDrop, officeEngineLifecycle } : {}) }
    }
    expect(await result({ method: 'remote.rpc', endpoint: 'workspace/create', payload: { args: { request: { path: workspacePath } } } })).toMatchObject({ type: 'error', code: 'remote_operation_denied' })
    const rename = await result({ method: 'remote.rpc', endpoint: 'session/rename', payload: { args: { request: { sessionId, title: 'Latest Remote isolated test' } } } })
    expect(rename, JSON.stringify(rename)).toMatchObject({ type: 'result', value: { ok: true } })
    const desktopList = await desktopRpc('session/list', { _request: {} })
    expect(desktopList.items.find((item: { sessionId: string }) => item.sessionId === sessionId)).toMatchObject({ projections: { values: { title: 'Latest Remote isolated test' } } })
    const catalog = await result({ method: 'remote.rpc', endpoint: 'session/modelCatalog', payload: { args: {} } })
    expect(catalog, JSON.stringify(catalog)).toMatchObject({ type: 'result', value: { ok: true } })
    const provider = catalog.value.value.groups.find((item: { id: string }) => item.id === 'deepseek-official')
    const model = provider.models[0].id
    const selected = await result({ method: 'remote.rpc', endpoint: 'session/selectModel', payload: { args: { request: { sessionId, provider: provider.id, model } } } })
    expect(selected, JSON.stringify(selected)).toMatchObject({ type: 'result', value: { ok: true, value: { selected: { provider: provider.id, model } } } })
    const follow = request({ method: 'remote.stream', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } } })
    const snapshot = await receive(frame => frame.id === follow)
    expect(snapshot, JSON.stringify(snapshot)).toMatchObject({ type: 'event', value: { type: 'snapshot', projections: { values: { modelSelection: { next: { provider: provider.id, model } } } } } })
    expect(snapshot.value.records.length).toBeGreaterThan(0)
    const page = await result({ method: 'remote.rpc', endpoint: 'session/page', payload: { args: { request: { address: { kind: 'session', sessionId }, throughSeq: snapshot.value.cursor, maxMessages: 30 } } } })
    expect(page, JSON.stringify(page)).toMatchObject({ type: 'result', value: { ok: true } })
    // 无用户 Key 的真实 Agent 会报告凭据缺失；这里只验收消息接纳与同一日志，不冒充推理成功。
    const marker = 'LATEST_RELAY_MESSAGE_' + randomUUID()
    const prompted = await result({ method: 'remote.rpc', endpoint: 'session/prompt', payload: { args: { request: {
      sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: marker }],
    } } } })
    expect(prompted, JSON.stringify(prompted)).toMatchObject({ type: 'result', value: { ok: true, value: { accepted: true } } })
    const liveMessage = await receive(frame => frame.id === follow && JSON.stringify(frame.value).includes(marker))
    expect(liveMessage.type).toBe('event')
    await expect.poll(async () => (await desktopRpc('session/list', { _request: {} })).items.find((item: { sessionId: string }) => item.sessionId === sessionId)?.running,
      { timeout: 10000 }).toBe(false)
    socket.send(JSON.stringify({ type: 'cancel', id: follow }))
    const reopened = request({ method: 'remote.stream', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } })
    const afterPrompt = await receive(frame => frame.id === reopened)
    expect(afterPrompt).toMatchObject({ type: 'event', value: { type: 'snapshot' } })
    const desktopHistory = await desktopRpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: afterPrompt.value.cursor, maxMessages: 30 } })
    expect(JSON.stringify(desktopHistory)).toContain(marker)
    expect(JSON.stringify(afterPrompt.value.records)).toContain(marker)
    expect(JSON.stringify(afterPrompt.value.records)).toContain('MISSING_CREDENTIAL')
    socket.send(JSON.stringify({ type: 'cancel', id: reopened }))
    if (officeSources.length) {
      officeAttachments = await verifyLatestOfficeAttachments({ request, receive, desktopRpc,
        send: frame => socket!.send(JSON.stringify(frame)) }, sessionId, registered.workspace.workspaceId, workspacePath, officeSources)
      report.nativeOfficeHistoricalAttachments = officeAttachments
    }
    const closed = once(socket, 'close'); socket.terminate(); await closed
    await manage({ action: 'management', deviceId: claim.deviceId, enabled: true })
    const managementTicket = await (await api('/v1/device/ticket', claim.token)).json()
    frames.length = 0
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/v1/device/socket')
    socket.on('message', raw => frames.push(JSON.parse(raw.toString())))
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'authenticate', ticket: managementTicket.ticket }))
    const managementReady = await receive(frame => frame.type === 'ready')
    expect(await result({ method: 'remote.negotiate', version: 2 })).toMatchObject({ type: 'result', value: { management: true } })
    const settings = await result({ method: 'remote.settingsRead' })
    expect(settings, JSON.stringify(settings)).toMatchObject({ type: 'result', value: { namespace: 'llm-deepseek', writable: true } })
    expect(settings.value.fields).toHaveLength(5)
    const nativeOfficial = async () => (await desktopRpc('settings/describe', {})).namespaces
      .find((row: { ns: string }) => row.ns === settings.value.documentId)
    const officialBaseline = await nativeOfficial()
    const officialRead = await result({ method: 'remote.deepSeekModelsRead' })
    expect(officialRead).toMatchObject({ type: 'result', value: { provider: 'deepseek', overridden: false, compatEditable: false } })
    expect(officialRead.value.rows.length).toBeGreaterThan(0)
    const officialWrite = { method: 'remote.deepSeekModelsWrite', snapshot: officialRead.value.snapshot,
      expectedRevision: officialRead.value.revision, change: { op: 'set', rows: officialRead.value.rows
        .map((row: Record<string, unknown>, index: number) => ({ ...row, ...(index === 0 ? { name: 'Host official catalog test' } : {}) })) } }
    const officialWriteOutcome = await result(officialWrite)
    report.officialModelWriteOutcome = { type: officialWriteOutcome.type, code: officialWriteOutcome.code }
    expect(officialWriteOutcome, JSON.stringify(report.officialModelWriteOutcome)).toMatchObject({ type: 'result' })
    expect((await nativeOfficial()).value).toEqual({ ...officialBaseline.value, models: officialBaseline.value.models
      .map((row: Record<string, unknown>, index: number) => ({ ...row, ...(index === 0 ? { name: 'Host official catalog test' } : {}) })) })
    expect(await result(officialWrite)).toMatchObject({ type: 'error', code: 'remote_settings_stale' })
    const officialReset = await result({ method: 'remote.deepSeekModelsRead' })
    expect(await result({ method: 'remote.deepSeekModelsWrite', snapshot: officialReset.value.snapshot,
      expectedRevision: officialReset.value.revision, change: { op: 'unset' } })).toMatchObject({ type: 'result' })
    expect((await nativeOfficial()).value).toEqual(officialBaseline.value)
    expect((await nativeOfficial()).user).toEqual(officialBaseline.user)
    report.officialModelsHiddenFieldsPreservedAndDefaultsRestored = true
    const card = await result({ method: 'remote.providerCardRead', provider: 'deepseek-official' })
    expect(card, JSON.stringify(card)).toMatchObject({ type: 'result', value: { configured: true, keyConfigured: false,
      provider: { provider: 'deepseek-official', settingsNs: 'llm-deepseek' } } })
    expect(await result({ method: 'remote.modelReadiness' })).toMatchObject({ type: 'result', value: { kind: 'credential-missing' } })
    const creation = await result({ method: 'remote.providerCreationRead' })
    expect(creation, JSON.stringify(creation)).toMatchObject({ type: 'result', value: { writable: true } })
    expect(creation.value.protocols).toContain('openai-completions')
    const managedRoute = 'dshm-latest-management'
    const createdProvider = await result({ method: 'remote.providerCreationWrite', snapshot: creation.value.snapshot,
      expectedRevision: creation.value.revision, kind: 'custom', provider: managedRoute, name: 'Latest isolated provider',
      useKey: false, confirmed: true, api: 'openai-completions', baseURL: listing.baseURL,
      models: [{ id: 'isolated-model', name: 'Isolated model', contextWindow: 128001, maxTokens: 4097, input: ['text'] }] })
    expect(createdProvider, JSON.stringify(createdProvider)).toMatchObject({ type: 'result', value: { created: { provider: managedRoute, useKey: false } } })
    const providerDescriptor = async () => (await desktopRpc('settings/describe', {})).namespaces.find((row: { value?: { providers?: Record<string, unknown> } }) =>
      Object.hasOwn(row.value?.providers ?? {}, managedRoute))
    const nativeProvider = await providerDescriptor()
    expect(nativeProvider.value.providers[managedRoute]).toMatchObject({ displayName: 'Latest isolated provider',
      api: 'openai-completions', baseURL: listing.baseURL, models: [{ id: 'isolated-model', contextWindow: 128001, maxTokens: 4097 }] })
    expect(nativeProvider.value.providers[managedRoute].apiKeyEnv).toBeUndefined()
    expect(await result({ method: 'remote.providerModelsDiscover', provider: managedRoute })).toMatchObject({ type: 'result',
      value: { provider: managedRoute, rows: [{ id: 'probe-discovered', contextWindow: 128001, maxTokens: 4097 }] } })
    expect(listing.calls.at(-1)).toEqual({ path: '/v1/models', authentication: 'none' })
    const providerRead = await result({ method: 'remote.providerSettingsRead', provider: managedRoute })
    expect(providerRead, JSON.stringify(providerRead)).toMatchObject({ type: 'result', value: { writable: true,
      protocol: { value: 'openai-completions' } } })
    const providerWrite = await result({ method: 'remote.providerSettingsWrite', provider: managedRoute,
      snapshot: providerRead.value.snapshot, expectedRevision: providerRead.value.revision,
      edits: [{ op: 'set', key: 'displayName', value: 'Renamed latest provider' }, { op: 'set', key: 'timeoutMs', value: 5001 }] })
    expect(providerWrite, JSON.stringify(providerWrite)).toMatchObject({ type: 'result' })
    expect((await providerDescriptor()).user.providers[managedRoute]).toMatchObject({ displayName: 'Renamed latest provider', timeoutMs: 5001 })
    expect(await result({ method: 'remote.providerSettingsWrite', provider: managedRoute,
      snapshot: providerRead.value.snapshot, expectedRevision: providerRead.value.revision,
      edits: [{ op: 'set', key: 'timeoutMs', value: 5002 }] })).toMatchObject({ type: 'error', code: 'remote_settings_stale' })
    const providerModels = await result({ method: 'remote.providerModelsRead', provider: managedRoute })
    expect(providerModels, JSON.stringify(providerModels)).toMatchObject({ type: 'result', value: { rows: [{ id: 'isolated-model', contextWindow: 128001, maxTokens: 4097 }] } })
    const providerModelWrite = await result({ method: 'remote.providerModelsWrite', provider: managedRoute,
      snapshot: providerModels.value.snapshot, expectedRevision: providerModels.value.revision,
      change: { op: 'set', rows: providerModels.value.rows.map((row: Record<string, unknown>) => ({
        source: row.source, id: row.id, name: 'Updated isolated model', contextWindow: row.contextWindow, maxTokens: row.maxTokens,
      })) } })
    expect(providerModelWrite, JSON.stringify(providerModelWrite)).toMatchObject({ type: 'result' })
    expect((await providerDescriptor()).value.providers[managedRoute].models).toEqual([
      { ...nativeProvider.value.providers[managedRoute].models[0], name: 'Updated isolated model' },
    ])
    const probe = async (mode: 'none' | 'temporary' | 'stored', baseURL = listing.baseURL) => {
      const prepared = await result({ method: 'remote.modelProbePrepare', baseURL, api: 'openai-completions',
        authentication: mode === 'stored' ? { mode, provider: managedRoute } : { mode } })
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ type: 'result' })
      const operation = { method: 'remote.modelProbeExecute', snapshot: prepared.value.snapshot, mode, confirmed: true,
        ...(mode === 'temporary' ? { apiKey: 'synthetic-latest-temporary' } : {}) }
      const response = await result(operation)
      expect(await result(operation)).toMatchObject({ type: 'error', code: 'remote_settings_stale' })
      return response
    }
    const beforeProbe = await providerDescriptor()
    for (const mode of ['none', 'temporary'] as const) {
      expect(await probe(mode)).toMatchObject({ type: 'result', value: { rows: [{ id: 'probe-discovered', contextWindow: 128001, maxTokens: 4097 }] } })
      expect(listing.calls.at(-1)?.authentication).toBe(mode)
    }
    expect((await providerDescriptor()).value).toEqual(beforeProbe.value)
    const keySetup = await result({ method: 'remote.providerSettingsRead', provider: managedRoute })
    expect(await result({ method: 'remote.providerKeySetup', provider: managedRoute, snapshot: keySetup.value.snapshot,
      expectedRevision: keySetup.value.revision, confirmed: true })).toMatchObject({ type: 'result', value: { keySetupAvailable: false } })
    const keyView = await result({ method: 'remote.keyRead', target: { provider: managedRoute } })
    expect(keyView).toMatchObject({ type: 'result', value: { configured: false, writable: true } })
    const written = await result({ method: 'remote.keyWrite', target: { provider: managedRoute }, snapshot: keyView.value.snapshot,
      change: { op: 'set', value: 'synthetic-latest-stored' } })
    expect(written).toMatchObject({ type: 'result', value: { configured: true } })
    expect(JSON.stringify(written)).not.toContain('synthetic-latest-stored')
    expect(await probe('stored')).toMatchObject({ type: 'result', value: { rows: [{ id: 'probe-discovered' }] } })
    expect(listing.calls.at(-1)?.authentication).toBe('stored')
    expect(await result({ method: 'remote.providerModelsDiscover', provider: managedRoute })).toMatchObject({ type: 'result',
      value: { provider: managedRoute, rows: [{ id: 'probe-discovered' }] } })
    expect(listing.calls.at(-1)).toEqual({ path: '/v1/models', authentication: 'stored' })
    expect(await probe('temporary', listing.redirectURL)).toMatchObject({ type: 'error', code: 'remote_model_discovery_failed' })
    expect(listing.calls.some(row => row.path.startsWith('/forbidden/'))).toBe(false)
    const currentKey = await result({ method: 'remote.keyRead', target: { provider: managedRoute } })
    expect(await result({ method: 'remote.keyWrite', target: { provider: managedRoute }, snapshot: currentKey.value.snapshot,
      change: { op: 'unset' } })).toMatchObject({ type: 'result', value: { configured: false } })
    report.modelProbeNoneTemporaryStoredAndRedirectRejected = true
    report.existingProviderDiscoveryNoneAndStored = true
    const removal = await result({ method: 'remote.providerRemovalRead', provider: managedRoute })
    expect(removal, JSON.stringify(removal)).toMatchObject({ type: 'result', value: { writable: true, removable: true, keepsCredential: true } })
    try {
      expect(await result({ method: 'remote.providerRemovalWrite', provider: managedRoute, snapshot: removal.value.snapshot,
        expectedRevision: removal.value.revision })).toMatchObject({ type: 'result', value: { removed: true } })
    } catch (error) {
      // 只记录隔离实例的存在性与连接状态，不输出完整配置、凭据或登录链接。
      report.providerRemovalDiagnostic = await Promise.allSettled([
        providerDescriptor().then(value => ({ providerPresent: !!value })),
        manage().then(value => ({ connection: value.connection })),
      ]).then(values => values.map(value => value.status === 'fulfilled' ? value.value : { error: String(value.reason) }))
      report.providerRemovalFrames = frames.map(frame => ({ type: frame.type, code: frame.code, id: frame.id }))
      report.hostOutput = stdout.replace(/https?:\/\/\S+/g, '[URL]').slice(-4000)
      throw error
    }
    expect(await providerDescriptor()).toBeUndefined()
    report.providerManagementCreatedEditedAndRemoved = true
    const credentialBytes = () => readFile(resolve(home, '.credentials.yaml')).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    let providerBaseline: unknown, credentialBaseline: Buffer | undefined, listingBaseline = 0, existingListingBaseline = 0
    let phoneKeyReference = false
    let savedPhoneProfile: Record<string, unknown> | undefined
    let advancedBaseline: any, advancedUser: any, advancedCredentials: Buffer | undefined, advancedCalls = 0
    // 新版原 schema 会把继承输入和两类空模板物化为 [] / {}；这些不声明能力或参数。
    // 只归一化原解析器明确等价的字段，其他用户覆盖及全部有效配置仍逐项核对。
    const inheritedModelDefaults = (profile: any) => {
      const value = structuredClone(profile)
      const compat = (row: any) => {
        for (const key of ['chatTemplateArgs', 'chatTemplateKwargs']) if (row.compat?.[key]
          && Object.keys(row.compat[key]).length === 0) delete row.compat[key]
        if (row.compat && Object.keys(row.compat).length === 0) delete row.compat
      }
      compat(value)
      for (const row of value.models ?? []) { if (Array.isArray(row.input) && row.input.length === 0) delete row.input; compat(row) }
      return value
    }
    const verifyProvider = async (phase: 'prepare' | 'probe-cancelled' | 'probe-discovered' | 'probe-adopted' | 'probe-redirect'
      | 'native-probe-cancelled' | 'native-probe-invalid' | 'native-probe-executed'
      | 'existing-discovered' | 'existing-adopted' | 'existing-draft' | 'existing-saved-address'
      | 'existing-key-setup-stale' | 'existing-key-saved' | 'existing-authenticated' | 'existing-draft-authenticated' | 'existing-key-removed' | 'existing-missing-key'
      | 'advanced-prepare' | 'advanced-set' | 'advanced-disabled' | 'advanced-restored' | 'advanced-provider-defaults'
      | 'advanced-protocol-cancel' | 'advanced-protocol-switched' | 'advanced-protocol-restored' | 'advanced-provider-restored'
      | 'created' | 'renamed' | 'model-renamed' | 'cancelled' | 'removed', route: string) => {
      const native = async () => (await desktopRpc('settings/describe', {})).namespaces.find((row: { ns: string }) => row.ns === nativeProvider.ns)
      if (phase === 'prepare') {
        providerBaseline = (await native()).value.providers
        credentialBaseline = await credentialBytes()
        listingBaseline = listing.calls.length
        phoneKeyReference = false
        savedPhoneProfile = undefined
        expect(Object.hasOwn(providerBaseline as object, route)).toBe(false)
        return { baseURL: listing.baseURL, redirectURL: listing.redirectURL, draftURL: listing.baseURL.replace('/v1', '/draft/v1') }
      }
      if (phase.startsWith('probe-') || phase.startsWith('native-probe-')) {
        expect((await native()).value.providers).toEqual(providerBaseline)
        const calls = listing.calls.slice(listingBaseline)
        const expected = phase === 'native-probe-executed' ? ['none', 'none', 'temporary']
          : phase.startsWith('native-probe-') || phase === 'probe-redirect' ? ['none', 'none']
          : phase === 'probe-cancelled' ? [] : ['none']
        expect(calls.map(row => row.authentication)).toEqual(expected)
        expect(listing.calls.some(row => row.path.startsWith('/forbidden/'))).toBe(false)
        const currentCredentials = await credentialBytes()
        // 只比较本测试隔离 home 的字节；失败也不将凭据内容打印到断言输出。
        expect(credentialBaseline === undefined ? currentCredentials === undefined
          : currentCredentials !== undefined && credentialBaseline.equals(currentCredentials)).toBe(true)
        return
      }
      if (phase === 'removed') {
        await expect.poll(async () => (await native()).value.providers).toEqual(providerBaseline)
        expect((await desktopRpc('session/modelCatalog', {})).groups.some((row: { id: string }) => row.id === route)).toBe(false)
        return
      }
      if (phase.startsWith('advanced-')) {
        if (phase === 'advanced-prepare') {
          const current = await native()
          advancedBaseline = structuredClone(current.value.providers[route])
          advancedUser = structuredClone(current.user.providers[route])
          advancedCredentials = await credentialBytes()
          advancedCalls = listing.calls.length
          return
        }
        const expected = structuredClone(advancedUser)
        if (['advanced-set', 'advanced-disabled'].includes(phase)) {
          expected.models[0] = { ...expected.models[0], input: ['image', 'text'],
            reasoningEfforts: phase === 'advanced-disabled' ? false : { off: null, high: 'high' },
            compat: { supportsStore: false, maxTokensField: 'max_tokens', thinkingFormat: 'chat-template', vllmPriority: -1,
              chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' }, effort: { $var: 'thinking.effort', omitWhenOff: true },
                marker: 'latest', count: 3, enabled: false, empty: null }, chatTemplateArgs: { budget: { $var: 'thinking.budget' } } } }
        }
        if (['advanced-provider-defaults', 'advanced-protocol-cancel', 'advanced-protocol-switched', 'advanced-protocol-restored'].includes(phase)) {
          expected.compat = { supportsStrictMode: true }
          if (phase === 'advanced-protocol-switched') expected.api = 'openai-responses'
        }
        await expect.poll(async () => inheritedModelDefaults((await native()).user.providers[route])).toEqual(inheritedModelDefaults(expected))
        const current = await native()
        const effective = structuredClone(advancedBaseline)
        if (['advanced-set', 'advanced-disabled'].includes(phase)) effective.models[0] = { ...effective.models[0],
          input: expected.models[0].input, reasoningEfforts: expected.models[0].reasoningEfforts,
          compat: { ...effective.models[0].compat, ...expected.models[0].compat } }
        if (expected.compat) effective.compat = { ...effective.compat, ...expected.compat }
        effective.api = expected.api
        expect(current.value.providers[route]).toEqual(effective)
        const currentCredentials = await credentialBytes()
        expect(advancedCredentials === undefined ? currentCredentials === undefined
          : currentCredentials !== undefined && advancedCredentials.equals(currentCredentials)).toBe(true)
        expect(listing.calls.length).toBe(advancedCalls)
        return
      }
      const expectedName = phase === 'created' ? '手机提供方验收' : '手机提供方改名'
      const modelSaved = !['created', 'renamed', 'existing-discovered', 'existing-adopted'].includes(phase)
      const expectedModel = modelSaved ? '手机模型改名' : 'Phone model'
      const expectedModels = [{ id: 'phone-model', name: expectedModel, contextWindow: 128001, maxTokens: 4097 },
        ...(modelSaved ? [{ id: 'probe-discovered', name: 'HTTP 新模型', contextWindow: 128001, maxTokens: 4097 }] : [])]
      await expect.poll(async () => (await native()).value.providers[route]).toMatchObject({ displayName: expectedName,
        api: 'openai-completions', baseURL: listing.baseURL, models: expectedModels })
      const phoneProfile = (await native()).value.providers[route]
      if (['renamed', 'model-renamed'].includes(phase)) savedPhoneProfile = structuredClone(phoneProfile)
      if (phase === 'existing-key-saved') {
        phoneKeyReference = true
        expect(phoneProfile).toEqual({ ...savedPhoneProfile, apiKeyEnv: phoneProfile.apiKeyEnv })
        savedPhoneProfile = structuredClone(phoneProfile)
      }
      if (phoneKeyReference) expect(typeof (await native()).value.providers[route].apiKeyEnv).toBe('string')
      else expect((await native()).value.providers[route].apiKeyEnv).toBeUndefined()
      await expect.poll(async () => (await desktopRpc('session/modelCatalog', {})).groups.find((row: { id: string }) => row.id === route))
        .toMatchObject({ id: route, models: expectedModels.map(({ id, name }) => ({ id, name })) })
      if (phase === 'existing-discovered') existingListingBaseline = listing.calls.length - 1
      if (phase.startsWith('existing-')) {
        expect(phoneProfile).toEqual(savedPhoneProfile)
        const directoryCalls = listing.calls.slice(existingListingBaseline)
        const requestCount = ['existing-discovered', 'existing-adopted'].includes(phase) ? 1 : phase === 'existing-draft' ? 2
          : ['existing-saved-address', 'existing-key-setup-stale', 'existing-key-saved'].includes(phase) ? 3 : phase === 'existing-authenticated' ? 4 : 5
        expect(directoryCalls).toEqual([
          { path: '/v1/models', authentication: 'none' }, { path: '/draft/v1/models', authentication: 'none' },
          { path: '/v1/models', authentication: 'none' }, { path: '/v1/models', authentication: 'stored' },
          { path: '/draft/v1/models', authentication: 'stored' },
        ].slice(0, requestCount))
        if (phoneKeyReference) {
          const configured = ['existing-key-saved', 'existing-authenticated', 'existing-draft-authenticated'].includes(phase)
          expect(await result({ method: 'remote.keyRead', target: { provider: route } })).toMatchObject({ type: 'result', value: { configured } })
          expect((await credentialBytes())?.includes(Buffer.from('synthetic-latest-stored')) ?? false).toBe(configured)
        }
      }
    }
    let catalogOfficial: any, catalogProviders: any, catalogProfile: any, catalogRows: any[], catalogCredentials: Buffer | undefined
    let catalogCalls = 0
    const nativePi = async () => (await desktopRpc('settings/describe', {})).namespaces.find((row: { ns: string }) => row.ns === nativeProvider.ns)
    const verifyCatalog = async (phase: 'prepare' | 'official-saved' | 'official-restored' | 'builtin-created' | 'builtin-draft'
      | 'builtin-overrides' | 'builtin-removed-one' | 'builtin-overrides-restored' | 'builtin-list' | 'builtin-list-restored' | 'builtin-cleaned', data?: { ids: string[] }) => {
      if (phase === 'prepare') {
        catalogOfficial = await nativeOfficial()
        catalogProviders = await nativePi()
        expect(Object.hasOwn(catalogProviders.value.providers, 'openai')).toBe(false)
        expect(Object.hasOwn(catalogOfficial.user ?? {}, 'models')).toBe(false)
        catalogCredentials = await credentialBytes()
        catalogCalls = listing.calls.length
        return { officialId: catalogOfficial.value.models[0].id, officialName: catalogOfficial.value.models[0].name }
      }
      const currentCredentials = await credentialBytes()
      expect(catalogCredentials === undefined ? currentCredentials === undefined
        : currentCredentials !== undefined && catalogCredentials.equals(currentCredentials)).toBe(true)
      expect(listing.calls.length).toBe(catalogCalls)
      if (phase.startsWith('official-')) {
        const models = catalogOfficial.value.models.map((row: Record<string, unknown>, index: number) => ({ ...row,
          ...(phase === 'official-saved' && index === 0 ? { name: 'DSHM 官方模型验收', inputModalities: ['text'] } : {}) }))
        await expect.poll(async () => (await nativeOfficial()).value).toEqual({ ...catalogOfficial.value, models })
        if (phase === 'official-restored') expect((await nativeOfficial()).user).toEqual(catalogOfficial.user)
        else expect(Object.hasOwn((await nativeOfficial()).user, 'models')).toBe(true)
        const group = (await desktopRpc('session/modelCatalog', {})).groups.find((row: { id: string }) => row.id === provider.id)
        expect(group.models.map((row: { id: string; name: string }) => ({ id: row.id, name: row.name })))
          .toEqual(models.map((row: { id: string; name: string }) => ({ id: row.id, name: row.name })))
        return
      }
      if (phase === 'builtin-created') {
        catalogProfile = (await nativePi()).value.providers.openai
        expect((await nativePi()).user.providers.openai).toEqual({ displayName: 'DSHM 内置目录验收' })
        const discovered = await result({ method: 'remote.providerModelsDiscover', provider: 'openai' })
        expect(discovered).toMatchObject({ type: 'result', value: { provider: 'openai' } })
        catalogRows = discovered.value.rows
        expect(catalogRows.length).toBeGreaterThan(1)
        expect(listing.calls.length).toBe(catalogCalls)
        return { count: catalogRows.length }
      }
      if (phase === 'builtin-cleaned') {
        await expect.poll(async () => (await nativePi()).value).toEqual(catalogProviders.value)
        expect((await nativePi()).user).toEqual(catalogProviders.user)
        expect((await desktopRpc('session/modelCatalog', {})).groups.some((row: { id: string }) => row.id === 'openai')).toBe(false)
        return
      }
      if (data?.ids) expect(data.ids).toEqual(phase === 'builtin-removed-one' ? [catalogRows[1].id]
        : catalogRows.slice(0, data.ids.length).map(row => row.id))
      const native = await nativePi(), current = native.value.providers.openai, user = native.user.providers.openai
      expect(current.apiKeyEnv).toBeUndefined()
      if (['builtin-draft', 'builtin-overrides-restored', 'builtin-list-restored'].includes(phase)) {
        expect(current).toEqual(catalogProfile)
        expect(user).toEqual({ displayName: 'DSHM 内置目录验收' })
      } else if (['builtin-overrides', 'builtin-removed-one'].includes(phase)) {
        const changed = { [catalogRows[1].id]: { name: 'DSHM 内置覆盖二', contextWindow: 128001, maxTokens: 4097,
          input: ['image', 'text'], reasoningEfforts: false, compat: { supportsStrictMode: false } },
          ...(phase === 'builtin-overrides' ? { [catalogRows[0].id]: { name: 'DSHM 内置覆盖一' } } : {}) }
        expect(user).toEqual({ displayName: 'DSHM 内置目录验收', modelOverrides: changed })
      } else if (phase === 'builtin-list') {
        const row = catalogRows[0]
        expect(user.models).toEqual([{ id: row.id, name: 'DSHM 内置清单', contextWindow: row.contextWindow, maxTokens: row.maxTokens,
          ...(row.inputModalities ? { input: row.inputModalities } : {}) }])
        expect(user.modelOverrides).toBeUndefined()
      }
      const group = (await desktopRpc('session/modelCatalog', {})).groups.find((row: { id: string }) => row.id === 'openai')
      expect(group.models.length).toBe(phase === 'builtin-list' ? 1 : catalogRows.length)
      if (phase === 'builtin-list') expect(group.models[0]).toMatchObject({ id: catalogRows[0].id, name: 'DSHM 内置清单' })
      if (['builtin-overrides', 'builtin-removed-one'].includes(phase)) expect(group.models.find((row: { id: string }) => row.id === catalogRows[1].id))
        // 原会话选择目录只公开 ID/名称；容量已由上方原配置和手机字段核验。
        .toMatchObject({ name: 'DSHM 内置覆盖二' })
    }
    const roster = await desktopRpc('agentPresets/list', {})
    expect(roster.modeSelectionEnabled).toBeUndefined()
    const alternate = roster.presets.find((row: { id: string; isDefault: boolean; broken?: string }) => !row.isDefault && row.broken === undefined && ['standard', 'cordis'].includes(row.id))
    expect(alternate).toBeTruthy()
    const profileDirectory = resolve(home, 'profiles', electron ? 'desktop' : 'web')
    const presetDocumentPath = resolve(profileDirectory, 'cordis.patch.yml')
    const beforeDirectoryRead = await readFile(presetDocumentPath, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    expect(await result({ method: 'remote.rpc', endpoint: 'settings/openAgentPresetDirectory', payload: { args: { agentPreset: alternate.id } } }))
      .toMatchObject({ type: 'result', value: { ok: true, value: { opened: false, path: profileDirectory, documentPath: presetDocumentPath } } })
    expect(await readFile(presetDocumentPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return undefined })).toBe(beforeDirectoryRead)
    expect(await result({ method: 'remote.rpc', endpoint: 'settings/openAgentPresetDirectory', payload: { args: { agentPreset: 'not-declared' } } }))
      .toMatchObject({ type: 'error', code: 'remote_operation_denied' })
    report.presetDirectoryReadOnlyAndOwned = true
    const presetRead = async (preset: string) => {
      const frame = await result({ method: 'remote.presetManagementRead', preset })
      expect(frame, JSON.stringify(frame)).toMatchObject({ type: 'result', value: { preset, canCopy: true } })
      return frame.value
    }
    const beforeFailure = await readFile(presetDocumentPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return undefined })
    const failureSource = (await desktopRpc('agentPresets/list', {})).presets.find((row: { id: string }) => row.id === 'fault-source')
    expect(failureSource.broken).toBeUndefined()
    const failureSnapshot = await presetRead('fault-source')
    const failedCopy = await result({ method: 'remote.presetCopy', snapshot: failureSnapshot.snapshot, id: 'fault-copy', name: 'Fault copy' })
    expect(failedCopy, JSON.stringify(failedCopy)).toMatchObject({ type: 'error', code: 'remote_presets_unavailable' })
    expect(await readFile(presetDocumentPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return undefined })).toBe(beforeFailure)
    const afterFailure = (await desktopRpc('agentPresets/list', {})).presets
    expect(afterFailure.some((row: { id: string }) => row.id === 'fault-copy')).toBe(false)
    expect(afterFailure.find((row: { id: string }) => row.id === 'fault-source').broken).toBeUndefined()
    report.presetOriginalLoaderFailureRolledBack = true
    const builtIn = await presetRead(alternate.id)
    expect(builtIn.canDelete).toBe(false)
    const copyId = 'dshm-test-copy'
    const copied = await result({ method: 'remote.presetCopy', snapshot: builtIn.snapshot, id: copyId, name: '手机复制测试' })
    expect(copied, JSON.stringify(copied)).toMatchObject({ type: 'result', value: { preset: copyId, copied: true, deleted: false } })
    expect((await desktopRpc('agentPresets/list', {})).presets.find((row: { id: string }) => row.id === copyId))
      .toMatchObject({ id: copyId, name: '手机复制测试' })
    const copyDocument = await readFile(presetDocumentPath, 'utf8')
    expect(copyDocument).toContain(copyId)
    const sourceComposition = await desktopRpc('agentPresets/read', { agentPreset: alternate.id })
    const copyComposition = await desktopRpc('agentPresets/read', { agentPreset: copyId })
    expect(copyComposition.content).toBe(sourceComposition.content)
    const staleCopy = await presetRead(copyId)
    const externalChange = copyDocument + '\n# isolated external edit\n'
    await writeFile(presetDocumentPath, externalChange)
    expect(await result({ method: 'remote.presetDelete', snapshot: staleCopy.snapshot, confirmed: true })).toMatchObject({ type: 'error', code: 'remote_settings_stale' })
    expect(await readFile(presetDocumentPath, 'utf8')).toBe(externalChange)
    await writeFile(presetDocumentPath, copyDocument)
    const duplicateCopy = await presetRead(alternate.id)
    expect(await result({ method: 'remote.presetCopy', snapshot: duplicateCopy.snapshot, id: copyId, name: 'Duplicate' }))
      .toMatchObject({ type: 'error', code: 'remote_preset_exists' })
    expect(await readFile(presetDocumentPath, 'utf8')).toBe(copyDocument)
    const retainedSessionId = 'latest-copy-retain-' + randomUUID()
    await desktopRpc('session/create', { request: { workspaceId: registered.workspace.workspaceId, sessionId: retainedSessionId } })
    await desktopRpc('agentPresets/select', { agentId: retainedSessionId, agentPreset: copyId })
    const selectedDefault = await result({ method: 'remote.settingsRead', namespace: 'agent-preset-registry' })
    expect(await result({ method: 'remote.settingsWrite', namespace: 'agent-preset-registry', snapshot: selectedDefault.value.snapshot,
      expectedRevision: selectedDefault.value.revision, edits: [{ op: 'set', key: 'selectedDefault', value: copyId }] }))
      .toMatchObject({ type: 'result' })
    const owned = await presetRead(copyId)
    expect(owned.canDelete).toBe(true)
    expect(owned.defaultAfterDelete).toBe(roster.presets.find((row: { isDefault: boolean }) => row.isDefault)?.id)
    const removed = await result({ method: 'remote.presetDelete', snapshot: owned.snapshot, confirmed: true })
    expect(removed, JSON.stringify(removed)).toMatchObject({ type: 'result', value: { preset: copyId, deleted: true, copied: false } })
    const afterDelete = await desktopRpc('agentPresets/list', {})
    expect(afterDelete.presets.some((row: { id: string }) => row.id === copyId)).toBe(false)
    expect(afterDelete.presets.find((row: { isDefault: boolean }) => row.isDefault)?.id).toBe(owned.defaultAfterDelete)
    expect((await desktopRpc('session/list', { _request: {} })).items.find((row: { sessionId: string }) => row.sessionId === retainedSessionId)?.projections.values.agentPreset).toBe(copyId)
    const refusedChoice = await result({ method: 'remote.rpc', endpoint: 'agentPresets/select', payload: { args: { agentId: sessionId, agentPreset: copyId } } })
    expect(refusedChoice).toMatchObject({ type: 'result', value: { ok: false,
      error: { code: 'agent-preset/not-found', details: { agentPreset: copyId, available: expect.any(Array) } } } })
    expect(refusedChoice.value.error.details.available).toContain(alternate.id)
    // 原 Agent 已保留组成；定义删除后仍可接受消息，缺 Key 是原模型错误而非预设丢失。
    const retainedPrompt = await desktopRpc('session/prompt', { request: { sessionId: retainedSessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: 'Deleted declaration retains this existing session.' }] } })
    expect(retainedPrompt.accepted).toBe(true)
    await expect.poll(async () => (await desktopRpc('session/list', { _request: {} })).items.find((row: { sessionId: string }) => row.sessionId === retainedSessionId)?.running).toBe(false)
    expect(await result({ method: 'remote.presetDelete', snapshot: owned.snapshot, confirmed: true })).toMatchObject({ type: 'error', code: 'remote_settings_stale' })
    report.presetCopiedDeletedAndRetained = true
    const defaultView = await result({ method: 'remote.settingsRead', namespace: 'agent-preset-registry' })
    expect(defaultView, JSON.stringify(defaultView)).toMatchObject({ type: 'result', value: { writable: true } })
    expect(defaultView.value.fields).toEqual([{ key: 'selectedDefault', overridden: false }])
    const verifyDefault = async (id: string) => {
      try {
        const settings = await desktopRpc('settings/describe', {})
        const row = settings.namespaces.find((row: { ns: string }) => row.ns === defaultView.value.documentId)
        expect(row.value.selectedDefault).toBe(id)
        expect(row.user.selectedDefault).toBe(id)
        expect((await desktopRpc('agentPresets/list', {})).presets.find((row: { isDefault: boolean }) => row.isDefault)?.id).toBe(id)
        const inheritedId = 'latest-relay-' + randomUUID()
        await desktopRpc('session/create', { request: { workspaceId: registered.workspace.workspaceId, sessionId: inheritedId } })
        const list = await desktopRpc('session/list', { _request: {} })
        expect(list.items.find((row: { sessionId: string }) => row.sessionId === inheritedId)?.projections.values.agentPreset).toBe(id)
        expect(list.items.find((row: { sessionId: string }) => row.sessionId === sessionId)?.projections.values.agentPreset)
          .toBe(desktopList.items.find((row: { sessionId: string }) => row.sessionId === sessionId)?.projections.values.agentPreset)
      } finally {
        const current = await desktopRpc('settings/describe', {})
        const row = current.namespaces.find((row: { ns: string }) => row.ns === defaultView.value.documentId)
        await desktopRpc('settings/mutate', { ns: row.ns, ops: [{ op: 'unset', path: ['selectedDefault'] }], expectedRevision: row.revision })
        expect((await desktopRpc('agentPresets/list', {})).presets.find((row: { isDefault: boolean }) => row.isDefault)?.id)
          .toBe(roster.presets.find((row: { isDefault: boolean }) => row.isDefault)?.id)
      }
    }
    const preparePreset = async () => {
      const baseline = await desktopRpc('session/list', { _request: {} })
      return { id: alternate.id, copyId: 'phone-copy-' + randomUUID(), workspaceTitle: 'test-project', documentPath: presetDocumentPath, existing: new Set<string>(baseline.items.map((item: { sessionId: string }) => item.sessionId)) }
    }
    const toolsView = await result({ method: 'remote.settingsRead', namespace: 'ui-settings' })
    expect(toolsView.type).toBe('result')
    const toolsWrite = await result({ method: 'remote.settingsWrite', namespace: 'ui-settings', snapshot: toolsView.value.snapshot,
      expectedRevision: toolsView.value.revision, edits: [{ op: 'set', key: 'enabled', value: false }] })
    expect(toolsWrite, JSON.stringify(toolsWrite)).toMatchObject({ type: 'result', value: { fields: [{ key: 'enabled', value: false, user: false, overridden: true }] } })
    const nativeTools = (await desktopRpc('settings/describe', {})).namespaces.find((row: { ns: string }) => row.ns === toolsView.value.documentId)
    expect(nativeTools, JSON.stringify(nativeTools)).toMatchObject({ value: { enabled: false }, user: { enabled: false } })
    await desktopRpc('settings/mutate', { ns: nativeTools.ns, ops: [{ op: 'unset', path: ['enabled'] }], expectedRevision: nativeTools.revision })
    const verifyCoding = async (phase: 'prepare' | 'off' | 'restored' | 'desktop-off' | 'desktop-restore') => {
      const describe = async () => (await desktopRpc('settings/describe', {})).namespaces.find((row: { ns: string }) => row.ns === toolsView.value.documentId)
      if (phase === 'prepare') {
        expect((await desktopRpc('agentPresets/list', {})).presets.find((row: { id: string }) => row.id === 'ptc')?.broken).toBeUndefined()
        const defaults = (await desktopRpc('settings/describe', {})).namespaces.find((row: { ns: string }) => row.ns === defaultView.value.documentId)
        await desktopRpc('settings/mutate', { ns: defaults.ns, ops: [{ op: 'set', path: ['selectedDefault'], value: 'ptc' }], expectedRevision: defaults.revision })
      } else if (phase === 'off' || phase === 'restored') {
        await expect.poll(async () => { const row = await describe(); const value = { enabled: row.value.enabled, overridden: Object.hasOwn(row.user ?? {}, 'enabled') };
          report.codingToolsLastCheck = { phase, documentId: toolsView.value.documentId, value }; return value; })
          .toEqual({ enabled: phase === 'restored', overridden: phase === 'off' })
        expect((await desktopRpc('agentPresets/list', {})).presets.find((row: { isDefault: boolean }) => row.isDefault)?.id).toBe('standard')
        if (phase === 'restored') {
          const defaults = (await desktopRpc('settings/describe', {})).namespaces.find((row: { ns: string }) => row.ns === defaultView.value.documentId)
          await desktopRpc('settings/mutate', { ns: defaults.ns, ops: [{ op: 'unset', path: ['selectedDefault'] }], expectedRevision: defaults.revision })
        }
      } else {
        const row = await describe()
        await desktopRpc('settings/mutate', { ns: row.ns, ops: phase === 'desktop-off'
          ? [{ op: 'set', path: ['enabled'], value: false }] : [{ op: 'unset', path: ['enabled'] }], expectedRevision: row.revision })
      }
    }
    const retainedByCopy = new Map<string, string>()
    let creatorBefore = new Map<string, string>(), creatorCount = 0
    const verifyCreator = async (phase: 'prepare' | 'applied') => {
      if (phase === 'prepare') {
        const rows = (await desktopRpc('session/list', { _request: {} })).items
        for (const row of rows) if (row.blank && row.projections.values.agentPreset !== 'standard')
          await desktopRpc('agentPresets/select', { agentId: row.sessionId, agentPreset: 'standard' })
        const baseline = (await desktopRpc('session/list', { _request: {} })).items
        creatorBefore = new Map(baseline.map((row: { sessionId: string; projections: { values: { agentPreset: string } } }) => [row.sessionId, row.projections.values.agentPreset]))
        creatorCount = baseline.length
        return
      }
      let selected: { sessionId: string; blank: boolean; cwd: string }
      await expect.poll(async () => {
        const rows = (await desktopRpc('session/list', { _request: {} })).items
        // 隔离工作区已有空会话，原 startSession 应复用；只有一条组成改变。
        expect(rows).toHaveLength(creatorCount)
        const changed = rows.filter((row: { sessionId: string; projections: { values: { agentPreset: string } } }) => creatorBefore.get(row.sessionId) !== row.projections.values.agentPreset)
        if (changed.length !== 1) return false
        selected = changed[0]
        return changed[0].projections.values.agentPreset === 'cordis'
      }, { timeout: 10000 }).toBe(true)
      expect(selected!.blank).toBe(true)
      expect(selected!.cwd).toBe(workspacePath)
      report.presetCreatorDraftLanded = true
      return selected!.sessionId
    }
    const verifyManagement = async (phase: 'copied' | 'cancelled' | 'deleted', id: string) => {
      const rows = (await desktopRpc('agentPresets/list', {})).presets
      const declaration = rows.find((row: { id: string }) => row.id === id)
      const text = await readFile(presetDocumentPath, 'utf8')
      if (phase === 'copied') {
        expect(declaration).toMatchObject({ id, name: '手机模式复制验收' }); expect(text).toContain(id)
        const session = 'latest-ui-copy-' + randomUUID()
        await desktopRpc('session/create', { request: { workspaceId: registered.workspace.workspaceId, sessionId: session } })
        await desktopRpc('agentPresets/select', { agentId: session, agentPreset: id })
        retainedByCopy.set(id, session)
      } else if (phase === 'cancelled') {
        expect(declaration).toBeTruthy(); expect(text).toContain(id)
      } else {
        expect(declaration).toBeUndefined(); expect(text).toContain(id); expect(text).toContain('archived: true')
        expect((await desktopRpc('session/list', { _request: {} })).items.find((row: { sessionId: string }) => row.sessionId === retainedByCopy.get(id))?.projections.values.agentPreset).toBe(id)
      }
    }
    const verifyPreset = async (preset: { id: string; existing: Set<string> }) => {
      await expect.poll(async () => {
        const rows = (await desktopRpc('session/list', { _request: {} })).items.filter((item: { sessionId: string }) => !preset.existing.has(item.sessionId))
        expect(rows).toHaveLength(1)
        expect(rows[0].blank).toBe(true)
        return rows[0].projections.values.agentPreset
      }).toBe(preset.id)
    }
    await markStage('protocol-complete')
    if (process.env.DSHM_LATEST_PAGE_CHECK === '1') {
      await markStage('browser-starting')
      const { verifyLatestRemotePage } = await import(/* @vite-ignore */ pathToFileURL(resolve('../dsh-mobile/tests/support/latest-remote-page.mjs')).href)
      const originalShell = await result({ method: 'remote.settingsRead', namespace: 'shell' })
      expect(originalShell.type).toBe('result')
      expect(originalShell.value.documentId).toEqual(expect.any(String))
      const originalTimeout = originalShell.value.fields.find((field: { key: string }) => field.key === 'timeoutMs')
      expect(originalTimeout.overridden).toBe(false)
      const preset = await preparePreset()
      report.mobilePage = await verifyLatestRemotePage({ socket, ready: managementReady,
        binding: { paired: true, origin, deviceId: claim.deviceId, fingerprint: await calculateJwkThumbprint(identity.jwk) },
        title: 'Latest Remote isolated test', marker, nextModel: provider.models[1], shellValue: originalTimeout.value, mutateCordis,
        preset, verifyPreset: () => verifyPreset(preset), verifyDefault, verifyManagement, verifyCoding, verifyCreator, verifyProvider, verifyCatalog, verifyFiles,
        mutateShellOnDesktop: async (value: number) => {
          const view = await result({ method: 'remote.settingsRead', namespace: 'shell' })
          expect(view.type).toBe('result')
          await desktopRpc('settings/mutate', { ns: view.value.documentId,
            ops: [{ op: 'set', path: ['timeoutMs'], value }], expectedRevision: view.value.revision })
        },
        verifyShell: async (value: number, overridden: boolean) => {
          await expect.poll(async () => {
            // 浏览器复用此 socket；不能以同一设备再分配 Remote 快照，使手机正在保存的快照失效。
            const read = await desktopRpc('settings/describe', {})
            const row = read.namespaces.find((item: { ns: string }) => item.ns === originalShell.value.documentId)
            expect(row).toBeTruthy()
            return { value: row.value.timeoutMs, overridden: Object.hasOwn(row.user ?? {}, 'timeoutMs') }
          }).toMatchObject({ value, overridden })
        } })
      const desktopSelection = await desktopRpc('session/list', { _request: {} })
      expect(desktopSelection.items.find((item: { sessionId: string }) => item.sessionId === sessionId))
        .toMatchObject({ projections: { values: { modelSelection: { next: { provider: provider.id, model: provider.models[1].id } } } } })
      report.mobileModelSyncedToDesktop = true
      await markStage('browser-complete')
    }
    if (process.env.DSHM_LATEST_ANDROID_CHECK === '1') {
      await markStage('android-starting')
      const { verifyLatestRemoteAndroid } = await import(/* @vite-ignore */ pathToFileURL(resolve('../dsh-mobile/tests/support/latest-remote-android.mjs')).href)
      const pairing = await manage({ action: 'pair' })
      const androidModel = provider.models[process.env.DSHM_LATEST_PAGE_CHECK === '1' ? 0 : 1]
      let androidDeviceId: string | undefined
      const preset = await preparePreset()
      report.android = await verifyLatestRemoteAndroid({ origin, pairLink: pairing.link,
        desktop: { workspacePath, revocation: process.env.DSHM_LATEST_DESKTOP_RACE_CHECK === '1' ? {
          ...latestDesktopProbe(home, sessionId), verifyNoOpen: () => explorer!.assertNotOpened(),
        } : undefined, prepareSidebar: async () => {
          const child = await prepareSidebar()
          // 本专项新增的真实子记录属于夹具基线；后续新建预设仍精确要求仅一个新会话。
          preset.existing.add(child.id)
          return child
        }, verifyOpen: explorer ? async (phase: 'opened' | 'closed') => {
          if (phase === 'opened') {
            const observation = await explorer!.opened()
            report.nativeDesktopAppOpened = observation
            return observation
          }
          await explorer!.close(); report.nativeDesktopAppWindowClosed = true
          return { closed: true }
        } : undefined },
        title: 'Latest Remote isolated test', marker, nextModel: androidModel, mutateCordis,
        preset, verifyPreset: () => verifyPreset(preset), verifyDefault, verifyManagement, verifyCoding, verifyCreator, verifyProvider, verifyCatalog, verifyFiles,
        changeOfficeManagement: async (fingerprint: string) => {
          expect(officeAuthority).toBe(true)
          expect(androidDeviceId).toEqual(expect.any(String))
          const current = (await manage()).devices.find((item: { id: string }) => item.id === androidDeviceId)
          expect(current).toMatchObject({ fingerprint, name: 'DSHM latest isolated Android', status: 'active', management: true })
          await manage({ action: 'management', deviceId: androidDeviceId, enabled: false })
          const changed = (await manage()).devices.find((item: { id: string }) => item.id === androidDeviceId)
          expect(changed).toMatchObject({ fingerprint, status: 'active', management: false })
          return { status: changed.status, management: changed.management }
        },
        approve: async (fingerprint: string) => {
          let device: { id: string; fingerprint: string; name: string; status: string } | undefined
          await expect.poll(async () => {
            device = (await manage()).devices.find((item: { fingerprint: string }) => item.fingerprint === fingerprint)
            return device?.status
          }).toBe('pending')
          expect(device?.name).toBe('DSHM latest isolated Android')
          androidDeviceId = device!.id
          await manage({ action: 'approve', deviceId: androidDeviceId })
          await manage({ action: 'management', deviceId: androidDeviceId, enabled: true })
        },
        revoke: async (fingerprint: string) => {
          if (!androidDeviceId) return
          expect((await manage()).devices.find((item: { id: string }) => item.id === androidDeviceId)?.fingerprint).toBe(fingerprint)
          // 撤权竞态直接撤销设备，避免先收管理权限产生另一次断线而混淆失效原因。
          if (process.env.DSHM_LATEST_DESKTOP_RACE_CHECK !== '1' && !officeAuthority && !officeEngineLifecycle)
            await manage({ action: 'management', deviceId: androidDeviceId, enabled: false })
          await manage({ action: 'revoke', deviceId: androidDeviceId })
          const revoked = (await manage()).devices.find((item: { id: string }) => item.id === androidDeviceId)
          expect(revoked).toMatchObject({ fingerprint, status: 'revoked' })
          return { status: revoked.status, management: revoked.management }
        },
        verifyModel: async () => {
          await expect.poll(async () => (await desktopRpc('session/list', { _request: {} })).items
            .find((item: { sessionId: string }) => item.sessionId === sessionId)?.projections.values.modelSelection.next)
            .toMatchObject({ provider: provider.id, model: androidModel.id })
        } })
    }
    await markStage(process.env.DSHM_LATEST_ANDROID_CHECK === '1' ? 'android-complete' : 'pages-complete')
    const bound = await presetRead(alternate.id)
    const oldConnection = once(socket, 'close'); socket.terminate(); await oldConnection
    const reconnectedTicket = await (await api('/v1/device/ticket', claim.token)).json()
    frames.length = 0
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/v1/device/socket')
    socket.on('message', raw => frames.push(JSON.parse(raw.toString())))
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'authenticate', ticket: reconnectedTicket.ticket }))
    await receive(frame => frame.type === 'ready')
    expect(await result({ method: 'remote.presetCopy', snapshot: bound.snapshot, id: 'wrong-connection', name: 'Wrong connection' }))
      .toMatchObject({ type: 'error', code: 'remote_settings_stale' })
    report.presetSnapshotsConnectionBound = true
    const disconnected = once(socket, 'close')
    await manage({ action: 'revoke', deviceId: claim.deviceId })
    await disconnected
    expect((await api('/v1/device/ticket', claim.token)).status).toBe(401)
    // 重启时不加载 DSHM 插件或夹具；原 profile 必须能独立恢复归档声明和旧会话。
    stopHost(child); await stopped
    const restart = await launchHost()
    const restartStopped = new Promise(done => restart.once('close', (code, signal) => done({ code, signal })))
    let restartOutput = ''
    restart.stdout.setEncoding('utf8'); restart.stdout.on('data', value => { restartOutput += value })
    restart.stderr.on('data', () => {})
    try {
      await expect.poll(() => restartOutput.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1], { timeout: 45000 }).toBeTruthy()
      if (electron) {
        report.electronRestartIdentity = await verifyElectronIdentity(() => restartOutput,restart)
        report.electronRestartProfile = electronRestartProfile
      }
      const url = restartOutput.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)![1]!
      const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
      expect(login.status).toBe(303)
      const rebootCookie = login.headers.get('set-cookie')!.split(';')[0]!
      const rebootRpc = async (method: string, args: unknown) => {
        const response = await fetch(new URL('/api/' + method, url), { method: 'POST', signal: AbortSignal.timeout(15000), headers: { cookie: rebootCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })
        expect(response.status).toBe(200)
        const frame = await response.json(); expect(frame.result, JSON.stringify(frame.result)).toMatchObject({ ok: true }); return frame.result.value
      }
      expect((await rebootRpc('agentPresets/list', {})).presets.some((row: { id: string }) => row.id === copyId)).toBe(false)
      expect((await rebootRpc('agentPresets/read', { agentPreset: copyId })).content).toBe(sourceComposition.content)
      const resumed = await rebootRpc('session/prompt', { request: { sessionId: retainedSessionId, requestId: randomUUID(), mode: 'queue',
        content: [{ type: 'text', text: 'Resume archived preset after restart without DSHM plugin.' }] } })
      expect(resumed.accepted).toBe(true)
      await expect.poll(async () => (await rebootRpc('session/list', { _request: {} })).items.find((row: { sessionId: string }) => row.sessionId === retainedSessionId)?.running).toBe(false)
      expect((await rebootRpc('session/list', { _request: {} })).items.find((row: { sessionId: string }) => row.sessionId === retainedSessionId)?.projections.values.agentPreset).toBe(copyId)
      report.presetArchivedSessionResumedAfterRestartWithoutPlugin = true
    } finally { stopHost(restart); report.presetRestartStopped = await restartStopped }
    expect(stderr).not.toContain('disabling profile plugin row "dsh-mobile"')
    Object.assign(report, { passed: true, pendingDenied: true, negotiation: negotiation.value,
      emptySessionList: true, cancelledStreams: streams, managementDenied: true, settingsRead: true, providerCardRead: true,
      readinessRead: true, existingWorkspaceSessionCreated: true, mobileWorkspaceCreationDenied: true, titleSyncedToDesktop: true,
      modelSelected: true, sessionSnapshot: true, historyPage: true, promptAccepted: true, messageSyncedToDesktop: true,
      missingCredentialReported: true, inferenceVerified: false, revokedReconnectDenied: true })
  } catch (error) {
    report.passed = false; report.error = error instanceof Error ? error.message : 'test_failed'; throw error
  } finally {
    if (socket?.readyState === WebSocket.OPEN) await officeEngineControl?.cleanup()
    socket?.terminate()
    stopHost(child)
    report.stopped = await stopped
    report.stderr = stderr.replace(/https?:\/\/\S+/g, '[URL]')
    await gateway.close(); await db.close()
    await listing.close()
    await markStage('cleanup-complete')
    await writeFile(resolve(runtime, reportName + '-test.json'), JSON.stringify(report, null, 2) + '\n')
  }
}, process.env.DSHM_LATEST_FILE_FORMATS_CHECK === '1' ? 600000 : process.env.DSHM_LATEST_ANDROID_CHECK === '1' ? 300000 : 150000)
