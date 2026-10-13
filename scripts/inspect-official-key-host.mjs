import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../plugin/artifacts/official-dsh-alpha2-key');
const receipt = JSON.parse(await readFile(resolve(root, 'official-web-receipt.json'), 'utf8'));
assert.equal(receipt.scope, 'isolated-synthetic-provider-key'); assert.equal(receipt.port, 16960);
const log = await readFile(receipt.privateLog, 'utf8');
const url = log.match(/dsh web: (http:\/\/127\.0\.0\.1:16960\/\?token=[^\s]+)/)?.[1];
assert.ok(url);
const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 303);
const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
async function rpc(method, args) {
  const response = await fetch('http://127.0.0.1:16960/api/' + method, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200); const frame = await response.json();
  assert.equal(frame.result?.ok, true); return frame.result.value;
}
const credential = await rpc('credentials/describe', { refs: ['DEEPSEEK_API_KEY'] });
const sessions = await rpc('session/list', { _request: {} });
const states = [];
for (const item of sessions.items) {
  const snapshot = await rpc('session/projections', { request: { sessionId: item.sessionId } });
  const history = await rpc('session/page', { request: { address: { kind: 'session', sessionId: item.sessionId }, throughSeq: snapshot.asOfSeq, maxMessages: 100 } });
  states.push({ id: item.sessionId, title: item.title, running: item.running,
    phase: snapshot.values?.phase, eventTypes: history.records.map(record => record.event.type) });
}
console.log(JSON.stringify({ launchPid: receipt.pid, credential: credential.DEEPSEEK_API_KEY, states }));
