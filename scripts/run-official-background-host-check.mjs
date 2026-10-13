import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'artifacts/official-plugin-only');
const check = process.argv[2] ?? 'host';
assert.ok(['host', 'stop', 'core', 'review', 'history', 'history-inflight', 'ptc', 'skills', 'child-stop', 'external-child', 'references', 'pairing', 'plugin-layout', 'export', 'feedback', 'feedback-history', 'prompt-sending', 'prompt-process', 'prompt-host', 'attachment-sending', 'attachment-process', 'attachment-host', 'files-share', 'files-desktop', 'files-presented'].includes(check));
const reportName = check === 'pairing' ? 'pairing-vitest' : check === 'references' ? 'references-vitest' : check === 'export' ? 'session-export-vitest' : check === 'feedback' ? 'feedback-vitest'
  : check === 'feedback-history' ? 'feedback-history-vitest' : check === 'prompt-sending' ? 'prompt-sending-vitest'
  : check === 'prompt-process' ? 'prompt-process-vitest' : check === 'prompt-host' ? 'prompt-host-vitest'
  : check === 'attachment-sending' ? 'attachment-sending-vitest' : check === 'attachment-process' ? 'attachment-process-vitest'
  : check === 'attachment-host' ? 'attachment-host-vitest' : check === 'files-share' ? 'file-share-vitest'
  : check === 'files-desktop' ? 'file-desktop-vitest' : check === 'files-presented' ? 'file-presented-vitest'
  : check === 'review' ? 'file-review-vitest' : check === 'history' ? 'long-history-vitest'
  : check === 'history-inflight' ? 'history-inflight-vitest' : check === 'ptc' ? 'ptc-vitest' : check === 'skills' ? 'skills-vitest' : check === 'child-stop' ? 'child-stop-vitest' : check === 'external-child' ? 'external-child-vitest' : check === 'plugin-layout' ? 'plugin-layout-vitest' : `background-${check}-vitest`;
const receipt = JSON.parse(await readFile(resolve(root, '../plugin/artifacts/official-dsh-alpha2/official-web-receipt.json'), 'utf8'));
assert.equal(receipt.stage, 'plugin-ready'); assert.equal(receipt.port, 16958); assert.equal(receipt.entry, 'pnpm dsh web');
process.kill(receipt.pid, 0);
const pnpm = 'F:/Program Files/nodejs/node_global/node_modules/pnpm/bin/pnpm.cjs';
assert.equal((await stat(pnpm)).isFile(), true);
const before = new Set(await readdir(output)), started = Date.now();
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^DSHM_OFFICIAL_.*_CHECK$/.test(key)) delete env[key];
Object.assign(env, { DSHM_OFFICIAL_ANDROID_CHECK: '1', DSHM_OFFICIAL_INFERENCE_CHECK: '1', DSHM_OFFICIAL_APP_CHECK: '1',
  DSHM_OFFICIAL_ALPHA2_CHECK: '1',
  DSHM_OFFICIAL_OWNED_LAUNCH_PID: String(receipt.pid),
  DSHM_OFFICIAL_RESTART_PNPM_CLI: pnpm, DSHM_ANDROID_SERIAL: '127.0.0.1:16384',
  DSHM_ADB_PATH: 'C:/Users/KKirin/AppData/Local/Android/Sdk/platform-tools/adb.exe' });
