// 独立新版真实模型联调；本机 stdin 控制，没有新增公网管理路由。
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { PGlite } from '@electric-sql/pglite';
import { buildGateway } from '../packages/gateway/dist/app.js';
import { Store } from '../packages/gateway/dist/store.js';
import { latestLiveFlags, readLatestLiveResume } from './latest-live-resume.mjs';
import { readLatestSdkCarrier } from './latest-sdk-carrier.mjs';

const backend = resolve(import.meta.dirname, '..');
const runtime = resolve(backend, '../plugin/artifacts/latest-runtime-check');
const mode = latestLiveFlags(process.argv.slice(2));
const resumed = mode.resume ? await readLatestLiveResume(runtime, {electronStartupRetry:mode.electronRetry ?? false,
  electronStartupAttempt:mode.electronAttempt ?? 1,recoverStopped:mode.recoverStopped ?? false}) : undefined;
const sdk = mode.sdkSea ? await readLatestSdkCarrier(runtime) : undefined;
const executionMode = mode.electron ? 'electron' : sdk ? 'sdk-sea' : mode.source ? 'source' : 'release';
let source;
if (mode.source) {
  const { sourceRoot } = await import('../../plugin/compatibility/latest-upstream/source-runtime.mjs');
  const { verifyInstalledSource } = await import('../../plugin/compatibility/latest-upstream/source-host.mjs');
  const lease = JSON.parse(await readFile(resolve(runtime, 'latest-live-source-lease.json'), 'utf8'));
  assert.equal(lease.state, 'ready'); assert.equal(lease.sourceRoot, sourceRoot);
  source = { root: sourceRoot, ...await verifyInstalledSource() };
  assert.equal(source.sourceCommit, lease.sourceCommit);
  assert.deepEqual(source.clientArtifacts, lease.patchedClientArtifacts);
}
const home = resumed?.state.home ?? resolve(runtime, 'live-homes', randomUUID());
const electron = mode.electron ? await (await import('../../plugin/scripts/prepare-latest-electron-project.mjs'))
  .prepareLatestElectronProject(runtime, home, {retry:mode.electronRetry ?? false,attempt:mode.electronAttempt ?? 1,
    encodingUpgrade:mode.electronEncoding ?? false}) : undefined;
const workspacePath = resolve(home, 'test-project');
if (!resumed) {
  await mkdir(workspacePath, { recursive: true });
  await writeFile(resolve(workspacePath, 'README.md'), '# DSHM 新版真实执行验收\n\n只操作本测试工作区。\n');
}
if (!mode.source && !sdk && !electron) for (const [module, method] of [['pending-observer', 'prepareLatestPendingObserver'],
  ['foreground-observer', 'prepareLatestForegroundObserver'], ['client-entries', 'prepareLatestClientEntries'],
  ['cordis-scopes', 'prepareLatestCordisScopes'], ['cordis-client-lifetime', 'prepareLatestCordisClientLifetime'],
  ['preset-archive', 'prepareLatestPresetArchive'], ['model-discovery', 'prepareLatestModelDiscovery'],
  ['tool-cancellation', 'prepareLatestToolCancellation'], ['package-management', 'prepareLatestPackageProcess'],
  ['package-management', 'prepareLatestPluginRestartNotice']])
  await (await import(pathToFileURL(resolve(runtime, '../../compatibility/latest-upstream', module + '.mjs'))))[method]();
