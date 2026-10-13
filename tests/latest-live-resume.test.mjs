import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { latestLiveFlags, readLatestLiveResume } from '../scripts/latest-live-resume.mjs';

test('source launch must resume the existing test home and rejects ambiguous flags', () => {
  assert.deepEqual(latestLiveFlags(['--source', '--resume']), { source: true, resume: true });
  assert.deepEqual(latestLiveFlags([]), { source: false, resume: false });
  assert.deepEqual(latestLiveFlags(['--resume']), { source: false, resume: true });
  assert.deepEqual(latestLiveFlags(['--source', '--resume', '--diagnose-output']), { source: true, resume: true });
  assert.deepEqual(latestLiveFlags(['--resume', '--diagnose-blocked']), { source: false, resume: true });
  assert.deepEqual(latestLiveFlags(['--source', '--resume', '--diagnose-blocked']), { source: true, resume: true });
  assert.deepEqual(latestLiveFlags(['--resume', '--diagnose-auto-review']), { source: false, resume: true });
  assert.deepEqual(latestLiveFlags(['--source', '--resume', '--diagnose-auto-review']), { source: true, resume: true });
  assert.throws(() => latestLiveFlags(['--diagnose-auto-review']));
  assert.throws(() => latestLiveFlags(['--resume', '--diagnose-blocked', '--diagnose-auto-review']));
  assert.deepEqual(latestLiveFlags(['--resume', '--diagnose-auto-review-never']), { source: false, resume: true });
  assert.deepEqual(latestLiveFlags(['--resume', '--source', '--diagnose-auto-review-never']), { source: true, resume: true });
  assert.throws(() => latestLiveFlags(['--diagnose-auto-review-never']));
  assert.throws(() => latestLiveFlags(['--resume', '--diagnose-auto-review', '--diagnose-auto-review-never']));
  assert.deepEqual(latestLiveFlags(['--resume', '--diagnose-install-timeout']), { source: false, resume: true });
  assert.deepEqual(latestLiveFlags(['--resume', '--source', '--diagnose-install-timeout']), { source: true, resume: true });
  assert.throws(() => latestLiveFlags(['--diagnose-install-timeout']));
  assert.throws(() => latestLiveFlags(['--resume', '--diagnose-install-timeout', '--diagnose-auto-review']));
  assert.deepEqual(latestLiveFlags(['--resume', '--diagnose-subagent-depth']), { source: false, resume: true });
  assert.deepEqual(latestLiveFlags(['--resume', '--source', '--diagnose-subagent-depth']), { source: true, resume: true });
  assert.throws(() => latestLiveFlags(['--diagnose-subagent-depth']));
  assert.throws(() => latestLiveFlags(['--resume', '--diagnose-subagent-depth', '--diagnose-blocked']));
  for (const flags of [['--source'], ['--resume', '--resume'], ['--source', '--resume', '--source'], ['--other'], ['--resume', '--diagnose-output'], ['--diagnose-blocked'], ['--source', '--resume', '--diagnose-output', '--diagnose-blocked']])
    assert.throws(() => latestLiveFlags(flags));
});

test('SDK SEA requires the original stopped home and rejects other carriers or diagnostics', () => {
  assert.deepEqual(latestLiveFlags(['--resume', '--sdk-sea']), { source: false, resume: true, sdkSea: true });
  for (const flags of [['--sdk-sea'], ['--resume', '--source', '--sdk-sea'],
    ['--resume', '--sdk-sea', '--sdk-sea'], ...['output', 'blocked', 'auto-review', 'auto-review-never', 'install-timeout', 'subagent-depth']
      .map(name => ['--resume', '--sdk-sea', '--diagnose-' + name])])
    assert.throws(() => latestLiveFlags(flags));
});

test('Electron uses the verified candidate and original home without mixing other carriers', () => {
  const base=['--resume','--electron','--review-candidate=candidate-package-check-1xqe3A'];
  const expected={source:false,resume:true,electron:true,electronRetry:false,electronAttempt:1,reviewCandidate:'candidate-package-check-1xqe3A'};
  assert.deepEqual(latestLiveFlags(base),expected);
  assert.deepEqual(latestLiveFlags([...base,'--electron-encoding-3']),{...expected,electronEncoding:true});
  for (const flags of [['--electron-encoding-3'], ['--resume','--electron-encoding-3'],
    [...base,'--electron-encoding-3','--electron-retry'], [...base,'--electron-encoding-3','--electron-start-attempt-3']])
    assert.throws(() => latestLiveFlags(flags));
  assert.deepEqual(latestLiveFlags([...base,'--electron-retry']),{...expected,electronRetry:true,electronAttempt:2});
  for(const attempt of [3,4])assert.deepEqual(latestLiveFlags([...base,'--electron-retry',`--electron-start-attempt-${attempt}`]),{...expected,electronRetry:true,electronAttempt:attempt});
  for(const flags of [base.filter(flag=>flag!=='--resume'),base.filter(flag=>!flag.startsWith('--review-candidate=')),
    ['--resume','--electron','--review-candidate=candidate-package-check-other'],['--resume','--electron-retry'],
    [...base,'--source'],[...base,'--sdk-sea'],[...base,'--diagnose-blocked'],[...base,'--electron-start-attempt-3'],
    [...base,'--electron-retry','--electron-start-attempt-3','--electron-start-attempt-4']])assert.throws(()=>latestLiveFlags(flags));
});

