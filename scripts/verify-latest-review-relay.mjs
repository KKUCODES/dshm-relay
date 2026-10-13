import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

assert.equal(process.argv.length, 3);
assert.match(process.argv[2], /^candidate-package-check-[A-Za-z0-9]+$/);
const root = resolve(import.meta.dirname, '..');
const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/latest-review-package.test.ts'], {
  cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, DSHM_REVIEW_PACKAGE: process.argv[2] },
});
const code = await new Promise((done, fail) => { child.once('close', done); child.once('error', fail); });
process.exit(code ?? 1);
