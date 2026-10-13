import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import WebSocket from 'ws';

const root = resolve(import.meta.dirname, '..'), runs = process.argv.slice(2);
assert.ok(runs.length > 0 && runs.length <= 8);
const official = resolve(root, '../plugin/artifacts/official-dsh-alpha2');
const receipt = JSON.parse(await readFile(resolve(official, 'official-web-receipt.json'), 'utf8'));
assert.equal(receipt.stage, 'plugin-ready'); process.kill(receipt.pid, 0);
const privateLog = await readFile(receipt.privateLog, 'utf8');
const url = privateLog.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1];
assert.equal(new URL(url).origin, 'http://127.0.0.1:16958');
const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 303); const cookie = login.headers.get('set-cookie').split(';')[0];
const state = await (await fetch('http://127.0.0.1:16958/api/dsh-mobile', {
  headers: { cookie }, signal: AbortSignal.timeout(10000),
})).json();
assert.equal(state.enabled, false);
const closed = port => new Promise((done, reject) => {
  const socket = createConnection({ host: '127.0.0.1', port }); socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); reject(Error('Test port still open: ' + port)); });
  socket.once('timeout', () => { socket.destroy(); reject(Error('Port state unknown: ' + port)); });
  socket.once('error', error => error.code === 'ECONNREFUSED' ? done() : reject(error));
});
const report = { at: new Date().toISOString(), runs: [], readOnly: true, remoteDisabled: true };
const rpc = async (method, args) => {
  assert.ok(['session/projections', 'session/page'].includes(method));
  const rpcId = randomUUID(), response = await fetch('http://127.0.0.1:16958/api/' + method, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200); const frame = await response.json();
  assert.equal(frame.rpcId, rpcId); assert.equal(frame.result.ok, true); return frame.result.value;
};
for (const run of runs) {
  assert.match(run, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  const check = JSON.parse(await readFile(resolve(root, 'artifacts/official-plugin-only', `official-android-${run}.json`), 'utf8'));
  assert.equal(check.scope, 'phone-background-stop-large-ring-gap-disconnect-and-explicit-resume');
  assert.equal(check.passed, false); assert.equal(check.testJobsStopRequested, true);
  assert.equal(check.testDevicesRevoked, true); assert.equal(check.gatewayClosed, true);
  const phone = JSON.parse(await readFile(resolve(root, '../dsh-mobile/artifacts/official-plugin-only', run, 'background-control.json'), 'utf8'));
  const android = JSON.parse(await readFile(resolve(root, '../dsh-mobile/artifacts/official-plugin-only', run, 'android.json'), 'utf8'));
  assert.equal(android.originalAppIdentityUnchanged, true); assert.equal(android.authorityRevoked, true);
  assert.deepEqual(android.pageErrors, []); assert.deepEqual(android.renderingErrors, []);
  const port = check.backgroundControl?.port ?? phone.started.port; await closed(port); await closed(16956);
  const targets = [phone.targets.stop, phone.targets.large], jobs = [];
  const socket = new WebSocket('ws://127.0.0.1:16958/api/remote.mux', { headers: { cookie, origin: 'http://127.0.0.1:16958' } });
  const frames = []; socket.on('message', data => frames.push(JSON.parse(data.toString())));
  try {
    await once(socket, 'open');
    for (const target of targets) {
      const streamId = 'cleanup-' + target.jobId;
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'job/follow',
        payload: { args: { request: { jobId: target.jobId, sessionId: phone.targets.sessionId } } } }));
      const deadline = Date.now() + 15000;
      while (!frames.some(frame => frame.streamId === streamId && (frame.type === 'end' || frame.type === 'error'))) {
        assert.ok(Date.now() < deadline, 'Original job observation did not end');
        await new Promise(done => setTimeout(done, 100));
      }
      const own = frames.filter(frame => frame.streamId === streamId);
      assert.ok(!own.some(frame => frame.type === 'error'), JSON.stringify(own));
      const opened = own.find(frame => frame.type === 'item' && frame.value?.type === 'opened').value.job;
      const terminal = own.find(frame => frame.type === 'item' && frame.value?.type === 'status').value.job;
      assert.equal(opened.id, target.jobId); assert.equal(opened.startedAt, target.startedAt);
      assert.ok(['killed', 'completed'].includes(opened.status));
      if (target.jobId === phone.targets.stop.jobId) assert.equal(opened.status, 'killed');
      else if (phone.final) assert.equal(opened.status, phone.final.actualTerminalStatus);
      assert.equal(opened.owner, phone.targets.sessionId); assert.equal(terminal.status, opened.status);
      assert.equal(terminal.startedAt, target.startedAt);
      const chunks = own.filter(frame => frame.type === 'item' && frame.value?.type === 'output')
        .flatMap(frame => frame.value.chunks);
      const text = chunks.map(chunk => chunk.text).join('');
      jobs.push({ id: opened.id, status: terminal.status, startedAt: terminal.startedAt, detail: terminal.detail,
        output: opened.output, observedBytes: Buffer.byteLength(text), producerGaps: chunks.filter(chunk => chunk.gapBefore).length,
        numberedLines: [...text.matchAll(/_LINE_\d{4}:/g)].length, finalNumberedLinePresent: text.includes('_LINE_0999:') });
    }
  } finally { const done = once(socket, 'close'); socket.close(); await done; }
  const projection = await rpc('session/projections', { request: { sessionId: phone.targets.sessionId } });
  const history = await rpc('session/page', { request: { address: { kind: 'session', sessionId: phone.targets.sessionId },
    throughSeq: projection.asOfSeq, maxMessages: 100 } });
  const toolCalls = history.records.filter(row => row.event.type === 'tool/call').map(row => ({
    seq: row.event.seq, name: row.event.data.name, callId: row.event.data.callId,
    backgroundCommand: row.event.data.name === 'pwsh' && JSON.parse(row.event.data.arguments).command.includes('DSHM_BG_CONTROL_' + run.slice(0, 8)),
  }));
  report.runs.push({ run, originalCleanupCompleted: check.cleanupCompleted, originalCleanupFailures: check.cleanupFailures, toolCalls,
    actualTerminalJobsVerified: true, jobs, testServerPort: port, serverClosed: true,
    originalAppIdentityUnchanged: true, testAuthorityRevoked: true, errorsAbsent: true });
}
report.passed = true;
await writeFile(resolve(root, 'artifacts/official-plugin-only/background-failure-cleanup.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
