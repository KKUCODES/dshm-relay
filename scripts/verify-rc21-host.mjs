import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { buildGateway } from '../packages/gateway/dist/app.js';
import { Store } from '../packages/gateway/dist/store.js';

// 原官方CLI＋自有候选＋生产中转实现。只操作此轮独立home/数据库/批准设备。
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'artifacts/rc21-host');
await mkdir(output, { recursive: true }); const run = await mkdtemp(resolve(output, 'run-'));
const version = process.env.DSHM_CHECK_VERSION ?? '0.2.1-rc.2';
const sdk = resolve(process.env.DSHM_CHECK_SDK ?? '../plugin/artifacts/ci/sdk/rc21');
const cli = resolve(sdk, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
assert.equal(JSON.parse(await readFile(resolve(sdk, 'node_modules/@deepseek-ai/dsh/package.json'))).version, version);
const archive = resolve(process.env.DSHM_CHECK_PLUGIN ?? '../plugin/artifacts/rc21-packages/dsh-mobile-plugin-0.1.85-latest.0.tgz');
const origin = 'http://127.0.0.1:18793', hostOrigin = 'http://127.0.0.1:16977';
const enrollmentToken = randomBytes(32).toString('base64url'), db = new PGlite(resolve(run, 'database'));
const database = { query: (sql, values) => db.query(sql, values), transaction: work => db.transaction(tx => work({ query: (sql, values) => tx.query(sql, values) })), close: () => db.close() };
const store = new Store(database); await store.migrate();
const gateway = await buildGateway({ store, publicOrigin: origin, registrationMode: 'private', enrollmentToken });
await gateway.listen({ host: '127.0.0.1', port: 18793 });
const env = { ...process.env, DSH_HOME: resolve(run, 'home'), DSH_TELEMETRY_DISABLED: '1', npm_config_registry: 'https://registry.npmjs.org',
  npm_config_store_dir: resolve(output, 'p'), npm_config_cache: resolve(output, 'npm-cache') };
for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|DSH_TELEMETRY_OTLP_URL|DEEPSEEK_API_KEY|OPENAI_API_KEY|DSH_MOBILE_)/.test(key)) delete env[key];
const log = resolve(run, 'host.private.log'); await writeFile(log, '', { mode: 0o600 });
const state = { run, version, origin, hostOrigin, stage: 'installing', noInference: true, officialDshModified: false };
const save = async () => {
  await writeFile(resolve(output, 'state.next.json'), JSON.stringify(state, null, 2));
  await rename(resolve(output, 'state.next.json'), resolve(output, 'state.json'));
}; await save();
const wait = ms => new Promise(done => setTimeout(done, ms));
let child, cookie, lastCommand, done = false;
const kill = process => { if (process?.exitCode === null) execFileSync('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); };
const start = args => {
  const process = spawn(globalThis.process.execPath, [cli, ...args], { cwd: sdk, env, windowsHide: true });
  process.stdout.on('data', chunk => void appendFile(log, chunk)); process.stderr.on('data', chunk => void appendFile(log, chunk)); return process;
};
async function manage(body) {
  const response = await fetch(hostOrigin + '/api/dsh-mobile', { headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const value = await response.json(); if (!response.ok || value.error) throw Error(`management_${response.status}:${value.error ?? ''}`); return value;
}
try {
  child = start(['plugin', '--profile', 'web', 'add', archive]);
  for (const deadline = Date.now() + 120000; child.exitCode === null && Date.now() < deadline;) await wait(100);
  if (child.exitCode === null) { kill(child); throw Error('official_install_timeout'); }
  assert.equal(child.exitCode, 0, 'official_install_failed');
  child = start(['web', '--no-open', '--host', '127.0.0.1', '--port', '16977']); state.pid = child.pid; state.stage = 'starting'; await save();
  let buffered = '', login;
  child.stdout.on('data', bytes => { buffered = (buffered + bytes).slice(-65536); login ??= buffered.match(/http:\/\/127\.0\.0\.1:16977\/\?token=[^\s]+/)?.[0]; });
  for (const deadline = Date.now() + 90000; !login && child.exitCode === null && Date.now() < deadline;) await wait(100);
  assert.ok(login, 'official_start_failed');
  const response = await fetch(login, { redirect: 'manual' }); cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  await manage({ action: 'setup', origin, name: 'DSHM rc.2 隔离验证', enrollmentToken }); await manage({ action: 'enable' });
  const rpc = async (method, args) => {
    const rpcId = randomUUID();
    const response = await fetch(hostOrigin + '/api/' + method, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) });
    const frame = await response.json(); assert.equal(frame.rpcId, rpcId); assert.equal(frame.result.ok, true, method);
    return frame.result.value;
  };
  const workspacePath = resolve(run, 'rc21-check-project'); await mkdir(workspacePath);
  const registered = await rpc('workspace/create', { request: { path: workspacePath } });
  const sessionId = 'rc21-check-' + randomUUID();
  await rpc('session/create', { request: { workspaceId: registered.workspace.workspaceId, sessionId } });
  await rpc('session/rename', { request: { sessionId, title: 'DSHM compatibility check' } });
  state.sessionId = sessionId;
  state.stage = 'ready'; await save(); console.log(JSON.stringify({ stage: state.stage, version, origin }));
  const pair = async () => {
    const pairing = await manage({ action: 'pair' });
    await writeFile(resolve(output, 'pair.private.json'), JSON.stringify({ run, link: pairing.link }), { mode: 0o600 });
  };
  await pair();
  for (const deadline = Date.now() + 1200000; !done && Date.now() < deadline;) {
    let command; try { command = JSON.parse(await readFile(resolve(output, 'command.json'), 'utf8')); } catch {}
    if (command?.run === run && command.id !== lastCommand) {
      lastCommand = command.id;
      try {
        if (command.action === 'pair') await pair();
        else if (command.action === 'approve') {
          const matches = (await manage()).devices.filter(device => device.name === command.name && device.fingerprint === command.fingerprint && device.status === 'pending');
          assert.equal(matches.length, 1); await manage({ action: 'approve', deviceId: matches[0].id });
        } else if (command.action === 'revoke') {
          for (const device of (await manage()).devices.filter(device => device.status === 'active')) await manage({ action: 'revoke', deviceId: device.id });
        } else if (command.action === 'stop') done = true;
        else throw Error('unknown_test_command');
        state.command = { id: command.id, completed: true };
      } catch (error) { state.command = { id: command.id, completed: false, error: error.message }; }
      state.devices = (await manage()).devices.map(({ name, status, management }) => ({ name, status, management })); await save();
    }
    await wait(100);
  }
} catch (error) { state.failure = error.message; process.exitCode = 1; }
finally {
  if (cookie) for (const device of (await manage().catch(() => ({ devices: [] }))).devices.filter(device => device.status === 'active')) await manage({ action: 'revoke', deviceId: device.id }).catch(() => {});
  kill(child); await gateway.close(); await db.close(); state.stage = 'stopped'; await save(); console.log(JSON.stringify(state));
}
