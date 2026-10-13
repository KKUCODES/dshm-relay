// 已封存的隔离 SEA 诊断；正式验收不加载。比较盘符别名，不替换原服务。
import assert from 'node:assert/strict';
import { realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const inject = ['configEditor', 'profileContext'];
export async function apply(ctx) {
  const root = await realpath(resolve(import.meta.dirname, '../../../../plugin/artifacts/latest-runtime-check/relay-homes'));
  const home = await realpath(process.env.DSH_HOME);
  assert.match(relative(root, home), /^[0-9a-f-]{36}$/);
  const entry = process.pkg?.entrypoint;
  assert.match(entry, /^[A-Za-z]:[\\/]snapshot[\\/]/);
  const firstPath = createRequire(entry).resolve('@deepseek-ai/dsh-app-boot');
  assert.match(firstPath, /^[A-Za-z]:[\\/]snapshot[\\/]/);
  const secondPath = 'Q:' + firstPath.slice(2);
  await writeFile(resolve(home, 'sdk-profile-observer-start.json'), JSON.stringify({ entry, firstPath, secondPath }), { flag: 'wx' });
  const timer = setTimeout(() => { void (async () => {
    const first = await import(pathToFileURL(firstPath).href);
    const second = await import(pathToFileURL(secondPath).href);
    await writeFile(resolve(home, 'sdk-profile-observer.json'), JSON.stringify({ tag: '[DEBUG-sdk-profile]',
      entry, firstPath, secondPath, sameReconciler: first.reconcileProfilePatches === second.reconcileProfilePatches }, null, 2), { flag: 'wx' });
  })().catch(async error => {
    await writeFile(resolve(home, 'sdk-profile-observer-error.json'), JSON.stringify({ message: error.message }), { flag: 'wx' });
  }); }, 5000);
  ctx.effect(() => () => clearTimeout(timer));
}
