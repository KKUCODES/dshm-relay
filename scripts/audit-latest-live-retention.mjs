// 专用候选切换前后核对全部原父子历史；只落盘摘要，不读取 Key。
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { readLatestLiveState } from './latest-live-resume.mjs';

const phase = process.argv[2]; assert.ok(['before', 'after-review', 'after-review-audited', 'before-restore', 'after-restore', 'after-restore-audited', 'after-restore-audited-settled', 'after-restore-audited-phone-settled'].includes(phase));
const scope = process.argv[3] ?? '';
assert.ok(process.argv.length === 3 || process.argv.length === 4);
assert.ok(scope === '' || /^[a-z][a-z0-9-]{0,40}$/.test(scope));
const prefix = 'latest-live-child-retention-' + (scope ? scope + '-' : '');
const runtime = resolve(import.meta.dirname, '../../plugin/artifacts/latest-runtime-check');
const { state } = await readLatestLiveState(runtime);
const file = resolve(runtime, prefix + phase + '.json');
await assert.rejects(access(file), { code: 'ENOENT' });
const { loginURL } = JSON.parse(await readFile(resolve(state.home, 'private-entry.json'), 'utf8'));
const url = new URL(loginURL); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 303); const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
const rpc = async (method, args) => {
  assert.ok(['session/list', 'session/projections', 'session/page'].includes(method));
  const rpcId = randomUUID(), response = await fetch(new URL('/api/' + method, url), { method: 'POST',
    headers: { cookie, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) });
  assert.equal(response.status, 200); const frame = await response.json();
  assert.equal(frame.rpcId, rpcId);
  assert.equal(frame.result.ok, true, method + ':' + (args.request?.sessionId ?? args.request?.address?.childSessionId ?? args.request?.address?.sessionId ?? 'list'));
  return frame.result.value;
};
const canonical = value => value === null || typeof value !== 'object' ? value : Array.isArray(value)
  ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const report = { at: new Date().toISOString(), phase, scope, home: state.home, hostPid: state.hostPid,
  executionMode: state.executionMode, reviewCandidate: state.reviewCandidate, passed: false };
