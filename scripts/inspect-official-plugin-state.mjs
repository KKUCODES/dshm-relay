import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// 只读自己拥有的官方隔离配置和公开插件目录；不输出登录凭据或模型 Key。
const root = resolve('../plugin/artifacts/official-dsh-plugin-only');
const receipt = JSON.parse(await readFile(resolve(root, 'official-web-receipt.json'), 'utf8'));
assert.equal(receipt.stage, 'plugin-ready');
const log = await readFile(receipt.privateLog, 'utf8');
const url = log.match(/dsh web: (http:\/\/127\.0\.0\.1:16955\/\?token=[^\s]+)/)?.[1];
assert.ok(url);
const login = await fetch(url, { redirect: 'manual' });
assert.equal(login.status, 303);
const cookie = login.headers.get('set-cookie').split(';')[0];
const method = 'pluginManager/listBundles', rpcId = randomUUID();
const response = await fetch('http://127.0.0.1:16955/api/' + method, { method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: {} } }) });
assert.equal(response.status, 200);
const result = await response.json();
assert.equal(result.result.ok, true);
const name = '@dsh-mobile/panel-ui-verification';
const profile = JSON.parse(await readFile(resolve(root, 'home/profiles/web/package.json'), 'utf8'));
const report = { at: new Date().toISOString(), bundle: result.result.value.find(item => item.name === name) ?? null,
  selected: profile.dsh?.profile?.bundles?.includes(name) ?? false,
  dependency: profile.dependencies?.[name] ?? null };
const previousRun = process.argv[2];
if (previousRun) {
  assert.match(previousRun, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(report.bundle, null);
  assert.equal(report.selected, false);
  assert.equal(report.dependency, null);
  report.previousRun = previousRun;
  report.uninstallSettledAfterFailedImmediateCheck = true;
}
await writeFile(resolve('artifacts/official-plugin-only', 'plugin-state-' + rpcId + '.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
