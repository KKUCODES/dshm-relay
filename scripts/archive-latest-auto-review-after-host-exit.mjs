// 原Host已退出时保存原观察与失败证据；不启动服务、不改权限或会话日志。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readLatestLiveState } from './latest-live-resume.mjs';

assert.equal(process.argv.length, 2);
const runtime = resolve(import.meta.dirname, '../../plugin/artifacts/latest-runtime-check');
const { state } = await readLatestLiveState(runtime);
assert.equal(state.autoReviewDiagnostic, true); assert.equal(state.autoReviewPolicyDiagnostic, true);
assert.throws(() => process.kill(state.hostPid, 0), { code: 'ESRCH' }); process.kill(state.supervisorPid, 0);
const prefix = 'latest-live-' + (state.executionMode === 'source' ? 'source-' : '') + 'auto-deny-never';
const seed = JSON.parse(await readFile(resolve(runtime, prefix + '-seed.json'), 'utf8'));
assert.equal(seed.home, state.home); assert.equal(seed.never, true); assert.equal(seed.sent, true);
const snapshot = JSON.parse(await readFile(resolve(state.home, 'latest-auto-review-host.json'), 'utf8'));
const inspected = JSON.parse(await readFile(resolve(runtime, prefix + '-android-inspect.json'), 'utf8'));
assert.equal(inspected.passed, true); assert.equal(inspected.home, state.home); assert.equal(inspected.hostPid, state.hostPid);
assert.equal(inspected.sessionId, seed.sessionId); assert.equal(inspected.running, false); assert.deepEqual(inspected.host, snapshot);
assert.equal(snapshot.marker, seed.marker); assert.equal(snapshot.sessionId, seed.sessionId);
assert.equal(snapshot.current, 'auto'); assert.equal(snapshot.approvalPolicy, 'never');
assert.deepEqual(snapshot.reviews.map(row => [row.mode, row.toolName, row.risk, row.decision, row.finish, row.ended]),
  [['native', 'read', 'low', 'allow', 'stop', true], ['native', 'pwsh', 'medium', 'deny', 'stop', true]]);
assert.equal(snapshot.dispatches.length, 1); assert.equal(snapshot.dispatches[0].name, 'read');
assert.equal(inspected.results.length, 2); assert.equal(inspected.results[1].error.code, 'AUTO_REVIEW_DENIED');
assert.equal(inspected.results[1].error.name, 'AutoReviewDeniedError');
assert.equal(inspected.events.filter(row => row.type === 'approval/asked' || row.type === 'approval/decided').length, 0);
assert.equal(await readFile(seed.path, 'utf8'), seed.before); assert.equal(await readFile(seed.planPath, 'utf8'), seed.plan);
await writeFile(resolve(runtime, prefix + '-host-before-recovery.json'), JSON.stringify(snapshot, null, 2), { flag: 'wx' });
const report = { passed: true, at: new Date().toISOString(), home: state.home, executionMode: state.executionMode,
  hostPid: state.hostPid, supervisorPid: state.supervisorPid, hostExited: true, supervisorAlive: true,
  exitReasonKnown: false, historyInspected: true, sessionId: seed.sessionId, fixturePreserved: true };
await writeFile(resolve(runtime, prefix + '-host-exit-audit.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report));