test('review candidate only consumes an explicit checked directory in the stopped original home', () => {
  const candidate = '--review-candidate=candidate-package-check-abc123';
  assert.deepEqual(latestLiveFlags(['--resume', candidate]), { source: false, resume: true,
    reviewCandidate: 'candidate-package-check-abc123' });
  assert.deepEqual(latestLiveFlags(['--resume', '--source', candidate]), { source: true, resume: true,
    reviewCandidate: 'candidate-package-check-abc123' });
  assert.deepEqual(latestLiveFlags(['--resume', '--sdk-sea', candidate]), { source: false, resume: true, sdkSea: true,
    reviewCandidate: 'candidate-package-check-abc123' });
  for (const flags of [[candidate], ['--sdk-sea', candidate], ['--resume', '--sdk-sea', '--source', candidate],
    ['--resume', '--sdk-sea', '--diagnose-blocked', candidate], ['--resume', '--diagnose-blocked', candidate],
    ['--resume', candidate, '--review-candidate=candidate-package-check-other'],
    ['--resume', '--review-candidate=../candidate'], ['--resume', '--review-candidate=candidate-package-check-a/b']])
    assert.throws(() => latestLiveFlags(flags));
});

async function fixture(work) {
  const artifacts = resolve(import.meta.dirname, '../artifacts');
  await mkdir(artifacts, { recursive: true });
  const runtime = await mkdtemp(resolve(artifacts, 'live-resume-'));
  try {
    const home = resolve(runtime, 'live-homes', randomUUID());
    const workspacePath = resolve(home, 'test-project');
    await mkdir(workspacePath, { recursive: true });
    await mkdir(resolve(home, 'gateway-db'));
    const child = spawn(process.execPath, ['-e', ''], { cwd: runtime, windowsHide: true, stdio: 'ignore' });
    const [code] = await once(child, 'close'); assert.equal(code, 0);
    const state = { target: '0.2.1-alpha.1', ready: true, home, workspacePath,
      origin: 'http://127.0.0.1:16901', sessionId: 'latest-live-' + randomUUID(),
      supervisorPid: child.pid, hostPid: child.pid };
    const statePath = resolve(runtime, 'latest-live-state.json');
    const save = () => writeFile(statePath, JSON.stringify(state));
    await save();
    await writeFile(resolve(home, 'cleanup.json'), JSON.stringify({ stopped: true, hostPid: child.pid }));
    await work({ runtime, home, state, statePath, save });
  } finally {
    // fixture只能清理mkdtemp创建且仍在本项目artifacts下的目录。
    assert.equal(resolve(runtime, '..'), artifacts);
    await rm(runtime, { recursive: true });
  }
}

test('stopped original test home resumes without rewriting its state', async () => fixture(async ({ runtime, state, statePath }) => {
  const before = await readFile(statePath);
  assert.deepEqual(await readLatestLiveResume(runtime), { state, port: 16901 });
  assert.deepEqual(await readFile(statePath), before);
}));

test('a live previous process prevents resume', async () => fixture(async ({ runtime, state, save }) => {
  state.supervisorPid = process.pid; await save();
  await assert.rejects(readLatestLiveResume(runtime), /latest_live_previous_process_still_running/);
}));

test('resume rejects changed target, home boundary and gateway identity', async () => fixture(async ({ runtime, state, save }) => {
  const original = { ...state };
  for (const change of [
    { target: '0.1.6-alpha.2' }, { home: resolve(runtime, 'outside') },
    { workspacePath: resolve(state.home, 'other-project') },
    { origin: 'https://example.com:16901' }, { origin: 'http://127.0.0.1:16901/?other=1' },
    { origin: 'http://user:password@127.0.0.1:16901' },
  ]) {
    Object.assign(state, original, change); await save();
    await assert.rejects(readLatestLiveResume(runtime));
  }
}));

test('resume requires owned cleanup proof', async () => fixture(async ({ runtime, home, state }) => {
  for (const cleanup of [{ stopped: false, hostPid: state.hostPid }, { stopped: true, hostPid: process.pid }]) {
    await writeFile(resolve(home, 'cleanup.json'), JSON.stringify(cleanup));
    await assert.rejects(readLatestLiveResume(runtime));
  }
}));

test('unexpected stop recovery is explicit, release only and refuses any live gateway', async () => fixture(async ({ runtime, home, state, statePath, save }) => {
  assert.deepEqual(latestLiveFlags(['--resume', '--recover-stopped']), { source: false, resume: true, recoverStopped: true });
  for (const flags of [['--recover-stopped'], ['--resume', '--recover-stopped', '--source'],
    ['--resume', '--recover-stopped', '--diagnose-blocked']]) assert.throws(() => latestLiveFlags(flags));
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  state.origin = 'http://127.0.0.1:' + server.address().port; state.executionMode = 'release'; await save();
  const before = await readFile(statePath), cleanupBefore = await readFile(resolve(home, 'cleanup.json'));
  try { await assert.rejects(readLatestLiveResume(runtime, { recoverStopped: true }), /gateway_still_running/); }
  finally { await new Promise(done => server.close(done)); }
  assert.deepEqual(await readLatestLiveResume(runtime, { recoverStopped: true }), { state, port: Number(new URL(state.origin).port) });
  assert.deepEqual(await readFile(statePath), before);
  assert.deepEqual(await readFile(resolve(home, 'cleanup.json')), cleanupBefore);
  state.executionMode = 'source'; await save(); await assert.rejects(readLatestLiveResume(runtime, { recoverStopped: true }));
}));
