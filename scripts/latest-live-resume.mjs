import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createConnection } from 'node:net';

const uuid = /^[0-9a-f-]{36}$/;
export function latestLiveFlags(flags) {
assert.ok(flags.every(flag => ['--resume', '--recover-stopped', '--source', '--sdk-sea', '--electron', '--electron-encoding-3', '--electron-retry', '--electron-start-attempt-3', '--electron-start-attempt-4', '--diagnose-output', '--diagnose-blocked', '--diagnose-auto-review', '--diagnose-auto-review-never', '--diagnose-install-timeout', '--diagnose-subagent-depth'].includes(flag)
    || /^--review-candidate=candidate-package-check-[A-Za-z0-9]+$/.test(flag)), 'latest_live_unknown_flag');
  assert.equal(new Set(flags).size, flags.length, 'latest_live_duplicate_flag');
  const source = flags.includes('--source'), resume = flags.includes('--resume');
  const recoverStopped = flags.includes('--recover-stopped');
  assert.ok(!recoverStopped || flags.length === 2 && resume, 'Recovery is only for the original release entry');
  const sdkSea = flags.includes('--sdk-sea');
  const candidates = flags.filter(flag => flag.startsWith('--review-candidate=')); assert.ok(candidates.length <= 1);
  const reviewCandidate = candidates[0]?.slice('--review-candidate='.length);
  const electron = flags.includes('--electron');
  const electronRetry = flags.includes('--electron-retry');assert.ok(!electronRetry || electron);
  const electronEncoding = flags.includes('--electron-encoding-3');
  assert.ok(!electronEncoding || electron && !electronRetry, 'latest_live_encoding_requires_fresh_electron_attempt');
  const attempts=flags.filter(flag=>flag.startsWith('--electron-start-attempt-'));assert.ok(attempts.length<=1);
  const electronAttempt = attempts.length ? Number(attempts[0].slice('--electron-start-attempt-'.length)) : electronRetry ? 2 : 1;
  assert.ok(!electronEncoding || attempts.length === 0);
  assert.ok(electronAttempt<3 || electronRetry);
  assert.ok(!electron || resume && !source && !sdkSea && reviewCandidate === 'candidate-package-check-1xqe3A'
    && !flags.some(flag => flag.startsWith('--diagnose-')), 'latest_live_electron_requires_original_home_and_verified_candidate');
  // SDK载体和外部候选插件分别核验；组合仍限已停止的原home，不能混入诊断。
  assert.ok(!reviewCandidate || resume && !flags.some(flag => flag.startsWith('--diagnose-')),
    'latest_live_review_requires_original_home_and_normal_carrier');
  assert.ok(!sdkSea || resume, 'latest_live_sdk_requires_original_home');
  assert.ok(!(sdkSea && source), 'latest_live_carriers_must_be_separate');
  assert.ok(!sdkSea || !flags.some(flag => flag.startsWith('--diagnose-')), 'latest_live_sdk_diagnostics_not_enabled');
  assert.ok(!source || resume, 'latest_live_source_requires_original_home');
  assert.ok(!flags.includes('--diagnose-output') || source, 'latest_live_output_diagnostic_requires_source');
  assert.ok(!flags.includes('--diagnose-blocked') || resume, 'latest_live_blocked_diagnostic_requires_original_home');
  assert.ok(!flags.includes('--diagnose-auto-review') || resume, 'latest_live_auto_review_requires_original_home');
  assert.ok(!flags.includes('--diagnose-auto-review-never') || resume, 'latest_live_auto_review_never_requires_original_home');
  assert.ok(!flags.includes('--diagnose-install-timeout') || resume, 'latest_live_install_timeout_requires_original_home');
  assert.ok(!flags.includes('--diagnose-subagent-depth') || resume, 'latest_live_subagent_depth_requires_original_home');
  assert.ok(flags.filter(flag => flag.startsWith('--diagnose-')).length <= 1, 'latest_live_diagnostics_must_be_separate');
  return { source, resume, ...(recoverStopped ? { recoverStopped: true } : {}), ...(sdkSea ? { sdkSea: true } : {}), ...(electron ? {electron:true,electronRetry,electronAttempt,...(electronEncoding ? {electronEncoding:true} : {})} : {}), ...(reviewCandidate ? { reviewCandidate } : {}) };
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// 恢复只能接续已停止的本项目测试环境；不得重新注册电脑或访问任意DSH_HOME。
export async function readLatestLiveState(runtime) {
  const state = JSON.parse(await readFile(resolve(runtime, 'latest-live-state.json'), 'utf8'));
  assert.equal(state.target, '0.2.1-alpha.1');
  assert.equal(state.ready, true);
  const name = relative(resolve(runtime, 'live-homes'), state.home);
  assert.match(name, uuid);
  const root = await realpath(resolve(runtime, 'live-homes'));
  assert.equal(await realpath(state.home), resolve(root, name));
  assert.equal(resolve(state.workspacePath), resolve(state.home, 'test-project'));
  assert.equal(await realpath(state.workspacePath), resolve(await realpath(state.home), 'test-project'));
  assert.equal(await realpath(resolve(state.home, 'gateway-db')), resolve(await realpath(state.home), 'gateway-db'));
  const origin = new URL(state.origin);
  assert.equal(origin.protocol, 'http:');
  assert.equal(origin.hostname, '127.0.0.1');
  assert.equal(origin.origin, state.origin);
  assert.ok(Number(origin.port) > 0 && Number(origin.port) <= 65535);
  assert.equal(origin.username, ''); assert.equal(origin.password, '');
  assert.match(state.sessionId, /^latest-live-[0-9a-f-]{36}$/);
  return { state, port: Number(origin.port) };
}

export async function readLatestLiveResume(runtime, {electronStartupRetry=false,electronStartupAttempt=1,recoverStopped=false}={}) {
  const result = await readLatestLiveState(runtime);
  const { state } = result;
  for (const pid of [state.supervisorPid, state.hostPid]) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.equal(alive(pid), false, 'latest_live_previous_process_still_running');
  }
  const cleanup = JSON.parse(await readFile(resolve(state.home, 'cleanup.json'), 'utf8'));
  if (recoverStopped) {
    // 异常结束没有本轮退出回执；单独核验实际停机并留证，不能伪造正常 cleanup。
    assert.equal(electronStartupRetry, false); assert.equal(state.executionMode, 'release');
    assert.equal(state.reviewCandidate, undefined);
    assert.equal(alive(cleanup.hostPid), false);
    const origin = new URL(state.origin);
    await new Promise((done, fail) => {
      const socket = createConnection({ host: origin.hostname, port: result.port });
      socket.once('connect', () => { socket.destroy(); fail(Error('latest_live_gateway_still_running')); });
      socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? done() : fail(error); });
      socket.setTimeout(3000, () => { socket.destroy(); fail(Error('latest_live_gateway_state_unknown')); });
    });
    const bytes = await readFile(resolve(runtime, 'latest-live-state.json'));
    assert.deepEqual(JSON.parse(bytes), state);
    await writeFile(resolve(runtime, 'latest-live-stopped-recovery-' + randomUUID() + '.json'), JSON.stringify({
      at: new Date().toISOString(), home: state.home, state, previousCleanup: cleanup,
      stateSha256: createHash('sha256').update(bytes).digest('hex'),
      previousProcessesAbsent: true, gatewayConnectionRefused: true, normalCleanupNotClaimed: true,
    }, null, 2), { flag: 'wx' });
    return result;
  }
  if (electronStartupRetry) {
    assert.equal(state.executionMode,'release');
    const failure = JSON.parse(await readFile(resolve(runtime,'electron-attempt-1/start-diagnostic.json')));
    const preparation = JSON.parse(await readFile(resolve(runtime,'electron-attempt-1/preparation.json')));
    assert.equal(failure.home,state.home);assert.equal(preparation.home,state.home);
    assert.equal(failure.originalControllerStartFailed,true);assert.equal(failure.code,1);
    assert.equal(failure.ownedCleanupRequested,true);assert.equal(alive(failure.pid),false);
    assert.equal(failure.previousExit.executionMode,'electron');assert.equal(failure.previousExit.stopRequested,true);
    if(electronStartupAttempt===4){
      const diagnostic=JSON.parse(await readFile(resolve(runtime,'electron-attempt-1/start-diagnostic-attempt-2.json')));
      assert.equal(diagnostic.home,state.home);assert.equal(diagnostic.originalHostReadyUrl,true);
      assert.equal(diagnostic.loginStatus,303);assert.equal(diagnostic.mobileEndpointStatus,200);
      assert.equal(diagnostic.previousExit.hostPid,cleanup.hostPid);assert.equal(alive(diagnostic.pid),false);
      const exit=JSON.parse(await readFile(resolve(state.home,`host-exit-${cleanup.hostPid}.json`)));
      assert.deepEqual(exit,diagnostic.previousExit);
      await writeFile(resolve(runtime,'electron-attempt-1/start-attempt-3-failed.json'),JSON.stringify({
        at:new Date().toISOString(),home:state.home,exit,cleanup,originalStateUnchanged:true}),{flag:'wx'});
    }else if(failure.previousExit.hostPid!==cleanup.hostPid){
      const retry=JSON.parse(await readFile(resolve(runtime,'electron-attempt-1/retry-preparation.json')));
      const exit=JSON.parse(await readFile(resolve(state.home,`host-exit-${cleanup.hostPid}.json`)));
      assert.equal(retry.attempt,2);assert.equal(retry.home,state.home);
      assert.equal(exit.executionMode,'electron');assert.equal(exit.stopRequested,true);assert.equal(exit.code,1);
      assert.equal(exit.hostPid,cleanup.hostPid);assert.ok(Date.parse(exit.at)>Date.parse(retry.at));
      await writeFile(resolve(runtime,'electron-attempt-1/start-attempt-2-failed.json'),JSON.stringify({
        at:new Date().toISOString(),home:state.home,exit,cleanup,originalStateUnchanged:true}),{flag:'wx'});
    }
    assert.equal(alive(cleanup.hostPid),false);
  } else assert.equal(cleanup.hostPid, state.hostPid);
  assert.equal(cleanup.stopped, true);
  return result;
}