assert.ok(!env.NODE_OPTIONS);
if (check === 'export') env.DSHM_OFFICIAL_SESSION_EXPORT_CHECK = '1';
else if (check === 'review') env.DSHM_OFFICIAL_REVIEW_CHECK = '1';
else if (check === 'history') env.DSHM_OFFICIAL_HISTORY_CHECK = '1';
else if (check === 'history-inflight') env.DSHM_OFFICIAL_HISTORY_INFLIGHT_CHECK = '1';
else if (check === 'ptc') env.DSHM_OFFICIAL_PTC_CHECK = '1';
else if (check === 'skills') env.DSHM_OFFICIAL_SKILLS_CHECK = '1';
else if (check === 'child-stop') env.DSHM_OFFICIAL_CHILD_STOP_CHECK = '1';
else if (check === 'external-child') env.DSHM_OFFICIAL_EXTERNAL_CHILD_CHECK = '1';
else if (check === 'references') env.DSHM_OFFICIAL_REFERENCE_CHECK = '1';
else if (check === 'pairing') env.DSHM_OFFICIAL_PAIRING_CHECK = '1';
else if (check === 'plugin-layout') Object.assign(env, { DSHM_OFFICIAL_PLUGIN_CHECK: '1', DSHM_OFFICIAL_PLUGIN_LAYOUT_CHECK: '1' });
else if (check === 'feedback') env.DSHM_OFFICIAL_FEEDBACK_CHECK = '1';
else if (check === 'feedback-history') env.DSHM_OFFICIAL_FEEDBACK_HISTORY_CHECK = '1';
else if (check === 'prompt-sending') env.DSHM_OFFICIAL_PROMPT_SENDING_CHECK = '1';
else if (check === 'prompt-process') env.DSHM_OFFICIAL_PROMPT_PROCESS_CHECK = '1';
else if (check === 'prompt-host') env.DSHM_OFFICIAL_PROMPT_HOST_CHECK = '1';
else if (check === 'attachment-sending') env.DSHM_OFFICIAL_ATTACHMENT_SENDING_CHECK = '1';
else if (check === 'attachment-process') env.DSHM_OFFICIAL_ATTACHMENT_PROCESS_CHECK = '1';
else if (check === 'attachment-host') env.DSHM_OFFICIAL_ATTACHMENT_HOST_CHECK = '1';
else if (check === 'files-share') Object.assign(env, { DSHM_OFFICIAL_FILE_CHECK: '1', DSHM_OFFICIAL_FILE_SHARE_CHECK: '1' });
else if (check === 'files-desktop') Object.assign(env, { DSHM_OFFICIAL_FILE_CHECK: '1', DSHM_OFFICIAL_FILE_DESKTOP_CHECK: '1' });
else if (check === 'files-presented') Object.assign(env, { DSHM_OFFICIAL_FILE_CHECK: '1', DSHM_OFFICIAL_FILE_PRESENT_CHECK: '1' });
else if (check !== 'core') env[check === 'host' ? 'DSHM_OFFICIAL_JOB_HOST_CHECK' : 'DSHM_OFFICIAL_JOB_STOP_CHECK'] = '1';
const vitest = resolve(output, reportName + '.json');
const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/official-host.test.ts',
  '--maxWorkers=1', '--reporter=verbose', '--reporter=json', '--outputFile=' + vitest],
{ cwd: root, env, windowsHide: true, stdio: 'inherit' });
assert.ok(child.pid);
const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
const newReports = (await readdir(output)).filter(name => !before.has(name) && /^official-android-[0-9a-f-]+\.json$/.test(name));
assert.ok(newReports.length <= 1);
if (newReports.length) {
  const report = JSON.parse(await readFile(resolve(output, newReports[0]), 'utf8'));
  const raw = JSON.parse(await readFile(vitest, 'utf8'));
  await copyFile(vitest, resolve(output, `${reportName}-${report.run}.json`));
  const tests = raw.testResults?.flatMap(suite => suite.assertionResults ?? []) ?? [];
  const outcome = { run: report.run, exitCode: code, durationSeconds: (Date.now() - started) / 1000,
    desktopPluginVersion: report.desktopPluginVersion,
    unhandledErrors: (raw.numRuntimeErrorTestSuites ?? 0) > 0 || (raw.numUnhandledErrors ?? 0) > 0,
    tests: tests.map(test => ({ status: test.status, duration: test.duration })),
    productsBuilt: false, appInstalled: false, cleanupCompleted: report.cleanupCompleted === true };
  await writeFile(resolve(output, `official-android-${report.run}.outcome.json`), JSON.stringify(outcome, null, 2) + '\n');
  console.log(JSON.stringify({ ...outcome, scope: report.scope, passed: report.passed, stages: report.android?.stages?.length }));
}
process.exitCode = typeof code === 'number' ? code : 1;
