// 在隔离测试home内核对所有历史工作区；不能把已移除注册的会话当作当前工作区。
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { readLatestLiveState } from './latest-live-resume.mjs';

const [phase, scope] = process.argv.slice(2);
assert.equal(process.argv.length, 4); assert.ok(['before', 'after', 'history', 'carrier'].includes(phase));
assert.match(scope, /^[a-z][a-z0-9-]{0,40}$/);
const runtime = resolve(import.meta.dirname, '../../plugin/artifacts/latest-runtime-check');
const prefix = resolve(runtime, 'latest-live-' + scope);
const { state } = await readLatestLiveState(runtime);
process.kill(state.hostPid, 0); process.kill(state.supervisorPid, 0);
const report = { at: new Date().toISOString(), phase, scope, hostPid: state.hostPid, executionMode: state.executionMode, passed: false };
const canonical = value => value === null || typeof value !== 'object' ? value
  : Array.isArray(value) ? value.map(canonical)
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
try {
  const { loginURL } = JSON.parse(await readFile(resolve(state.home, 'private-entry.json')));
  const url = new URL(loginURL); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
  const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(login.status, 303); const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  const rpc = async (method, args) => {
    assert.ok(['session/list', 'session/projections', 'session/page'].includes(method));
    const rpcId = randomUUID();
    const response = await fetch(new URL('/api/' + method, url), { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) });
    assert.equal(response.status, 200); const frame = await response.json();
    assert.equal(frame.rpcId, rpcId);
    if (!frame.result.ok) report.failedRpc = { method,
      sessionId: args.request?.sessionId ?? args.request?.address?.sessionId,
      code: frame.result.error?.code, message: frame.result.error?.message, type: frame.result.error?.type };
    assert.equal(frame.result.ok, true); return frame.result.value;
  };
  const managementResponse = await fetch(new URL('/api/dsh-mobile', url), { headers: { cookie }, signal: AbortSignal.timeout(10000) });
  assert.equal(managementResponse.status, 200); const management = await managementResponse.json();
  assert.equal(management.connection, 'online'); assert.equal(management.origin, state.origin);
  const devices = management.devices.map(({ id, name, fingerprint, status, management }) =>
    ({ id, name, fingerprint, status, management })).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(devices.filter(row => row.status === 'active').length, 1);
  assert.equal(devices.find(row => row.status === 'active').management, false);
  const rows = (await rpc('session/list', { _request: {} })).items;
  assert.ok(rows.length >= 5);
  const sessions = [];
  const parentProjections = new Map();
  for (const row of rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
    const cwd = resolve(row.cwd), rel = relative(state.home, cwd);
    assert.ok(rel !== '..' && !rel.startsWith('..\\') && !isAbsolute(rel), 'History must belong to the owned test home');
    assert.equal(row.running, false);
    const projections = await rpc('session/projections', { request: { sessionId: row.sessionId } });
    let address = { kind: 'session', sessionId: row.sessionId };
    if (row.origin === 'subagent') {
      assert.ok(row.parentSessionId);
      if (!parentProjections.has(row.parentSessionId))
        parentProjections.set(row.parentSessionId, await rpc('session/projections', { request: { sessionId: row.parentSessionId } }));
      const catalog = parentProjections.get(row.parentSessionId)?.values.subagentCatalog;
      assert.ok(Array.isArray(catalog));
      const child = catalog.find(item => item.id === row.sessionId); assert.ok(child);
      assert.ok(['one-shot', 'continuable', 'unknown'].includes(child.mode));
      address = { kind: 'subagent', parentSessionId: row.parentSessionId, childSessionId: row.sessionId, mode: child.mode };
    }
    const throughSeq = projections.asOfSeq; assert.ok(Number.isSafeInteger(throughSeq));
    let beforeSeq, records = [];
    for (;;) {
      const page = await rpc('session/page', { request: { address,
        throughSeq, maxMessages: 30, ...(beforeSeq === undefined ? {} : { beforeSeq }) } });
      if (page.records.length === 0) { assert.equal(page.hasMore, false); break; }
      assert.ok(beforeSeq === undefined || page.records.at(-1).event.seq < beforeSeq);
      records = [...page.records, ...records];
      if (!page.hasMore) break;
      beforeSeq = page.records[0].event.seq;
    }
    assert.equal(records.length, throughSeq + 1);
    const events = records.map((item, index) => { assert.equal(item.event.seq, index); return item.event; });
    assert.deepEqual(await rpc('session/projections', { request: { sessionId: row.sessionId } }), projections);
    sessions.push({ id: row.sessionId, cwd, address, seq: throughSeq, projections: projections.values,
      eventHashes: events.map(hash), messageHash: hash(events.filter(event => event.surfaceOp !== undefined)),
      tail: events.at(-1) ? { type: events.at(-1).type, data: events.at(-1).data } : undefined });
  }
  const identity = { home: state.home, origin: state.origin, hostId: management.hostId, name: management.name, devices, sessions };
  if (phase === 'before') {
    await writeFile(prefix + '-before.json', JSON.stringify({ ...report, identity }, null, 2), { flag: 'wx' });
  } else {
    const before = JSON.parse(await readFile(prefix + '-before.json'));
    assert.notEqual(state.hostPid, before.hostPid);
    if (phase === 'history') {
      // 多轮故障复验后独立核对数据；不把当前历史一致伪称为全部中间进程链已审计。
      assert.throws(() => process.kill(before.hostPid, 0), error => error.code === 'ESRCH');
      report.historyOnly = true;
    } else {
    let previousHostPid = before.hostPid, chain = [];
    try { chain = JSON.parse(await readFile(prefix + '-resume-chain.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(Array.isArray(chain));
    for (const hop of chain) {
      assert.equal(hop.previousHostPid, previousHostPid); assert.equal(hop.home, state.home);
      assert.equal(hop.origin, state.origin); assert.equal(hop.executionMode, before.executionMode);
      assert.equal(hop.cleanup.hostPid, hop.hostPid); assert.equal(hop.cleanup.stopped, true);
      assert.throws(() => process.kill(hop.hostPid, 0), error => error.code === 'ESRCH');
      previousHostPid = hop.hostPid;
    }
    assert.equal(state.previousHostPid, previousHostPid);
    report.verifiedIntermediateStops = chain.length;
    }
    // 切换源码/发布载体时仍核对原身份与全部历史；原 after/history 保持同载体要求。
    if (phase === 'carrier') {
      assert.ok(['source', 'release'].includes(before.executionMode));
      assert.notEqual(state.executionMode, before.executionMode); report.carrierChanged = true;
    } else assert.equal(state.executionMode, before.executionMode);
    assert.equal(state.resumed, true);
    const omitSessions = ({ sessions, ...rest }) => rest; assert.deepEqual(omitSessions(identity), omitSessions(before.identity));
    assert.deepEqual(sessions.map(row => row.id), before.identity.sessions.map(row => row.id));
    const results = [];
    for (const current of sessions) {
      const prior = before.identity.sessions.find(row => row.id === current.id);
      assert.equal(current.cwd, prior.cwd); assert.deepEqual(current.address, prior.address);
      assert.deepEqual(current.projections, prior.projections);
      assert.deepEqual(current.eventHashes.slice(0, prior.eventHashes.length), prior.eventHashes);
      assert.equal(current.messageHash, prior.messageHash);
      const added = current.eventHashes.length - prior.eventHashes.length;
      assert.ok(added === 0 || added === 1); assert.equal(current.seq, prior.seq + added);
      if (added) {
        assert.notEqual(prior.tail?.type, 'session/end-seed');
        assert.deepEqual(current.tail, { type: 'session/end-seed', data: {} });
      }
      results.push({ id: current.id, originalEvents: prior.eventHashes.length, unchangedPrefix: true, addedResumeMarkers: added });
    }
    report.sessions = results; report.allOriginalEventsPreserved = true; report.projectionsPreserved = true;
  }
  report.sessionCount = sessions.length; report.events = sessions.reduce((sum, row) => sum + row.eventHashes.length, 0);
  report.management = false; report.passed = true;
} catch (error) { report.failure = { name: error.name, message: error.message }; process.exitCode = 1; }
finally {
  await writeFile(prefix + '-' + phase + '-report.json', JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report));
}
// 留出网络句柄关闭时间，避免立即process.exit触发Windows Node的UV_HANDLE_CLOSING断言。
setTimeout(() => process.exit(process.exitCode ?? 0), 300);
