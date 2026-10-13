import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// 仅检查正常官方隔离Host的公开设置元数据；不读取任何凭据文件或输出登录信息。
const root = resolve(import.meta.dirname, '../../plugin/artifacts/official-dsh-alpha2');
const receipt = JSON.parse(await readFile(resolve(root, 'official-web-receipt.json'), 'utf8'));
assert.equal(receipt.entry, 'pnpm dsh web'); assert.equal(receipt.port, 16958);
assert.equal(receipt.version, '0.2.1-alpha.2'); process.kill(receipt.pid, 0);
const log = await readFile(receipt.privateLog, 'utf8');
const url = log.match(/dsh web: (http:\/\/127\.0\.0\.1:16958\/\?token=[^\s]+)/)?.[1];
assert.ok(url);
const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 303);
const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
const response = await fetch('http://127.0.0.1:16958/api/settings/describe', {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'settings/describe', payload: { args: {} } }),
  signal: AbortSignal.timeout(10000),
});
assert.equal(response.status, 200);
const frame = await response.json(); assert.equal(frame.result?.ok, true);
const namespaces = frame.result.value.namespaces;
const credentials = namespaces.filter(item => /credential/i.test(item.ns));
console.log(JSON.stringify({ namespaceIds: namespaces.map(item => item.ns),
  credentialSettings: credentials.map(item => ({ ns: item.ns, revision: item.revision,
    path: item.value?.path, overridden: Object.hasOwn(item.user ?? {}, 'path'),
    schema: item.schema })) }));
