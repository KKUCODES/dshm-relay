import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { expect, onTestFinished, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import WebSocket from 'ws'
import { clientFrameSchema } from '@dsh-mobile/protocol'
import { buildGateway } from '../packages/gateway/src/app.js'
import { Store } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'
import { clientKey, proof } from './support/proof.js'
import { latestHostCleanup } from './support/latest-host-cleanup.js'

// 只消费已经由原CLI安装的归档，不构建/覆盖持续运行的candidate。
test.skipIf(!process.env.DSHM_REVIEW_PACKAGE)('真实候选tgz安装后的原Host经中转同步会话、模型和消息并撤销设备', async () => {
  const folder = process.env.DSHM_REVIEW_PACKAGE!
  expect(folder).toMatch(/^candidate-package-check-[A-Za-z0-9]+$/)
  const runtime = resolve('../plugin/artifacts/latest-runtime-check')
  const packRoot = resolve(runtime, folder), home = resolve(packRoot, 'installed-home')
  expect(await realpath(home)).toBe(home)
  const packed = JSON.parse(await readFile(resolve(packRoot, 'report.json'), 'utf8'))
  const installation = JSON.parse(await readFile(resolve(packRoot, 'install-report.json'), 'utf8'))
  const hostCheck = JSON.parse(await readFile(resolve(packRoot, 'installed-host-report.json'), 'utf8'))
  expect(packed.passed).toBe(true); expect(installation.passed).toBe(true); expect(hostCheck.passed).toBe(true)
  expect(installation.home).toBe(home); expect(hostCheck.home).toBe(home)
  assert.throws(() => process.kill(hostCheck.launcherPid, 0), error => (error as NodeJS.ErrnoException).code === 'ESRCH')
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  expect(sha(await readFile(resolve(packRoot, 'dsh-mobile-plugin-0.1.76-latest.0.tgz')))).toBe(packed.package.sha256)
  const installedEntry = resolve(home, 'profiles/web/node_modules/@dsh-mobile/plugin/dist/index.js')
  expect(await readFile(installedEntry)).toEqual(await readFile(resolve(packRoot, 'consumer/node_modules/@dsh-mobile/plugin/dist/index.js')))
  // 此home此前仅验证空历史；不接入已有配对或Key，且本专项只能运行一次。
  await assertAbsent(resolve(home, 'review-relay-used.json'))
  await writeFile(resolve(home, 'review-relay-used.json'), JSON.stringify({ at: new Date().toISOString() }), { flag: 'wx' })
  await mkdir(resolve('.test-data'), { recursive: true })
  const output = await mkdtemp(resolve('.test-data/latest-review-relay-'))
  const report: Record<string, unknown> = { at: new Date().toISOString(), passed: false, archiveSha256: packed.package.sha256,
    home, output, realInstalledPackage: true, inferenceVerified: false, androidVerified: false }
  const db = new PGlite(), store = new Store(pgliteDatabase(db))
  await store.migrate()
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string') throw Error('missing_gateway_port')
  await new Promise<void>(done => reservation.close(() => done()))
  const origin = `http://127.0.0.1:${address.port}`
  const gateway = await buildGateway({ store, publicOrigin: origin, registrationMode: 'open' })
  await gateway.listen({ host: '127.0.0.1', port: address.port })
  const env: NodeJS.ProcessEnv = { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMFILES'])
    if (process.env[key] !== undefined) env[key] = process.env[key]
  const hosts = new Set<ReturnType<typeof spawn>>()
  const stopHost = latestHostCleanup(hosts, true, resolve('.'))
  const child = spawn(process.execPath, [resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  hosts.add(child)
  report.launcherPid = child.pid
  const closed = once(child, 'close')
  let stdout = '', stderr = '', socket: WebSocket | undefined
  child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', value => { stdout += value }); child.stderr!.on('data', value => { stderr += value })
  onTestFinished(async () => { socket?.terminate(); await gateway.close(); await db.close() })
  try {
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
      const response = await fetch(new URL('/api/' + method, entry), { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(15000) })
      expect(response.status).toBe(200); const frame = await response.json(); expect(frame.result.ok).toBe(true); return frame.result.value
    }
    expect((await manage()).configured).toBe(false)
    expect((await desktop('session/list', { _request: {} })).items).toEqual([])
    await manage({ action: 'setup', origin, name: 'Archive Remote verification' }); await manage({ action: 'enable' })
    await expect.poll(async () => (await manage()).connection, { timeout: 15000 }).toBe('online')
    const pairing = await manage({ action: 'pair' })
    const key = new URLSearchParams(new URL(pairing.link).hash.slice(1)).get('key')
    const identity = await clientKey()
    const api = async (path: string, token?: string, body?: unknown) => fetch(origin + path, { method: 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), dpop: await proof(identity, origin + path, 'POST', token),
        ...(token ? { authorization: 'DPoP ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
    const claimed = await api('/v1/pairings/claim', undefined, { key, name: 'Archive protocol client' })
    expect(claimed.status).toBe(201); const claim = await claimed.json()
    expect((await api('/v1/device/ticket', claim.token)).status).toBe(403)
    await manage({ action: 'approve', deviceId: claim.deviceId })
    const ticketResponse = await api('/v1/device/ticket', claim.token)
    expect(ticketResponse.status).toBe(200); const { ticket } = await ticketResponse.json()
    const frames: any[] = []
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/v1/device/socket')
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())))
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'authenticate', ticket }))
    const receive = async (matches: (frame: any) => boolean) => {
      await expect.poll(() => frames.some(matches), { timeout: 15000 }).toBe(true)
      return frames.splice(frames.findIndex(matches), 1)[0]
    }
    await receive(frame => frame.type === 'ready')
    const request = (operation: unknown) => {
      const id = randomUUID(); socket!.send(JSON.stringify(clientFrameSchema.parse({ type: 'request', id, operation }))); return id
    }
    const result = async (operation: unknown) => { const id = request(operation); return receive(frame => frame.id === id) }
    const rpc = (endpoint: string, args: unknown) => result({ method: 'remote.rpc', endpoint, payload: { args } })
    expect(await result({ method: 'remote.negotiate', version: 2 })).toMatchObject({ type: 'result', value: { dshVersion: '0.2.1-alpha.1', management: false } })
    expect(await result({ method: 'remote.settingsRead' })).toMatchObject({ type: 'error', code: 'management_required' })
    const workspacePath = resolve(home, 'archive-test-project'); await mkdir(workspacePath)
    const registered = await desktop('workspace/create', { request: { path: workspacePath } })
    const sessionId = 'archive-relay-' + randomUUID()
    expect(await rpc('workspace/create', { request: { path: workspacePath } })).toMatchObject({ type: 'error', code: 'remote_operation_denied' })
    expect(await rpc('session/create', { request: { workspaceId: registered.workspace.workspaceId, sessionId } }))
      .toMatchObject({ type: 'result', value: { ok: true, value: { sessionId } } })
    const catalog = await rpc('session/modelCatalog', {})
    expect(catalog).toMatchObject({ type: 'result', value: { ok: true } })
    const provider = catalog.value.value.groups.find((row: any) => row.id === 'deepseek-official')
    const model = provider.models[0].id
    expect(await rpc('session/selectModel', { request: { sessionId, provider: provider.id, model } }))
      .toMatchObject({ type: 'result', value: { ok: true, value: { selected: { provider: provider.id, model } } } })
    expect((await desktop('session/list', { _request: {} })).items.find((row: any) => row.sessionId === sessionId))
      .toMatchObject({ projections: { values: { modelSelection: { next: { provider: provider.id, model } } } } })
    const follow = request({ method: 'remote.stream', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } })
    expect(await receive(frame => frame.id === follow)).toMatchObject({ type: 'event', value: { type: 'snapshot',
      projections: { values: { modelSelection: { next: { provider: provider.id, model } } } } } })
    const marker = 'DSHM_ARCHIVE_SYNC_' + randomUUID()
    expect(await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: marker }] } }))
      .toMatchObject({ type: 'result', value: { ok: true, value: { accepted: true } } })
    await receive(frame => frame.id === follow && JSON.stringify(frame.value).includes(marker))
    await expect.poll(async () => (await desktop('session/list', { _request: {} })).items.find((row: any) => row.sessionId === sessionId)?.running,
      { timeout: 15000 }).toBe(false)
    socket.send(JSON.stringify({ type: 'cancel', id: follow }))
    const reopened = request({ method: 'remote.stream', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } })
    const snapshot = await receive(frame => frame.id === reopened)
    const history = await desktop('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: snapshot.value.cursor, maxMessages: 30 } })
    expect(JSON.stringify(snapshot.value.records)).toContain(marker)
    expect(JSON.stringify(history)).toContain(marker)
    expect(JSON.stringify(snapshot.value.records)).toContain('MISSING_CREDENTIAL')
    socket.send(JSON.stringify({ type: 'cancel', id: reopened }))
    const revoked = once(socket, 'close'); await manage({ action: 'revoke', deviceId: claim.deviceId }); await revoked
    expect((await api('/v1/device/ticket', claim.token)).status).toBe(401)
    expect(stderr).not.toContain('disabling profile plugin row "dsh-mobile"')
    Object.assign(report, { passed: true, pendingDenied: true, existingWorkspaceSession: true, workspaceCreationDenied: true,
      modelSynced: true, messagePersisted: true, streamCancelled: true, managementDenied: true, revokedReconnectDenied: true })
  } catch (error) { report.failure = error instanceof Error ? error.message : 'verification_failed'; throw error }
  finally {
    socket?.terminate(); stopHost(child); report.stopped = await closed
    assert.throws(() => process.kill(child.pid!, 0), error => (error as NodeJS.ErrnoException).code === 'ESRCH')
    report.launcherStopped = true
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ output, passed: report.passed, inferenceVerified: false, androidVerified: false }))
  }
}, 90000)

async function assertAbsent(path: string) {
  try { await access(path); throw Error('review_home_already_used') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
