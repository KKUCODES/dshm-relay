import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

// 仅隔离原生窗口观察器；此诊断不作为Android完整链路通过证据。
const execute = promisify(execFile), run = randomUUID(), id = run.slice(0, 8);
const host = resolve('../plugin/artifacts/official-dsh-alpha2');
const folder = resolve(host, 'home/official-remote-test-project', id), path = resolve(folder, `dshm-official-${id}.txt`);
const script = resolve('tests/support/official-desktop-window.ps1');
const inspect = async mode => JSON.parse((await execute('pwsh.exe', ['-File', script, '-Mode', mode, '-FilePath', path],
  { cwd: process.cwd(), windowsHide: true })).stdout);
const text = 'DSHM_NATIVE_OBSERVER\n中文 🙂\nTHIRD_LINE\n';
const report = { run, scope: 'native-window-observer-diagnosis', passed: false, path };
await mkdir(folder, { recursive: true }); await writeFile(path, text, { flag: 'wx' });
try {
  report.before = await inspect('snapshot');
  const receipt = JSON.parse(await readFile(resolve(host, 'official-web-receipt.json'), 'utf8'));
  process.kill(receipt.pid, 0); assert.equal(receipt.version, '0.2.1-alpha.2');
  const log = await readFile(receipt.privateLog, 'utf8');
  const url = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1];
  assert.equal(new URL(url).origin, 'http://127.0.0.1:16958');
  const login = await fetch(url, { redirect: 'manual' }); assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0], rpcId = randomUUID();
  const response = await fetch('http://127.0.0.1:16958/api/session/openWorkspacePath', { method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/openWorkspacePath', payload: { args: { request: { path } } } }),
    signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200); const frame = await response.json();
  assert.equal(frame.rpcId, rpcId); assert.equal(frame.result.ok, true); assert.equal(frame.result.value.opened, true);
  await new Promise(done => setTimeout(done, 1500));
  report.window = await inspect('opened'); report.passed = true;
} catch (error) { report.failure = error.stderr ?? error.message; process.exitCode = 1; }
finally {
  for (let attempt = 0; attempt < 15; attempt++) {
    report.cleanup = await inspect('cleanup');
    if (!report.cleanup.ownedNotepadWindows && !report.cleanup.ownedExplorerWindows) break;
    await new Promise(done => setTimeout(done, 250));
  }
  assert.equal(report.cleanup.ownedNotepadWindows, 0); assert.equal(report.cleanup.ownedExplorerWindows, 0);
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), createHash('sha256').update(text).digest('hex'));
  await unlink(path);
  await rmdir(folder);
  await writeFile(resolve('artifacts/official-plugin-only', `desktop-observer-${run}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report));
}
