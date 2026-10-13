import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// 只通过正常官方接口读取/卸载本项目的临时bundle；登录凭据不输出、不落入报告。
const [mode, run] = process.argv.slice(2);
assert.ok(['inspect', 'cleanup'].includes(mode));
assert.match(run, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const root = resolve('../plugin/artifacts/official-dsh-alpha2');
const receipt = JSON.parse(await readFile(resolve(root, 'official-web-receipt.json'), 'utf8'));
assert.equal(receipt.stage, 'plugin-ready'); assert.equal(receipt.port, 16958); process.kill(receipt.pid, 0);
assert.equal(receipt.privateLog, resolve(root, `web-${receipt.run}.private.log`));
const log = await readFile(receipt.privateLog, 'utf8');
const url = log.match(/dsh web: (http:\/\/127\.0\.0\.1:16958\/\?token=[^\s]+)/)?.[1];
assert.ok(url); const login = await fetch(url, { redirect: 'manual' }); assert.equal(login.status, 303);
const cookie = login.headers.get('set-cookie').split(';')[0];
const rpc = async (method, args = {}) => {
  const response = await fetch('http://127.0.0.1:16958/api/' + method, { method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
    signal: AbortSignal.timeout(120000) });
  assert.equal(response.status, 200); const frame = await response.json(); assert.equal(frame.result.ok, true);
  return frame.result.value;
};
const name = '@dsh-mobile/panel-ui-verification';
const before = await rpc('pluginManager/listBundles');
const target = before.find(row => row.name === name);
const report = { run, mode, before: before.map(({ name, version, installed, availability }) => ({ name, version, installed, availability })) };
if (mode === 'cleanup' && target) {
  assert.ok(['0.0.5', '0.0.6'].includes(target.version)); assert.ok(target.source.includes('official-plugin-fixtures'));
  report.removal = await rpc('pluginManager/removeBundle', { name });
  const started = Date.now();
  while ((await rpc('pluginManager/listBundles')).some(row => row.name === name)) {
    assert.ok(Date.now() - started < 120000); await new Promise(done => setTimeout(done, 250));
  }
}
report.testBundleAbsent = !(await rpc('pluginManager/listBundles')).some(row => row.name === name);
if (mode === 'cleanup') assert.equal(report.testBundleAbsent, true);
const test = JSON.parse(await readFile(resolve('artifacts/official-plugin-only', `official-android-${run}.json`), 'utf8'));
const projection = await rpc('session/projections', { request: { sessionId: test.sessionId } });
const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: test.sessionId }, throughSeq: projection.asOfSeq, maxMessages: 500 } });
report.historyEventTypes = page.records.map(row => ({ seq: row.event.seq, type: row.event.type }));
await writeFile(resolve('artifacts/official-plugin-only', `plugin-upgrade-${mode}-${run}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ run, mode, targetVersion: target?.version, testBundleAbsent: report.testBundleAbsent, removal: report.removal?.application }));
