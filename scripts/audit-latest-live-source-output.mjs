// 固定持久测试会话的只读诊断；不导出请求头、模型上下文或凭据。
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readLatestLiveState } from './latest-live-resume.mjs';

const runtime = resolve(import.meta.dirname, '../../plugin/artifacts/latest-runtime-check');
const scenario = process.argv[2] ?? 'source-diagnostic-retry';
assert.ok(['source-diagnostic-retry', 'source-context', 'source-registration'].includes(scenario));
assert.ok(process.argv.length <= 3);
const reportPrefix = scenario === 'source-diagnostic-retry' ? 'latest-live-source-output' : 'latest-live-' + scenario + '-output';
const { state } = await readLatestLiveState(runtime);
assert.equal(state.executionMode, 'source');
const session = JSON.parse(await readFile(resolve(runtime, 'latest-live-encoding-session.json'), 'utf8'));
const seed = JSON.parse(await readFile(resolve(runtime, 'latest-live-' + scenario + '-encoding-seed.json'), 'utf8'));
assert.equal(session.home, state.home); assert.equal(seed.sessionId, session.sessionId);
const { loginURL } = JSON.parse(await readFile(resolve(state.home, 'private-entry.json'), 'utf8'));
const url = new URL(loginURL); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 303); const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
const read = async (method, args) => {
  assert.ok(['session/list', 'session/projections', 'session/page'].includes(method));
  const rpcId = randomUUID();
  const response = await fetch(new URL('/api/' + method, url), { method: 'POST',
    headers: { cookie, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) });
  assert.equal(response.status, 200); const frame = await response.json();
  assert.equal(frame.rpcId, rpcId); assert.equal(frame.result.ok, true); return frame.result.value;
};
const projections = await read('session/projections', { request: { sessionId: session.sessionId } });
const history = await read('session/page', { request: { address: { kind: 'session', sessionId: session.sessionId },
  throughSeq: projections.asOfSeq, maxMessages: 60 } });
const row = (await read('session/list', { _request: {} })).items.find(item => item.sessionId === session.sessionId);
const records = history.records.filter(item => item.event.seq > seed.initialSeq);
const calls = records.filter(item => item.event.type === 'tool/call').map(({ event }) => {
  const args = JSON.parse(event.data.arguments);
  return { seq: event.seq, time: event.time, turn: event.data.turn, step: event.data.step,
    callId: event.data.callId, name: event.data.name, commandExact: args.command === seed.command,
    commandHash: typeof args.command === 'string' ? createHash('sha256').update(args.command).digest('hex') : null,
    commandLength: args.command?.length, containsMarker: args.command?.includes(seed.marker),
    runInBackground: args.run_in_background, timeoutMs: args.timeoutMs };
});
const results = records.filter(item => item.event.type === 'tool/result').map(({ event }) => ({
  seq: event.seq, callId: event.data.message.toolCallId, isError: event.data.message.isError,
  stdoutMarker: JSON.stringify(event.data).includes('中文🍀' + seed.marker),
  endMarker: JSON.stringify(event.data).includes('结束中文🍀' + seed.marker),
  stderrMarker: JSON.stringify(event.data).includes('错误🦉' + seed.marker),
  replacementCharacter: JSON.stringify(event.data).includes('�'),
}));
const event260 = history.records.find(item => item.event.seq === 260)?.event;
const report = { at: new Date().toISOString(), scenario, hostPid: state.hostPid, sourceCommit: state.sourceCommit,
  sessionId: session.sessionId, initialSeq: seed.initialSeq, asOfSeq: projections.asOfSeq, running: row.running,
  permissions: projections.values.permissions.currentValue, calls, results,
  event260: event260 && { type: event260.type, time: event260.time, keys: Object.keys(event260.data),
    turn: event260.data.turn, step: event260.data.step },
  assistantDone: records.some(item => item.event.type === 'assistant/message' && JSON.stringify(item.event.data).includes('DSHM_ENCODING_DONE')),
};
await copyFile(resolve(state.home, 'output-diagnostic.json'), resolve(runtime, reportPrefix + '-observer.json'));
await writeFile(resolve(runtime, reportPrefix + '-original-audit.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
