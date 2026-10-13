// 控制器 stdin 丢失后的专用测试树退出记录；不伪称原控制器正常清理。
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readLatestLiveState } from './latest-live-resume.mjs';

assert.equal(process.argv.length, 3);
const scope = process.argv[2]; assert.match(scope, /^[a-z][a-z0-9-]{0,40}$/);
const runtime = resolve(import.meta.dirname, '../../plugin/artifacts/latest-runtime-check');
const { state } = await readLatestLiveState(runtime);
const before = JSON.parse(await readFile(resolve(runtime, 'latest-live-child-retention-' + scope + '-before.json'), 'utf8'));
assert.equal(before.passed, true); assert.equal(before.home, state.home); assert.equal(before.hostPid, state.hostPid);
assert.equal(state.reviewCandidate, undefined); assert.equal(state.executionMode, 'release');
for (const pid of [state.hostPid, state.supervisorPid]) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}
await assert.rejects(fetch(state.origin, { signal: AbortSignal.timeout(2000) }));
const file = resolve(runtime, 'latest-live-child-retention-' + scope + '-forced-stop.json');
await assert.rejects(access(file), { code: 'ENOENT' });
const record = { at: new Date().toISOString(), home: state.home, hostPid: state.hostPid,
  supervisorPid: state.supervisorPid, stopped: true, forcedProcessTreeTermination: true,
  gracefulControllerCleanup: false, priorHistoryAuditPassed: true };
await writeFile(file, JSON.stringify(record, null, 2), { flag: 'wx' });
await writeFile(resolve(state.home, 'cleanup.json'), JSON.stringify(record, null, 2));
console.log(JSON.stringify({ stopped: true, hostPid: state.hostPid, gracefulControllerCleanup: false }));
