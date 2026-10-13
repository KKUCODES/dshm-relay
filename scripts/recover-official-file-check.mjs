import assert from 'node:assert/strict';
import { readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { buildGateway } from '../packages/gateway/dist/app.js';
import { Store } from '../packages/gateway/dist/store.js';

// 驱动异常退出后只清理明确本轮创建的设备、文件与独立UID，保留失败报告。
const run = process.argv[2];
assert.match(run, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const root = resolve('../plugin/artifacts/official-dsh-plugin-only');
const reportPath = resolve('artifacts/official-plugin-only', 'official-android-' + run + '.json');
const previous = JSON.parse(await readFile(reportPath, 'utf8'));
assert.equal(previous.run, run); assert.equal(previous.passed, false);
assert.equal(previous.scope, 'file-transfer-cancel-disconnect-and-source-change');
const seed = previous.fileRecoveryFixture;
assert.equal(resolve(seed.root), resolve(root, 'home/official-remote-test-project', run.slice(0, 8)));
assert.equal(seed.filename, 'dshm-interruption-' + run.slice(0, 8) + '.txt');
const file = resolve(seed.root, seed.filename), bytes = await readFile(file);
assert.equal(bytes.length, seed.bytes);
assert.equal(createHash('sha256').update(bytes).digest('hex'), seed.sha256);
const exec = promisify(execFile), adbPath = process.env.DSHM_ADB_PATH;
assert.ok(adbPath);
const adb = async (...args) => (await exec(adbPath, ['-s', '127.0.0.1:16384', ...args], { windowsHide: true })).stdout.trim();
const original = async () => {
  const name = 'dev.dshmobile.validation.latesttest', path = await adb('shell', 'pm', 'path', name);
  assert.match(path, /^package:\/data\/app\/[A-Za-z0-9_./=+~-]+\/base\.apk$/);
  const pid = await adb('shell', 'pidof', name); assert.match(pid, /^[1-9]\d*$/);
  const sha256 = (await adb('shell', 'sha256sum', path.slice(8))).split(/\s+/)[0];
  assert.equal(sha256, '58921967f03c2a2d8e6b2c9dfdfc623052dbb7ddbfb291684013d2863111114b');
  return { path, pid, sha256 };
};
const before = await original(), ownUid = 'dev.dshmobile.validation.officialtest';
const receipt = JSON.parse(await readFile(resolve(root, 'official-web-receipt.json'), 'utf8'));
assert.equal(receipt.stage, 'plugin-ready'); process.kill(receipt.pid, 0);
const log = await readFile(receipt.privateLog, 'utf8');
const loginURL = log.match(/dsh web: (http:\/\/127\.0\.0\.1:16955\/\?token=[^\s]+)/)?.[1];
assert.ok(loginURL);
const login = await fetch(loginURL, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 303); const cookie = login.headers.get('set-cookie').split(';')[0];
const request = async (endpoint, body) => {
  const response = await fetch('http://127.0.0.1:16955/api/' + endpoint, { method: body ? 'POST' : 'GET',
    headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200); return response.json();
};
const rpc = async (method, args) => {
  const rpcId = randomUUID(), frame = await request(method, { type: 'client-request', rpcId, method, payload: { args } });
  assert.equal(frame.rpcId, rpcId); assert.equal(frame.result.ok, true); return frame.result.value;
};
const db = new PGlite(resolve('artifacts/official-plugin-only/gateway-data'));
const database = { query: (sql, values) => db.query(sql, values),
  transaction: work => db.transaction(tx => work({ query: (sql, values) => tx.query(sql, values) })), close: () => db.close() };
const gateway = await buildGateway({ store: new Store(database), publicOrigin: 'http://127.0.0.1:16956', registrationMode: 'open', logger: false });
const recovered = { run, previousPassed: false, reason: 'test-worker-heap-exhausted', before };
try {
  await gateway.listen({ host: '127.0.0.1', port: 16956 });
  await adb('shell', 'am', 'force-stop', ownUid);
  assert.equal(await adb('shell', 'run-as', ownUid, 'find', 'cache/remote-downloads', '-maxdepth', '1', '-type', 'f'), '');
  if ((await adb('reverse', '--list')).split('\n').some(line => / tcp:16956 tcp:16956$/.test(line.trim())))
    await adb('reverse', '--remove', 'tcp:16956');
  recovered.testUidStopped = true;
  const rows = (await rpc('session/list', { _request: {} })).items;
  const session = rows.filter(item => item.projections?.values.title === 'DSHM 官方纯插件测试 ' + run.slice(0, 8)
    && resolve(item.cwd) === resolve(seed.root));
  assert.equal(session.length, 1); assert.equal(session[0].running, false);
  await rpc('commands/execute', { agentId: session[0].sessionId, line: '/permission workspace-write', submittedAttachments: [] });
  recovered.sessionId = session[0].sessionId; recovered.testSessionPermissionRestored = true;
  const state = await request('dsh-mobile'); assert.equal(state.origin, 'http://127.0.0.1:16956');
  const devices = state.devices.filter(item => item.status !== 'revoked');
  assert.equal(devices.length, 2);
  const birth = (await stat(reportPath)).birthtimeMs;
  for (const device of devices) {
    assert.ok(['官方纯插件协议验收', 'DSHM 官方纯插件 Android 验收'].includes(device.name));
    const meta = (await db.query('SELECT created_at FROM devices WHERE id=$1', [device.id])).rows[0];
    const createdAt = new Date(meta.created_at).getTime();
    // 第一个协议设备早于首次报告落盘；手机设备在真实模型初始化之后创建。
    assert.ok(createdAt >= birth - 30000 && createdAt <= birth + 180000);
    if (device.management) await request('dsh-mobile', { action: 'management', deviceId: device.id, enabled: false });
    await request('dsh-mobile', { action: 'revoke', deviceId: device.id });
  }
  assert.ok((await request('dsh-mobile')).devices.every(item => item.status === 'revoked'));
  recovered.testDevicesRevoked = devices.map(item => item.id);
  assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), seed.sha256);
  await unlink(file); recovered.testFileRemoved = true;
  await request('dsh-mobile', { action: 'disable' }); recovered.pluginDisabled = true;
  recovered.after = await original(); assert.deepEqual(recovered.after, before);
  recovered.originalAppIdentityUnchanged = true; recovered.completed = true;
} catch (error) { recovered.failure = error.message; throw error; }
finally {
  await gateway.close(); await db.close();
  await writeFile(resolve('artifacts/official-plugin-only', 'file-check-recovery-' + run + '.json'), JSON.stringify(recovered, null, 2) + '\n');
}
console.log(JSON.stringify(recovered));
