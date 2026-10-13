// 只移除同一隔离home、两种真实手机验收结束且Host已停止的原深度配置。
import assert from 'node:assert/strict';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readLatestLiveResume } from './latest-live-resume.mjs';

assert.equal(process.argv.length, 2);
const runtime = resolve(import.meta.dirname, '../../plugin/artifacts/latest-runtime-check');
const { state } = await readLatestLiveResume(runtime);
assert.equal(state.subagentDepthDiagnostic, true);
assert.equal(state.executionMode, 'source');
const installed = await (await import('../../plugin/compatibility/latest-upstream/source-host.mjs')).verifyInstalledSource();
assert.equal(installed.sourceCommit, state.sourceCommit);
const trees = [];
for (const mode of ['release', 'source']) {
  const prefix = `latest-live-${mode}-nested-child`;
  const seed = JSON.parse(await readFile(resolve(runtime, prefix + '-seed.json'), 'utf8'));
  assert.ok(seed.cleanupPhase === undefined || seed.cleanupPhase === 'cleanup-unavailable');
  const cleanup = JSON.parse(await readFile(resolve(runtime, prefix + '-android-' + (seed.cleanupPhase ?? 'cleanup') + '.json'), 'utf8'));
  assert.equal(seed.home, state.home); assert.equal(seed.cleaned, true);
  assert.equal(cleanup.passed, true); assert.equal(cleanup.mode, mode);
  assert.equal(cleanup.parentId, seed.parentId); assert.equal(cleanup.middleId, seed.middleId);
  assert.equal(cleanup.grandId, seed.grandId); assert.equal(cleanup.originalHistoryUnchanged, true);
  assert.equal(cleanup.emptyRootDraft, true); assert.equal(cleanup.sameAppProcess, true);
  if (seed.cleanupPhase === 'cleanup-unavailable') {
    assert.equal(seed.parentUnavailableObserved, true); assert.equal(cleanup.continuationUnverified, true);
    assert.equal(seed.resume?.sent, undefined);
  }
  if (mode === 'source') assert.equal(cleanup.hostPid, state.hostPid);
  for (const pid of [cleanup.hostPid, seed.pid]) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  trees.push({ middleId: seed.middleId, grandId: seed.grandId });
}
const overlay = resolve(state.home, 'subagent-depth-diagnostic.patch.json');
const bytes = await readFile(overlay);
assert.deepEqual(JSON.parse(bytes), [
  { insert: [{ id: 'dsh-mobile', name: pathToFileURL(resolve(runtime, 'candidate/dist/index.js')).href }] },
  { id: 'subagent', name: '@deepseek-ai/dsh-subagent', config: { maxDepth: 2 } },
]);
const reportPath = resolve(runtime, 'latest-live-nested-child-overlay-removed.json');
await assert.rejects(access(reportPath), { code: 'ENOENT' });
assert.deepEqual(await readFile(overlay), bytes); await unlink(overlay);
await assert.rejects(access(overlay), { code: 'ENOENT' });
const report = { passed: true, home: state.home, hostPid: state.hostPid, hostStopped: true,
  overlayRemoved: true, originalConfigUnchanged: true, trees };
await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report));
