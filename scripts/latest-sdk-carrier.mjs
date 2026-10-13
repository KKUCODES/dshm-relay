// 只接入本项目完整官方打包的固定SDK载体；原Python验证器负责所需资源检查。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { sourceRoot } from '../../plugin/compatibility/latest-upstream/source-runtime.mjs';
import { sourceCommit } from '../../plugin/compatibility/latest-upstream/source-changes.mjs';

export async function readLatestSdkCarrier(runtime) {
  assert.equal(process.platform, 'win32');
  assert.equal(runtime, resolve(import.meta.dirname, '../../plugin/artifacts/latest-runtime-check'));
  const entry = JSON.parse(await readFile(resolve(runtime, 'latest-sdk-sea-product.json'), 'utf8'));
  const reportPath = entry.buildReport;
  assert.equal(typeof reportPath, 'string'); assert.equal(dirname(reportPath), runtime);
  assert.match(basename(reportPath), /^latest-sdk-sea-build(?:-attempt-(?:[2-9]|10|11))?\.json$/);
  assert.equal(entry.sourceCommit, sourceCommit);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.sourceRoot, sourceRoot); assert.equal(report.sourceCommit, sourceCommit);
  assert.equal(report.files, 38); assert.equal(report.passed, true); assert.equal(report.exitCode, 0);
  if (/attempt-(?:[89]|10|11)\.json$/.test(reportPath)) {
    // 按该载体的排他归档清单核对，不能用当前候选清单重写旧载体的判断。
    const attempt = basename(reportPath).match(/attempt-([89]|10|11)\.json$/)[1];
    const manifestBytes = await readFile(resolve(runtime, `latest-source-manifest-sdk-attempt-${attempt}.json`));
    assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), report.sourceManifestSha256);
    const bootstrap = JSON.parse(manifestBytes).files.find(file => file.path === 'python/sdk-runtime/runtime-bootstrap.mjs');
    assert.equal(bootstrap.after, report.sdkBootstrapSha256);
    assert.equal(bootstrap.after, attempt === '8'
      ? '38edf143c0190e8051a4d1b9d63d9908c577c6776100153d6c780f8ebbf2fdc1'
      : attempt === '9' ? '61241cde85c14d3abd279867ff70a2babf12f3bf8d70f125883159c7fa714ae3'
      : 'd8b2790415e8031e3476e069cf0770461e97ef0674a9ab102fa0468118ce39a2');
    if (attempt === '11') {
      const manifest = JSON.parse(manifestBytes);
      assert.equal(manifest.files.length, 38);
      assert.equal(manifest.files.find(file => file.patch === 'file-version-watch')?.after,
        'eb65639ce4681d1641f2dc2c6a4a4734a7fecc384ab2a85db41bdf07bde751fc');
      assert.equal(report.nodeCarrierFrozen?.passed, true);
      const frozen = JSON.parse(await readFile(resolve(runtime, 'latest-sdk-node-freeze-attempt-11.json')));
      assert.equal(frozen.passed, true); assert.equal(frozen.files.length, report.nodeCarrierFrozen.files);
      assert.equal(frozen.root, resolve(sourceRoot, 'python/sdk-runtime/src/deepseek_harness_runtime/runtime/node'));
      for (const file of frozen.files) {
        const path = resolve(frozen.root, file.path);
        const rel = relative(frozen.root, path);
        assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
        assert.equal(await realpath(path), path); assert.equal((await lstat(path)).nlink, 1);
        assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), file.sha256);
      }
    }
  }
  assert.equal(entry.productSha256, report.product.sha256);
  const product = resolve(sourceRoot, 'dist-exe/deepseek-harness-sdk-runtime-win-x64.exe');
  assert.equal(report.product.path, product); assert.equal(await realpath(product), product);
  const hash = async path => {
    const bytes = await readFile(path);
    assert.equal(bytes.length, report.product.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), report.product.sha256);
  };
  await hash(product);
  const parent = resolve(sourceRoot, 'python/sdk-runtime/src');
  const root = resolve(parent, 'deepseek_harness_runtime/runtime');
  assert.equal(await realpath(root), root);
  const executable = resolve(root, 'deepseek-harness-sdk-runtime-win-x64.exe');
  assert.equal(await realpath(executable), executable); await hash(executable);
  // -I/-B只运行原资源校验，不启动应用、不写pycache，也不读取测试home或Key。
  const python = resolve(root, 'win-x64/primary-runtime/dependencies/python/python.exe');
  assert.equal(await realpath(python), python);
  const checked = execFileSync(python, ['-I', '-B', '-c',
    'import sys; sys.path.insert(0, sys.argv[1]); from deepseek_harness_runtime import bundled_runtime_path; print(bundled_runtime_path())', parent],
  { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(checked, executable);
  return { root: dirname(executable), executable, sourceRoot, sourceCommit,
    productSha256: report.product.sha256, buildReport: reportPath };
}
