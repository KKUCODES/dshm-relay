import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect } from 'vitest'

/** 正常安装的自有五文件插件，只声明手机布局，不修改官方客户端。 */
export async function officialPluginLayoutFixture(directory: string) {
  const execute = promisify(execFile), tar = 'C:/Windows/System32/tar.exe'
  const old = resolve('../dsh-mobile/artifacts/official-plugin-fixtures/dsh-mobile-panel-ui-verification-0.0.5.tgz')
  const files = ['client.js', 'index.js', 'package.json', 'README.md', 'cordis.patch.yml']
  const target = resolve(directory, 'official-plugin-fixtures/package')
  await mkdir(target, { recursive: true })
  const options = { cwd: directory, windowsHide: true }, version = '0.0.12'
  expect((await execute(tar, ['-tzf', old], options)).stdout.trim().split(/\r?\n/).sort())
    .toEqual(files.map(file => 'package/' + file).sort())
  for (const file of files) {
    let text = (await execute(tar, ['-xOf', old, 'package/' + file], options)).stdout
    if (file === 'package.json') {
      const manifest = JSON.parse(text)
      expect(manifest.version).toBe('0.0.5')
      for (const key of ['scripts', 'dependencies', 'optionalDependencies']) expect(manifest[key]).toBeUndefined()
      manifest.version = version; text = JSON.stringify(manifest, null, 2) + '\n'
    }
    if (file === 'client.js') {
      const entry = "apply(ctx) {"
      expect(text.split(entry)).toHaveLength(2)
      // 官方电脑没有此手机服务，正常电脑插件仍能加载；手机使用自己的公开API。
      text = text.replace(entry, entry + "\n      if (ctx.get('dshmLayout')) ctx.dshmLayout.configure({ autoFit: false });")
    }
    await writeFile(resolve(target, file), text, { flag: 'wx' })
  }
  for (const file of ['client.js', 'index.js']) await execute(process.execPath, ['--check', resolve(target, file)], options)
  const spec = resolve(target, '../dsh-mobile-panel-ui-verification-' + version + '.tgz')
  await execute(tar, ['-czf', spec, '-C', resolve(target, '..'), 'package'], options)
  const bytes = await readFile(spec)
  return { spec, version, packageName: '@dsh-mobile/panel-ui-verification', authorAutoFit: false,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sourceFiles: files,
    originalArchiveSha256: createHash('sha256').update(await readFile(old)).digest('hex'),
    noInstallScripts: true, productsBuilt: false }
}