try {
  if (phase === 'after-restore-audited-phone-settled') {
    assert.equal(scope, 'sdk-attempt-9');
    const initial = JSON.parse(await readFile(resolve(runtime, prefix + 'after-restore-audited.json')));
    assert.equal(initial.passed, true); assert.equal(initial.hostPid, state.hostPid);
    assert.equal(initial.home, state.home); assert.equal(initial.executionMode, state.executionMode);
    const failed = JSON.parse(await readFile(resolve(runtime, 'latest-sdk-sea-android-restored-attempt-9.json')));
    assert.equal(failed.passed, false); assert.equal(failed.failure.code, 'ERR_ASSERTION');
    assert.match(failed.failure.location, /restore-latest-sdk-android\.mjs:71:10/);
    const root = initial.identity.sessions.find(row => row.id === 'session-d75f90e0-c89e-41f4-aca2-f09c1bf01415');
    assert.ok(root); assert.ok(failed.failure.message.includes(`${root.seq + 1} !== ${root.seq}`));
    report.originalAndroidFailedReadRetained = true;
  }
  if (phase === 'after-restore-audited-settled') {
    // 首次原恢复标记在分页读取期间到达；只重读同一Host，保留原严格失败，不重启或重发。
    const failed = JSON.parse(await readFile(resolve(runtime, prefix + 'after-restore-audited.json'), 'utf8'));
    assert.equal(failed.passed, false); assert.equal(failed.hostPid, state.hostPid);
    assert.equal(failed.home, state.home); assert.equal(failed.executionMode, state.executionMode);
    assert.equal(failed.failure.code, 'ERR_ASSERTION'); assert.match(failed.failure.message, /asOfSeq:\s*\d+/);
    report.originalFailedReadRetained = true;
  }
  const response = await fetch(new URL('/api/dsh-mobile', url), { headers: { cookie }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); const management = await response.json();
  assert.equal(management.connection, 'online'); assert.equal(management.origin, state.origin);
  const devices = management.devices.map(({ id, name, fingerprint, status, management }) =>
    ({ id, name, fingerprint, status, management })).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(devices.filter(row => row.status === 'active').length, 1);
  assert.equal(devices.find(row => row.status === 'active').management, false);
  const rows = (await rpc('session/list', { _request: {} })).items;
  assert.ok(rows.length >= 5); const queue = [], seen = new Set(), sessions = [], originalEvents = new Map();
  for (const row of rows) {
    assert.equal(row.running, false);
    // 历史会话可引用已清理的测试工作区；核对原 cwd 身份，不要求重新创建目录。
    assert.equal(typeof row.cwd, 'string'); assert.ok(isAbsolute(row.cwd));
    const path = resolve(row.cwd), within = relative(await realpath(state.home), path);
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
    assert.equal(path, resolve(state.home, within));
    if (row.origin === 'subagent') continue; // 原列表也包含冷子会话，必须由原父目录提供地址。
    queue.push({ id: row.sessionId, address: { kind: 'session', sessionId: row.sessionId }, cwd: row.cwd });
  }
  while (queue.length) {
    assert.ok(sessions.length < 128); const target = queue.shift();
    assert.equal(seen.has(target.id), false, 'duplicate original parent/child address'); seen.add(target.id);
    const projections = await rpc('session/projections', { request: { sessionId: target.id } });
    const throughSeq = projections.asOfSeq; assert.ok(Number.isSafeInteger(throughSeq));
    let beforeSeq, records = [];
    do {
      const page = await rpc('session/page', { request: { address: target.address, throughSeq, maxMessages: 30,
        ...(beforeSeq === undefined ? {} : { beforeSeq }) } });
      if (!page.records.length) { assert.equal(page.hasMore, false); break; }
      assert.ok(beforeSeq === undefined || page.records.at(-1).event.seq < beforeSeq);
      records = [...page.records, ...records];
      if (!page.hasMore) break; beforeSeq = page.records[0].event.seq;
    } while (true);
    assert.equal(records.length, throughSeq + 1);
    const eventHashes = records.map((row, index) => { assert.equal(row.event.seq, index); return hash(row.event); });
    originalEvents.set(target.id, records.map(row => row.event));
    assert.deepEqual(await rpc('session/projections', { request: { sessionId: target.id } }), projections);
    sessions.push({ ...target, seq: throughSeq, projectionsHash: hash(projections.values), eventHashes });
    for (const child of projections.values.subagentCatalog ?? []) {
      assert.ok(['continuable', 'one-shot'].includes(child.mode), 'unconfirmed child identity cannot be audited');
      queue.push({ id: child.id, address: { kind: 'subagent', parentSessionId: target.id, childSessionId: child.id, mode: child.mode } });
    }
  }
  for (const row of rows) assert.equal(seen.has(row.sessionId), true, 'listed session must have a verified root or child address');
  sessions.sort((a, b) => a.id.localeCompare(b.id));
  report.identity = { home: state.home, origin: state.origin, hostId: management.hostId, name: management.name, devices, sessions };
  if (phase.startsWith('after-')) {
    const priorPhase = phase.startsWith('after-review') ? 'before' : 'before-restore';
    const prior = JSON.parse(await readFile(resolve(runtime, prefix + priorPhase + '.json'), 'utf8'));
    assert.equal(prior.passed, true); assert.notEqual(prior.hostPid, state.hostPid);
    assert.equal(state.previousHostPid, prior.hostPid);
    if (!phase.endsWith('-audited') && !['after-restore-audited-settled', 'after-restore-audited-phone-settled'].includes(phase)) assert.deepEqual(report.identity, prior.identity);
    else {
      // 原 DSH 恢复可追加一个空 end-seed；原消息、全部事件前缀和投影仍须逐项不变。
      const { sessions: priorSessions, ...priorIdentity } = prior.identity;
      const { sessions: currentSessions, ...currentIdentity } = report.identity;
      assert.deepEqual(currentIdentity, priorIdentity);
      assert.deepEqual(currentSessions.map(row => row.id), priorSessions.map(row => row.id));
      report.addedResumeMarkers = [];
      for (const current of currentSessions) {
        const previous = priorSessions.find(row => row.id === current.id);
        const { seq, eventHashes, ...identity } = current;
        const { seq: oldSeq, eventHashes: oldHashes, ...oldIdentity } = previous;
        assert.deepEqual(identity, oldIdentity);
        assert.deepEqual(eventHashes.slice(0, oldHashes.length), oldHashes);
        const added = eventHashes.length - oldHashes.length;
        assert.ok(added === 0 || added === 1); assert.equal(seq, oldSeq + added);
        if (added) {
          const events = originalEvents.get(current.id), tail = events.at(-1);
          assert.notEqual(events[oldHashes.length - 1]?.type, 'session/end-seed');
          assert.equal(tail.type, 'session/end-seed'); assert.deepEqual(tail.data, {});
          assert.equal(tail.surfaceOp, undefined);
          report.addedResumeMarkers.push({ sessionId: current.id, seq });
        }
      }
    }
  }
  report.sessionCount = sessions.length; report.eventCount = sessions.reduce((sum, row) => sum + row.eventHashes.length, 0);
  report.passed = true;
} catch (error) { report.failure = { name: error.name, code: error.code, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await writeFile(file, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ phase, passed: report.passed, sessionCount: report.sessionCount, eventCount: report.eventCount, failure: report.failure })); }
setTimeout(() => process.exit(process.exitCode ?? 0), 200);
