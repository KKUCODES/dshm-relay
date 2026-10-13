import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readLatestLiveState } from './latest-live-resume.mjs';

const phase = process.argv[2]; assert.ok(['before', 'after'].includes(phase));
const scope = process.argv[3] ?? 'resume'; assert.match(scope, /^[a-z][a-z0-9-]{0,40}$/);
assert.ok(process.argv.length <= 4);
const runtime = resolve(import.meta.dirname, '../../plugin/artifacts/latest-runtime-check');
const { state } = await readLatestLiveState(runtime);
const { loginURL } = JSON.parse(await readFile(resolve(state.home, 'private-entry.json'), 'utf8'));
const url = new URL(loginURL); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 303); const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
const manage = await fetch(new URL('/api/dsh-mobile', url), { headers: { cookie }, signal: AbortSignal.timeout(10000) });
assert.equal(manage.status, 200); const management = await manage.json();
assert.equal(management.connection, 'online'); assert.equal(management.origin, state.origin);
const rpcId = randomUUID();
const response = await fetch(new URL('/api/session/list', url), { method: 'POST',
  headers: { cookie, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
  body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: { args: { _request: {} } } }) });
assert.equal(response.status, 200); const frame = await response.json();
assert.equal(frame.rpcId, rpcId); assert.equal(frame.result.ok, true);
const sessions = frame.result.value.items.map(row => {
  assert.equal(resolve(row.cwd), state.workspacePath); assert.equal(row.running, false);
  return { id: row.sessionId, seq: row.projections.asOfSeq, title: row.projections.values.title,
    stats: row.projections.values.sessionStats, permissions: row.projections.values.permissions,
    model: row.projections.values.modelSelection, preset: row.projections.values.agentPreset };
}).sort((a, b) => a.id.localeCompare(b.id));
const devices = management.devices.map(({ id, name, fingerprint, status, management }) =>
  ({ id, name, fingerprint, status, management })).sort((a, b) => a.id.localeCompare(b.id));
const identity = { home: state.home, workspacePath: state.workspacePath, origin: state.origin,
  hostId: management.hostId, name: management.name, devices, sessions };
assert.ok(identity.hostId); assert.ok(sessions.length >= 3);
assert.equal(devices.filter(item => item.status === 'active').length, 1);
assert.equal(devices.find(item => item.status === 'active').management, false);
const file = resolve(runtime, `latest-live-${scope}-before.json`);
if (phase === 'before') {
  await writeFile(file, JSON.stringify({ at: new Date().toISOString(), hostPid: state.hostPid, identity }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ phase, saved: true, hostPid: state.hostPid, sessionCount: sessions.length }));
} else {
  const before = JSON.parse(await readFile(file, 'utf8'));
  try {
    assert.notEqual(state.hostPid, before.hostPid); assert.equal(state.previousHostPid, before.hostPid);
    assert.equal(state.resumed, true); assert.deepEqual(identity, before.identity);
    const report = { at: new Date().toISOString(), previousHostPid: before.hostPid, hostPid: state.hostPid,
      identityPreserved: true, sessionCount: sessions.length, management: false, passed: true };
    await writeFile(resolve(runtime, `latest-live-${scope}-after.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    const changedSequences = [];
    for (const current of sessions) {
      const prior = before.identity.sessions.find(item => item.id === current.id);
      if (!prior || prior.seq === current.seq) continue;
      const rpcId = randomUUID();
      const response = await fetch(new URL('/api/session/page', url), { method: 'POST',
        headers: { cookie, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/page', payload: { args: { request: {
          address: { kind: 'session', sessionId: current.id }, throughSeq: current.seq, maxMessages: 20 } } } }) });
      assert.equal(response.status, 200); const frame = await response.json();
      assert.equal(frame.rpcId, rpcId); assert.equal(frame.result.ok, true);
      changedSequences.push({ sessionId: current.id, before: prior.seq, after: current.seq,
        appendedEvents: frame.result.value.records.filter(item => item.event.seq > prior.seq).map(({ event }) =>
          ({ seq: event.seq, type: event.type, keys: Object.keys(event.data) })) });
    }
    const omitSequences = value => ({ ...value, sessions: value.sessions.map(({ seq, ...session }) => session) });
    let otherFieldsPreserved = false;
    try { assert.deepEqual(omitSequences(identity), omitSequences(before.identity)); otherFieldsPreserved = true; } catch {}
    const report = { at: new Date().toISOString(), previousHostPid: before.hostPid, hostPid: state.hostPid,
      passed: false, identityPreserved: false, otherFieldsPreserved, changedSequences,
      failure: { name: error.name, code: error.code } };
    await writeFile(resolve(runtime, `latest-live-${scope}-after-failed.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report)); process.exitCode = 1;
  }
}
// 先收完Windows网络/异步句柄，严格失败仍以非零退出。
setTimeout(() => process.exit(process.exitCode ?? 0), 200);