if (!mode.source && !sdk && !electron) {
  const desktop = await import(pathToFileURL(resolve(runtime, '../../compatibility/latest-upstream/desktop-apps.mjs')));
  await desktop.prepareLatestDesktopApps(); await desktop.installLatestDesktopApps('apply');
}
const overlay = resolve(home, 'plugin.patch.json');
const expectedOverlay = [{ insert: [{ id: 'dsh-mobile', name: pathToFileURL(resolve(runtime, 'candidate/dist/index.js')).href }] }];
if (resumed) assert.deepEqual(JSON.parse(await readFile(overlay, 'utf8')), expectedOverlay);
else await writeFile(overlay, JSON.stringify(expectedOverlay));
let hostOverlay = overlay;
if (mode.reviewCandidate) {
  // 临时消费已核验归档的独立入口；原包、原正常overlay及凭据保持。
  const review = resolve(runtime, mode.reviewCandidate), report = JSON.parse(await readFile(resolve(review, 'report.json'), 'utf8'));
  assert.equal(await realpath(review), review); assert.equal(report.output, review);
  assert.equal(report.passed, true); assert.equal(report.targetVersion, '0.2.1-alpha.1');
  assert.equal(report.installedPackage.payloadBytesIdentical, true); assert.equal(report.installedPackage.hostAndClientTypes, true);
  const tarball = resolve(review, 'dsh-mobile-plugin-0.1.76-latest.0.tgz'); assert.equal(report.package.path, tarball);
  assert.equal(createHash('sha256').update(await readFile(tarball)).digest('hex'), report.package.sha256);
  if (sdk) {
    const integrity = JSON.parse(await readFile(resolve(review, 'source-integrity-recheck.json'), 'utf8'));
    assert.equal(integrity.passed, true); assert.equal(integrity.currentSourcesIdentical, true);
    assert.equal(integrity.sourceFiles.length, 55);
    const sourceRoot = await realpath(resolve(runtime, '../../src'));
    for (const source of integrity.sourceFiles) {
      const path = resolve(sourceRoot, source.path), within = relative(sourceRoot, path);
      assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
      assert.equal(await realpath(path), path);
      assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), source.sha256);
    }
  }
  const entry = resolve(review, 'consumer/node_modules/@dsh-mobile/plugin/dist/index.js'); assert.equal(await realpath(entry), entry);
  const built = resolve(review, 'package/dist/index.js');
  assert.deepEqual(await readFile(entry), await readFile(built));
  hostOverlay = resolve(home, 'candidate-review.patch.json');
  await writeFile(hostOverlay, JSON.stringify([{ insert: [{ id: 'dsh-mobile', name: pathToFileURL(entry).href }] }]));
}
if (process.argv.includes('--diagnose-install-timeout')) {
  // 只缩短原管理器的等待时间，不替换安装器、运行记录或结果分类。
  hostOverlay = resolve(home, 'install-timeout-diagnostic.patch.json');
  await writeFile(hostOverlay, JSON.stringify([...expectedOverlay,
    { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', config: { idleTimeoutMs: 10000 } }]));
}
if (process.argv.includes('--diagnose-subagent-depth')) {
  // 原服务默认深度1；只在已有专用home以官方配置启用两层，不更改用户配置或沙箱。
  hostOverlay = resolve(home, 'subagent-depth-diagnostic.patch.json');
  await writeFile(hostOverlay, JSON.stringify([...expectedOverlay,
    { id: 'subagent', name: '@deepseek-ai/dsh-subagent', config: { maxDepth: 2 } }]));
}
if (process.argv.includes('--diagnose-output')) {
  hostOverlay = resolve(home, 'output-diagnostic.patch.json');
  await writeFile(hostOverlay, JSON.stringify([{ insert: [...expectedOverlay[0].insert,
    { id: 'latest-output-diagnostic', name: pathToFileURL(resolve(backend, 'tests/support/latest-output-diagnostic/index.mjs')).href }] }]));
}
if (process.argv.includes('--diagnose-blocked')) {
  hostOverlay = resolve(home, 'blocked-diagnostic.patch.json');
  await writeFile(hostOverlay, JSON.stringify([{ insert: [...expectedOverlay[0].insert,
    { id: 'latest-blocked-diagnostic', name: pathToFileURL(resolve(backend, 'tests/support/latest-blocked-diagnostic/index.mjs')).href }] }]));
}
if (process.argv.includes('--diagnose-auto-review') || process.argv.includes('--diagnose-auto-review-never')) {
  if (!source) await (await import('../../plugin/compatibility/latest-upstream/auto-review-cancel.mjs')).prepareLatestAutoReviewCancellation();
  const autoRoot = source ? resolve(source.root, 'packages/experimental/auto-review')
    : resolve(runtime, 'node_modules/@deepseek-ai/dsh-experimental-auto-review');
  const metadata = JSON.parse(await readFile(resolve(autoRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@deepseek-ai/dsh-experimental-auto-review'); assert.equal(metadata.version, '0.2.1-alpha.1');
  hostOverlay = resolve(home, 'auto-review-diagnostic.patch.json');
  await writeFile(hostOverlay, JSON.stringify([{ insert: [...expectedOverlay[0].insert,
    { id: 'auto-review', name: pathToFileURL(resolve(autoRoot, 'lib/index.js')).href },
    { id: 'latest-auto-review-observer', name: pathToFileURL(resolve(backend, 'tests/support/latest-auto-review-observer/index.mjs')).href },
    ...(process.argv.includes('--diagnose-auto-review-never') ? [{ id: 'latest-auto-review-policy',
      name: pathToFileURL(resolve(backend, 'tests/support/latest-auto-review-policy/index.mjs')).href }] : [])] }]));
}
const db = new PGlite(resolve(home, 'gateway-db'));
const store = new Store({ query: (sql, values) => db.query(sql, values),
  transaction: work => db.transaction(tx => work({ query: (sql, values) => tx.query(sql, values) })), close: () => db.close() });
await store.migrate();
// 先保留随机端口，再将真实公网契约的 origin 固定到本轮服务。
const { createServer } = await import('node:net');
const reservation = createServer().listen(resumed?.port ?? 0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(done => reservation.close(done));
const origin = 'http://127.0.0.1:' + port;
const gateway = await buildGateway({ store, publicOrigin: origin, registrationMode: 'open' });
await gateway.listen({ host: '127.0.0.1', port });
const env = { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' };
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMFILES'])
  if (process.env[key] !== undefined) env[key] = process.env[key];
if (electron) Object.assign(env, {DSH_DESKTOP_DSH_DIR:electron.project,DSH_DESKTOP_PRIMARY_RUNTIME_DIR:electron.primary,
  DSH_DESKTOP_OPEN_DEVTOOLS:'0',DSH_DESKTOP_DIAGNOSTIC_FILE:resolve(electron.directory,'private-startup-error.txt')});
const hostCwd = electron?.app ?? sdk?.root ?? source?.root ?? runtime;
const child = spawn(electron?.executable ?? sdk?.executable ?? process.execPath, electron ? [
  `--inspect=127.0.0.1:${electron.mainPort}`,`--remote-debugging-port=${electron.rendererPort}`,
  `--user-data-dir=${electron.userData}`,electron.app] : [...(sdk ? ['web']
  : source ? [resolve(source.root, 'node_modules/pnpm/bin/pnpm.cjs'), 'dsh', 'web']
  : [resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web']),
  '--patch', hostOverlay, '--host', '127.0.0.1', '--port', '0', '--no-open'],
{ cwd: hostCwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const closed = once(child, 'close');
let output = '', hostFailed = false, stopping = false;
child.stdout.on('data', chunk => { output += chunk; });
// 日志可能包含模型或凭据上下文，不输出原日志到控制终端。
child.stderr.on('data', () => {});
child.once('close', (code, signal) => {
  hostFailed = true;
  // 只记录进程退出身份与状态，不保留可能含模型正文或凭据的stdout/stderr。
  void writeFile(resolve(home, 'host-exit-' + child.pid + '.json'), JSON.stringify({ at: new Date().toISOString(),
    hostPid: child.pid, executionMode, code, signal, stopRequested: stopping }), { flag: 'wx' })
    .catch(() => { process.stderr.write('latest_live_host_exit_audit_write_failed\n'); });
});
async function cleanup() {
  if (stopping) return;
  stopping = true;
  try {
    if (child.exitCode === null && child.signalCode === null) {
      // pnpm拥有真正的Node Host；只结束本次spawn的树，不能留下占用原home的子进程。
      if ((source || electron) && process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { cwd: hostCwd, windowsHide: true, stdio: 'ignore' }); }
        catch (error) {
          let exited = false;
          try { process.kill(child.pid, 0); } catch (probe) { if (probe.code !== 'ESRCH') throw probe; exited = true; }
          if (!exited) throw error;
        }
      } else child.kill();
    }
    await closed;
  } finally { await gateway.close(); await db.close(); }
  await writeFile(resolve(home, 'cleanup.json'), JSON.stringify({ at: new Date().toISOString(), hostPid: child.pid, stopped: true }));
}
process.once('SIGINT', () => { void cleanup().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void cleanup().then(() => process.exit(0)); });
try {
const deadline = Date.now() + 45000;
let electronReady;
while (!output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
  || electron && !output.match(/dshm electron identity: (\{[^\n]+\})/)) {
  assert.ok(!hostFailed && Date.now() < deadline, 'latest_live_host_start_failed');
  await new Promise(done => setTimeout(done, 50));
}
if (electron) {
  electronReady=JSON.parse(output.match(/dshm electron identity: (\{[^\n]+\})/)[1]);
  assert.equal(electronReady.home,home);assert.equal(electronReady.electron,'44.0.0');
  assert.equal(electronReady.parentPid,child.pid);
  assert.ok(Number.isSafeInteger(electronReady.hostPid) && electronReady.hostPid > 0);
}
const loginURL = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)[1];
const login = await fetch(loginURL, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 303);
const cookie = login.headers.get('set-cookie').split(';')[0];
const call = async (path, body) => {
  const response = await fetch(new URL(path, loginURL), { method: body === undefined ? 'GET' : 'POST',
    signal: AbortSignal.timeout(15000), headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(response.status, 200, 'latest_live_request_' + response.status);
  return response.json();
};
const manage = body => call('/api/dsh-mobile', body);
const rpc = async (method, args) => {
  const rpcId = randomUUID();
  const frame = await call('/api/' + method, { type: 'client-request', rpcId, method, payload: { args } });
  assert.equal(frame.rpcId, rpcId); assert.equal(frame.result.ok, true, 'latest_live_rpc_failed');
  return frame.result.value;
};
let sessionId;
if (resumed) {
  assert.equal(origin, resumed.state.origin);
  const end = Date.now() + 45000;
  let current;
  do {
    current = await manage();
    assert.equal(current.configured, true); assert.equal(current.enabled, true);
    assert.equal(current.origin, origin);
    if (current.connection === 'online') break;
    assert.ok(!hostFailed && Date.now() < end, 'latest_live_resume_connection_failed');
    await new Promise(done => setTimeout(done, 100));
  } while (true);
  sessionId = resumed.state.sessionId;
  const row = (await rpc('session/list', { _request: {} })).items.find(item => item.sessionId === sessionId);
  assert.ok(row); assert.equal(resolve(row.cwd), workspacePath); assert.equal(row.running, false);
} else {
  await manage({ action: 'setup', origin, name: 'DSHM 新版真实执行测试电脑' });
  await manage({ action: 'enable' });
  const registered = await rpc('workspace/create', { request: { path: workspacePath } });
  sessionId = 'latest-live-' + randomUUID();
  await rpc('session/create', { request: { workspaceId: registered.workspace.workspaceId, sessionId } });
  await rpc('session/rename', { request: { sessionId, title: 'DSHM 新版真实模型验收' } });
}
// 仅登录入口存本机忽略目录，cookie/设备票据留在内存；从不读取用户原环境或 Key。
await writeFile(resolve(home, 'private-entry.json'), JSON.stringify({ loginURL }), { mode: 0o600 });
await writeFile(resolve(runtime, 'latest-live-state.json'), JSON.stringify({ ...resumed?.state, at: new Date().toISOString(),
  home, workspacePath, origin, sessionId, supervisorPid: process.pid, hostPid: child.pid,
  target: '0.2.1-alpha.1', ready: true, inferenceVerified: resumed?.state.inferenceVerified ?? false,
  executionMode, command: electron ? 'official Electron desktop main' : sdk ? 'SDK executable web' : source ? 'pnpm dsh web' : 'node dsh/lib/bin.js web',
  sourceCommit: electron ? electron.sourceCommit : sdk?.sourceCommit ?? source?.sourceCommit,
  sourceRoot: electron ? electron.app : sdk?.sourceRoot ?? source?.root,
  electronCarrier: electron ? {...electron,electronHostPid:electronReady.hostPid} : undefined,
  sdkProduct: sdk ? { executable: sdk.executable, sha256: sdk.productSha256, buildReport: sdk.buildReport } : undefined,
  reviewCandidate: mode.reviewCandidate,
  subagentDepthDiagnostic: process.argv.includes('--diagnose-subagent-depth'),
  outputDiagnostic: process.argv.includes('--diagnose-output'),
  blockedDiagnostic: process.argv.includes('--diagnose-blocked'),
  autoReviewDiagnostic: process.argv.includes('--diagnose-auto-review') || process.argv.includes('--diagnose-auto-review-never'),
  autoReviewPolicyDiagnostic: process.argv.includes('--diagnose-auto-review-never'),
  installTimeoutDiagnostic: process.argv.includes('--diagnose-install-timeout'),
  resumed: !!resumed, ...(resumed ? { previousHostPid: resumed.state.hostPid } : {}) }, null, 2));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
emit({ ready: true, home, workspacePath, origin, sessionId, hostPid: child.pid, executionMode });
const allowedRpc = new Set(['session/list', 'session/projections', 'session/page', 'session/prompt',
  'session/stop', 'agentPresets/list', 'agentPresets/select', 'session/modelCatalog']);
  for await (const raw of createInterface({ input: process.stdin })) {
    try {
      const request = JSON.parse(raw);
      if (request.action === 'stop') break;
      if (request.action === 'status') {
        const state = await manage(); emit({ connection: state.connection, devices: state.devices });
      } else if (request.action === 'pair') {
        const paired = await manage({ action: 'pair' });
        await writeFile(resolve(home, 'private-pair.json'), JSON.stringify({ link: paired.link }), { mode: 0o600 });
        emit({ pairingReady: true });
      } else if (request.action === 'approve') {
        assert.match(request.fingerprint, /^[A-Za-z0-9_-]{43}$/);
        const device = (await manage()).devices.find(row => row.fingerprint === request.fingerprint);
        assert.equal(device?.name, 'DSHM latest model validation'); assert.equal(device.status, 'pending');
        await manage({ action: 'approve', deviceId: device.id }); emit({ approved: true, fingerprint: request.fingerprint });
      } else if (request.action === 'revoke') {
        assert.match(request.fingerprint, /^[A-Za-z0-9_-]{43}$/);
        const device = (await manage()).devices.find(row => row.fingerprint === request.fingerprint);
        assert.equal(device?.name, 'DSHM latest model validation');
        await manage({ action: 'revoke', deviceId: device.id }); emit({ revoked: true });
      } else if (request.action === 'rpc') {
        assert.ok(allowedRpc.has(request.method), 'latest_live_method_not_allowed');
        emit({ method: request.method, value: await rpc(request.method, request.args) });
      } else throw Error('latest_live_unknown_action');
    } catch (error) { emit({ error: error.message }); }
  }
} finally { await cleanup(); }
// 准备源码载荷的tsx/esbuild服务可能仍持有句柄；owned Host、网关和DB清理后结束本测试控制器。
process.exit(0);
