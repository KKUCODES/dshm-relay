// 经原本机认证与Commands远程服务设置测试策略；手机中转权限不扩大。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readLatestLiveState } from './latest-live-resume.mjs';

const retry = process.argv[2] === '--retry';
assert.ok(process.argv.length === 2 || process.argv.length === 3 && retry);
const runtime = resolve(import.meta.dirname, '../../plugin/artifacts/latest-runtime-check');
const { state } = await readLatestLiveState(runtime);
assert.equal(state.autoReviewDiagnostic, true); assert.equal(state.autoReviewPolicyDiagnostic, true);
process.kill(state.hostPid, 0); process.kill(state.supervisorPid, 0);
const prefix = 'latest-live-' + (state.executionMode === 'source' ? 'source-' : '') + 'auto-deny-never';
const seed = JSON.parse(await readFile(resolve(runtime, prefix + '-seed.json'), 'utf8'));
const session = JSON.parse(await readFile(resolve(runtime, 'latest-live-android-session.json'), 'utf8'));
assert.equal(seed.home, state.home); assert.equal(session.home, state.home);
assert.equal(seed.sessionId, session.sessionId); assert.equal(seed.never, true); assert.equal(seed.sent, undefined);
assert.match(seed.marker, /^DSHM_LATEST_AUTO_[a-f0-9]{32}$/);
assert.deepEqual(JSON.parse(await readFile(resolve(state.home, 'latest-auto-review-control.json'), 'utf8')),
  { marker: seed.marker, sessionId: seed.sessionId, phase: 'native-deny-never' });
const reportPath = resolve(runtime, prefix + (retry ? '-policy-setup-retry.json' : '-policy-setup.json'));
await assert.rejects(access(reportPath), { code: 'ENOENT' });
const url = new URL(JSON.parse(await readFile(resolve(state.home, 'private-entry.json'), 'utf8')).loginURL);
assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 303); const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
const rpc = async (method, args) => {
  assert.ok(['session/projections', 'commands/execute'].includes(method));
  const rpcId = randomUUID();
  const response = await fetch(new URL('/api/' + method, url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200); const frame = await response.json(); assert.equal(frame.rpcId, rpcId);
  if (!frame.result.ok) {
    const failedPath = resolve(runtime, prefix + (retry ? '-policy-setup-retry-failed.json' : '-policy-setup-failed.json'));
    await writeFile(failedPath, JSON.stringify({ passed: false, at: new Date().toISOString(), home: state.home,
      hostPid: state.hostPid, sessionId: seed.sessionId, method, error: frame.result.error }, null, 2), { flag: 'wx' });
    throw Error('latest_live_local_policy_rpc_failed:' + JSON.stringify(frame.result.error));
  }
  return frame.result.value;
};
const before = await rpc('session/projections', { request: { sessionId: seed.sessionId } });
assert.equal(before.values.permissions.currentValue, 'auto');
const result = await rpc('commands/execute', { agentId: seed.sessionId,
  line: '/dshm-latest-review-policy ' + seed.marker + ' never', submittedAttachments: [] });
assert.equal(result.result.kind, 'success'); assert.equal(result.result.text, seed.marker + '_POLICY_NEVER');
const after = await rpc('session/projections', { request: { sessionId: seed.sessionId } });
assert.equal(after.values.permissions.currentValue, 'auto');
const report = { passed: true, at: new Date().toISOString(), hostPid: state.hostPid, home: state.home,
  executionMode: state.executionMode, sessionId: seed.sessionId, result, beforeSeq: before.asOfSeq, afterSeq: after.asOfSeq };
await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' }); console.log(JSON.stringify(report));
