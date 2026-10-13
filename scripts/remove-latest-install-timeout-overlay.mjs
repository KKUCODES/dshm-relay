// 只移除已完成真实手机验收并停止的隔离安装超时配置。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLatestLiveResume } from './latest-live-resume.mjs';

const flags = process.argv.slice(2);
assert.ok(flags.length <= 2 && new Set(flags).size === flags.length);
assert.ok(flags.every(flag => flag === '--script' || /^--attempt-[2-9]$/.test(flag)));
const script = flags.includes('--script'), attempt = flags.find(flag => /^--attempt-[2-9]$/.test(flag));
const runtime = resolve(import.meta.dirname, '../../plugin/artifacts/latest-runtime-check');
const { state } = await readLatestLiveResume(runtime);
assert.equal(state.installTimeoutDiagnostic, true); assert.equal(state.autoReviewDiagnostic, false);
assert.ok(['source', 'release'].includes(state.executionMode));
const prefix = script ? `latest-live-${state.executionMode === 'source' ? 'source-' : ''}script-timeout${attempt?.replace('--', '-') ?? ''}`
  : `latest-live-${state.executionMode}-repair-timeout${attempt?.replace('--', '-') ?? ''}`;
const result = JSON.parse(await readFile(resolve(runtime, prefix + '.json'), 'utf8'));
assert.equal(result.home, state.home); assert.equal(script ? result.previousHostPid : result.hostPid, state.hostPid);
const fields = script ? ['passed', 'originalTimeoutClassified', 'scriptTimeoutVisible', 'scriptExitedBeforeConfirmation',
  'failedReceipt', 'originalProfileRestored', 'managementRestored', 'primaryRestored', 'originalHistoryPreserved', 'originalProjectionPreserved']
  : ['passed', 'originalTimeoutClassified', 'repairFailureDiagnosticVisible', 'processesGoneBeforeConfirmation',
    'writesStoppedBeforeConfirmation', 'failedReceipt', 'originalProfileRestored',
    'managementRestored', 'primaryRestored', 'historyAndProjectionPreserved'];
for (const field of fields) assert.equal(result[field], true);
if (script) {
  const cleanup = JSON.parse(await readFile(resolve(runtime, prefix + '-cleanup.json'), 'utf8'));
  assert.equal(cleanup.home, state.home); assert.equal(cleanup.hostPid, state.hostPid);
  for (const field of ['passed', 'installedTestPackageRemoved', 'originalProfileRestored']) assert.equal(cleanup[field], true);
}
for (const pid of result.processes) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
const profile = resolve(state.home, 'profiles/web');
const names = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const hashes = await Promise.all(names.map(async name => createHash('sha256').update(await readFile(resolve(profile, name))).digest('hex')));
assert.deepEqual(hashes, result.originalProfileHashes);
await assert.rejects(access(resolve(profile, '.plugin-manager/run.json')), { code: 'ENOENT' });
const overlay = resolve(state.home, 'install-timeout-diagnostic.patch.json');
const bytes = await readFile(overlay);
const normal = [{ insert: [{ id: 'dsh-mobile', name: pathToFileURL(resolve(runtime, 'candidate/dist/index.js')).href }] }];
assert.deepEqual(JSON.parse(bytes), [...normal,
  { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', config: { idleTimeoutMs: 10000 } }]);
assert.deepEqual(JSON.parse(await readFile(resolve(state.home, 'plugin.patch.json'), 'utf8')), normal);
const path = resolve(runtime, prefix + '-overlay-removed.json');
await assert.rejects(access(path), { code: 'ENOENT' });
assert.deepEqual(await readFile(overlay), bytes); await unlink(overlay);
await assert.rejects(access(overlay), { code: 'ENOENT' });
const report = { passed: true, home: state.home, executionMode: state.executionMode,
  hostPid: state.hostPid, hostStopped: true, overlayRemoved: true, originalProfilePreserved: true };
await writeFile(path, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ passed: true, executionMode: state.executionMode, overlayRemoved: true }));
