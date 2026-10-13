import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readLatestLiveState } from './latest-live-resume.mjs';

const phase = process.argv[2]; assert.ok(['before', 'after'].includes(phase)); assert.equal(process.argv.length, 3);
const runtime = resolve(import.meta.dirname, '../../plugin/artifacts/latest-runtime-check');
const prefix = 'latest-live-source-durable-resume';
const { state } = await readLatestLiveState(runtime);
assert.equal(state.executionMode, 'source'); assert.equal(state.command, 'pnpm dsh web');
const { verifyInstalledSource } = await import('../../plugin/compatibility/latest-upstream/source-host.mjs');
const installed = await verifyInstalledSource(); assert.equal(installed.sourceCommit, state.sourceCommit);
const { loginURL } = JSON.parse(await readFile(resolve(state.home, 'private-entry.json'), 'utf8'));
const url = new URL(loginURL); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 303); const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
const rpc = async (method, args) => {
  assert.ok(['session/list', 'session/projections', 'session/page'].includes(method));
  const rpcId = randomUUID();
  const response = await fetch(new URL('/api/' + method, url), { method: 'POST',
    headers: { cookie, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) });
  assert.equal(response.status, 200); const frame = await response.json();
  assert.equal(frame.rpcId, rpcId); assert.equal(frame.result.ok, true); return frame.result.value;
};
const canonical = value => value === null || typeof value !== 'object' ? value
  : Array.isArray(value) ? value.map(canonical)
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const snapshot = async () => {
  const response = await fetch(new URL('/api/dsh-mobile', url), { headers: { cookie }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); const management = await response.json();
  assert.equal(management.connection, 'online'); assert.equal(management.origin, state.origin);
  const devices = management.devices.map(({ id, name, fingerprint, status, management }) =>
    ({ id, name, fingerprint, status, management })).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(devices.filter(item => item.status === 'active').length, 1);
  assert.equal(devices.find(item => item.status === 'active').management, false);
  const rows = (await rpc('session/list', { _request: {} })).items;
  assert.equal(rows.length, 5);
  const sessions = [];
  for (const row of rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
    assert.equal(resolve(row.cwd), state.workspacePath); assert.equal(row.running, false);
    const projections = await rpc('session/projections', { request: { sessionId: row.sessionId } });
    const throughSeq = projections.asOfSeq; assert.ok(Number.isSafeInteger(throughSeq));
    let beforeSeq; let records = [];
    do {
      const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: row.sessionId },
        throughSeq, maxMessages: 30, ...(beforeSeq === undefined ? {} : { beforeSeq }) } });
      if (page.records.length === 0) { assert.equal(page.hasMore, false); break; }
      assert.ok(beforeSeq === undefined || page.records.at(-1).event.seq < beforeSeq);
      records = [...page.records, ...records];
      if (!page.hasMore) break;
      beforeSeq = page.records[0].event.seq;
    } while (true);
    assert.equal(records.length, throughSeq + 1);
    const events = records.map((item, index) => { assert.equal(item.event.seq, index); return item.event; });
    const again = await rpc('session/projections', { request: { sessionId: row.sessionId } });
    assert.deepEqual(again, projections, 'History must be captured at one unchanged cursor');
    sessions.push({ id: row.sessionId, seq: throughSeq, projections: projections.values,
      eventHashes: events.map(hash), eventKinds: events.map(event => event.type),
      messageHash: hash(events.filter(event => event.surfaceOp !== undefined)),
      tail: events.at(-1) ? { type: events.at(-1).type, data: events.at(-1).data } : undefined });
  }
  return { home: state.home, workspacePath: state.workspacePath, origin: state.origin,
    hostId: management.hostId, name: management.name, devices, sessions };
};
const report = { at: new Date().toISOString(), phase, passed: false, hostPid: state.hostPid,
  sourceCommit: installed.sourceCommit, sourceFiles: installed.files };
try {
  const identity = await snapshot();
  if (phase === 'before') {
    await writeFile(resolve(runtime, prefix + '-before.json'), JSON.stringify({ ...report, identity }, null, 2), { flag: 'wx' });
    report.saved = true; report.sessions = identity.sessions.map(row => ({ id: row.id, events: row.eventHashes.length }));
  } else {
    const before = JSON.parse(await readFile(resolve(runtime, prefix + '-before.json'), 'utf8'));
    assert.notEqual(state.hostPid, before.hostPid); assert.equal(state.previousHostPid, before.hostPid); assert.equal(state.resumed, true);
    const omitSessions = ({ sessions, ...rest }) => rest; assert.deepEqual(omitSessions(identity), omitSessions(before.identity));
    assert.deepEqual(identity.sessions.map(row => row.id), before.identity.sessions.map(row => row.id));
    const sessions = [];
    for (const current of identity.sessions) {
      const prior = before.identity.sessions.find(row => row.id === current.id);
      assert.deepEqual(current.projections, prior.projections);
      assert.deepEqual(current.eventHashes.slice(0, prior.eventHashes.length), prior.eventHashes, 'Every original event must survive unchanged');
      assert.deepEqual(current.eventKinds.slice(0, prior.eventKinds.length), prior.eventKinds);
      assert.equal(current.messageHash, prior.messageHash, 'All message-producing events must survive unchanged');
      const added = current.eventHashes.length - prior.eventHashes.length;
      assert.ok(added === 0 || added === 1); assert.equal(current.seq, prior.seq + added);
      if (added === 1) {
        assert.notEqual(prior.tail?.type, 'session/end-seed');
        assert.deepEqual(current.tail, { type: 'session/end-seed', data: {} });
      }
      sessions.push({ id: current.id, originalEvents: prior.eventHashes.length, unchangedPrefix: true,
        messageHistoryPreserved: true, projectionsPreserved: true, addedResumeMarkers: added });
    }
    report.previousHostPid = before.hostPid; report.sessions = sessions; report.identityPreserved = true;
    report.allOriginalEventsPreserved = true; report.onlyOfficialResumeMarkers = true; report.management = false; report.passed = true;
  }
} catch (error) {
  report.failure = { name: error.name, code: error.code, message: error.message }; process.exitCode = 1;
} finally {
  await writeFile(resolve(runtime, prefix + '-' + phase + '-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
setTimeout(() => process.exit(process.exitCode ?? 0), 200);
