// 只移除已完成权限恢复、控制器已停止的隔离 Auto 诊断配置。
import assert from 'node:assert/strict';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLatestLiveResume } from './latest-live-resume.mjs';

const allow = process.argv[2] === '--allow';
const denial = process.argv[2] === '--denial';
const planDenial = process.argv[2] === '--plan-denial';
const never = process.argv[2] === '--never';
assert.ok(process.argv.length === 2 || process.argv.length === 3 && (allow || denial || planDenial || never));
const runtime = resolve(import.meta.dirname, '../../plugin/artifacts/latest-runtime-check');
const { state } = await readLatestLiveResume(runtime);
assert.equal(state.autoReviewDiagnostic, true);
assert.ok(['source', 'release'].includes(state.executionMode));
assert.equal(state.autoReviewPolicyDiagnostic === true, never);
const prefix = 'latest-live-' + (state.executionMode === 'source' ? 'source-' : '') + (allow ? 'auto-allow' : denial ? 'auto-deny-ask' : planDenial ? 'auto-deny-plan' : never ? 'auto-deny-never' : 'auto-review');
const seed = JSON.parse(await readFile(resolve(runtime, prefix + '-seed.json'), 'utf8'));
assert.equal(seed.never === true, never);
assert.ok(seed.cleanupPhase === undefined || planDenial && seed.cleanupPhase === 'cleanup-recovery');
const cleanup = JSON.parse(await readFile(resolve(runtime, prefix + '-android-' + (allow ? 'cleanup-files' : seed.cleanupPhase ?? 'cleanup') + '.json'), 'utf8'));
if (seed.cleanupPhase === 'cleanup-recovery') {
  const failed = JSON.parse(await readFile(resolve(runtime, prefix + '-android-cleanup.json'), 'utf8'));
  const archive = JSON.parse(await readFile(resolve(runtime, prefix + '-android-archive-recovery.json'), 'utf8'));
  assert.equal(failed.passed, false); assert.equal(failed.home, state.home); assert.equal(failed.sessionId, seed.sessionId);
  assert.equal(archive.passed, true); assert.equal(archive.originalHostPid, failed.hostPid);
  assert.equal(cleanup.originalHostPid, failed.hostPid);
  assert.deepEqual(JSON.parse(await readFile(resolve(runtime, prefix + '-host-final.json'), 'utf8')), archive.original);
  assert.throws(() => process.kill(failed.hostPid, 0), { code: 'ESRCH' });
}
assert.equal(seed.home, state.home); assert.equal(seed.cleaned, true);
if (allow) {
  assert.equal(cleanup.executionMode, state.executionMode); assert.equal(cleanup.command, state.command);
} else assert.equal(cleanup.home, state.home);
assert.equal(cleanup.sessionId, seed.sessionId);
assert.equal(cleanup.hostPid, state.hostPid); assert.equal(cleanup.passed, true);
assert.equal(cleanup.controlsRemoved, true); assert.equal(cleanup.host.autoSessions, 0);
assert.equal(cleanup.host.current, seed.permission); assert.equal(seed.permission, 'workspace-write');
if (allow) { assert.equal(seed.native.permissionRestored, true); assert.equal(seed.ptc.permissionRestored, true); }
for (const path of [...(allow ? [seed.native.path, seed.ptc.path] : planDenial || never ? [seed.path, seed.planPath] : [seed.path]),
  ...['latest-auto-review-control.json', 'latest-auto-review-host.json'].map(name => resolve(state.home, name))]) {
  await assert.rejects(access(path), { code: 'ENOENT' });
}
const autoRoot = state.executionMode === 'source'
  ? resolve(state.sourceRoot, 'packages/experimental/auto-review')
  : resolve(runtime, 'node_modules/@deepseek-ai/dsh-experimental-auto-review');
if (state.executionMode === 'source') {
  const { sourceRoot } = await import('../../plugin/compatibility/latest-upstream/source-runtime.mjs');
  assert.equal(state.sourceRoot, sourceRoot);
  const installed = await (await import('../../plugin/compatibility/latest-upstream/source-host.mjs')).verifyInstalledSource();
  assert.equal(installed.sourceCommit, state.sourceCommit);
}
const metadata = JSON.parse(await readFile(resolve(autoRoot, 'package.json'), 'utf8'));
assert.equal(metadata.name, '@deepseek-ai/dsh-experimental-auto-review');
assert.equal(metadata.version, state.target);
const overlay = resolve(state.home, 'auto-review-diagnostic.patch.json');
const bytes = await readFile(overlay);
assert.deepEqual(JSON.parse(bytes), [{ insert: [
  { id: 'dsh-mobile', name: pathToFileURL(resolve(runtime, 'candidate/dist/index.js')).href },
  { id: 'auto-review', name: pathToFileURL(resolve(autoRoot, 'lib/index.js')).href },
  { id: 'latest-auto-review-observer', name: pathToFileURL(resolve(import.meta.dirname, '../tests/support/latest-auto-review-observer/index.mjs')).href },
  ...(never ? [{ id: 'latest-auto-review-policy', name: pathToFileURL(resolve(import.meta.dirname, '../tests/support/latest-auto-review-policy/index.mjs')).href }] : []),
] }]);
const reportPath = resolve(runtime, prefix + '-overlay-removed.json');
await assert.rejects(access(reportPath), { code: 'ENOENT' });
assert.deepEqual(await readFile(overlay), bytes); await unlink(overlay);
await assert.rejects(access(overlay), { code: 'ENOENT' });
const report = { passed: true, executionMode: state.executionMode, hostPid: state.hostPid,
  hostStopped: true, autoSessions: 0, permissionRestored: true, overlayRemoved: true };
await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report)); process.exit(0);
