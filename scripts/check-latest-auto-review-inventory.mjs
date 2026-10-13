// 使用原发布包清单提供方复现诊断插件的真实解析入口，不发送模型请求。
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const phase = process.argv[2]; assert.ok(['before', 'after'].includes(phase));
const runtime = resolve(import.meta.dirname, '../../plugin/artifacts/latest-runtime-check');
const entryPath = resolve(runtime, 'node_modules/@deepseek-ai/dsh-plugin-package-inventory-deepseek/lib/index.js');
// 原const enum在发布产物中内联；锚点漂移时拒绝沿用数字。
assert.match(await readFile(entryPath, 'utf8'), /entry\.fiber\?\.state === 2/);
const { apply } = await import(pathToFileURL(entryPath));
let provider;
const ctx = { baseUrl: import.meta.url, get: () => undefined,
  loader: { entries: () => [{ options: { name: pathToFileURL(resolve(import.meta.dirname,
    '../tests/support/latest-auto-review-observer/index.mjs')).href }, disabled: false,
    fiber: { state: 2 }, parent: { tree: { ctx: { baseUrl: import.meta.url } } } }] },
  deepseekLlmApiExtensions: { register: (field, value) => { assert.equal(field, 'dsh_plugin_packages'); provider = value; } } };
apply(ctx, { enabled: true });
const report = { phase, originalPackage: '@deepseek-ai/dsh-plugin-package-inventory-deepseek@0.2.1-alpha.1', passed: false };
try {
  const result = await provider.prepare({ body: {}, signal: new AbortController().signal });
  report.packages = result.value.packages;
  assert.equal(phase, 'after');
  assert.deepEqual(result.value.packages, [{ name: '@dsh-mobile/latest-auto-review-observer', version: '0.0.0' }]);
  report.passed = true;
} catch (error) {
  report.error = error.message;
  if (phase === 'before') { assert.match(error.message, /backend.*package\.json must declare non-empty name and version/); report.passed = true; }
  else { process.exitCode = 1; }
}
await writeFile(resolve(runtime, 'latest-auto-review-inventory-' + phase + '.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report));
