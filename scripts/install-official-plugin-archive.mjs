import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { officialHostLifecycle } from '../tests/support/official-host-lifecycle.ts';

// 外部验收驱动只调用官方安装器和正常启动入口，不进入 DSH 进程或读取凭据内容。
assert.equal(process.argv.length, 2);
const execute = promisify(execFile), plugin = resolve(import.meta.dirname, '../../plugin');
const root = resolve(plugin, 'artifacts/official-dsh-alpha2');
const candidate = resolve(plugin, 'artifacts/official-alpha2-sdk/candidate-package-check-Alpha2PublicOnly02');
const archive = resolve(candidate, 'dsh-mobile-plugin-0.1.80-latest.0.tgz');
const profile = resolve(root, 'home/profiles/web');
const pnpm = 'F:/Program Files/nodejs/node_global/node_modules/pnpm/bin/pnpm.cjs';
const receipt = JSON.parse(await readFile(resolve(root, 'official-web-receipt.json'), 'utf8'));
assert.equal(receipt.version, '0.2.1-alpha.2'); assert.equal(receipt.stage, 'plugin-ready');
const manifest = JSON.parse(await readFile(resolve(profile, 'package.json'), 'utf8'));
const oldSpec = manifest.dependencies['@dsh-mobile/plugin'];
assert.ok(oldSpec.startsWith('link:')); assert.equal(resolve(oldSpec.slice(5)), resolve(candidate, 'package'));
const configuration = await readFile(resolve(profile, 'cordis.patch.yml'));
const archiveBytes = await readFile(archive);
assert.equal(createHash('sha256').update(archiveBytes).digest('hex'),
  '781f92efff24ef4343f388e89615cd96ad3f5032d4510a01d6f5c91f6a382ed7');
Object.assign(process.env, { DSHM_OFFICIAL_ALPHA2_CHECK: '1',
  DSHM_OFFICIAL_OWNED_LAUNCH_PID: String(receipt.pid), DSHM_OFFICIAL_RESTART_PNPM_CLI: pnpm });
const lifecycle = officialHostLifecycle(root, receipt), run = randomUUID();
const reportPath = resolve(plugin, 'artifacts/official-plugin-only', `archive-install-${run}.json`);
const report = { run, at: new Date().toISOString(), version: receipt.version, pluginVersion: '0.1.80-latest.0',
  archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'),
  entry: 'pnpm dsh plugin --profile web add <owned-tgz>', passed: false,
  productsBuilt: false, dshModified: false, credentialContentsRead: false };
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const install = async (spec, phase) => {
  const result = await execute(process.execPath, [pnpm, 'dsh', 'plugin', '--profile', 'web', 'add', spec],
    { cwd: root, env: { ...process.env, DSH_HOME: resolve(root, 'home') }, windowsHide: true,
      timeout: 240000, maxBuffer: 2 * 1024 * 1024 });
  // 安装日志不含模型凭据；原始输出留在本项目，终端只显示结算状态。
  await writeFile(resolve(plugin, 'artifacts/official-plugin-only', `archive-install-${run}-${phase}.log`),
    result.stdout + result.stderr, { flag: 'wx' });
};
try {
  report.stop = await lifecycle.stop(); await save();
  await install(archive, 'archive'); report.installerExitCode = 0;
  const installedManifest = JSON.parse(await readFile(resolve(profile, 'package.json'), 'utf8'));
  assert.notEqual(installedManifest.dependencies['@dsh-mobile/plugin'], oldSpec);
  report.installedSpec = installedManifest.dependencies['@dsh-mobile/plugin'];
  const installed = await realpath(resolve(profile, 'node_modules/@dsh-mobile/plugin'));
  report.installedPath = installed;
  assert.notEqual(installed, await realpath(resolve(candidate, 'package')));
  const location = relative(profile, installed);
  assert.ok(!isAbsolute(location) && !location.startsWith('..'));
  // 官方 profile 的 pnpm 布局也可以是 hoisted；实际安装文件必须属于 profile，不能仍链接开发目录。
  assert.ok(location.replaceAll('\\', '/').startsWith('node_modules/'));
  const tar = async args => (await execute('C:/Windows/System32/tar.exe', args,
    { cwd: candidate, windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  const files = (await tar(['-tzf', archive])).trim().split(/\r?\n/);
  assert.equal(files.length, 63);
  for (const file of files) {
    assert.ok(file.startsWith('package/') && !file.includes('..'));
    assert.equal(await readFile(resolve(installed, file.slice(8)), 'utf8'), await tar(['-xOf', archive, file]));
  }
  report.installedCacheBytesCompared = true; report.filesCompared = files.length;
  report.start = await lifecycle.start(); await save();
  const log = await readFile(report.start.privateLog, 'utf8');
  const url = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1];
  assert.equal(new URL(url).origin, 'http://127.0.0.1:16958');
  const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const rpcId = randomUUID(), method = 'pluginManager/listBundles';
  const response = await fetch('http://127.0.0.1:16958/api/' + method, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: {} } }),
    signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const frame = await response.json(); assert.equal(frame.result.ok, true);
  const bundle = frame.result.value.find(item => item.name === '@dsh-mobile/plugin');
  assert.equal(bundle.version, report.pluginVersion); assert.equal(bundle.installed, true); assert.equal(bundle.enabled, true);
  assert.deepEqual(await readFile(resolve(profile, 'cordis.patch.yml')), configuration);
  report.profileConfigurationUnchanged = true;
  const stateResponse = await fetch('http://127.0.0.1:16958/api/dsh-mobile', { headers: { cookie } });
  assert.equal(stateResponse.status, 200); assert.equal((await stateResponse.json()).enabled, false);
  report.officialPluginInventoryVerified = true; report.remoteDisabled = true; report.passed = true;
} catch (error) {
  report.failure = error.message;
  // 只在安装失败时由同一官方安装器恢复原链接；不覆盖 profile 或官方包文件。
  if (lifecycle.isStopped()) {
    try { await install(resolve(candidate, 'package'), 'recovery'); report.originalLinkRestored = true; }
    catch (restoreError) { report.restoreFailure = restoreError.message; }
    try { report.recoveredStart = await lifecycle.start(); }
    catch (startError) { report.restartFailure = startError.message; }
  }
  throw error;
} finally {
  await save();
  console.log(JSON.stringify({ run, passed: report.passed, filesCompared: report.filesCompared,
    installedCacheBytesCompared: report.installedCacheBytesCompared, productsBuilt: false,
    dshModified: false, reportPath }));
}
