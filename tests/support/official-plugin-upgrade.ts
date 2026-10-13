import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect } from 'vitest'

const execute = promisify(execFile)
const packageName = '@dsh-mobile/panel-ui-verification'

/** 只生成自有五文件测试bundle的新版本；不构建DSH、SDK或产品。 */
export async function officialPluginUpgradeFixture(directory: string) {
  await mkdir(directory, { recursive: true })
  const old = resolve('../dsh-mobile/artifacts/official-plugin-fixtures/dsh-mobile-panel-ui-verification-0.0.5.tgz')
  const files = ['client.js', 'index.js', 'package.json', 'README.md', 'cordis.patch.yml']
  const tar = 'C:/Windows/System32/tar.exe', options = { windowsHide: true, cwd: directory }
  const inventory = (await execute(tar, ['-tzf', old], options)).stdout.trim().split(/\r?\n/)
  expect(inventory.sort()).toEqual(files.map(file => 'package/' + file).sort())
  const target = resolve(directory, 'official-plugin-fixtures', 'package')
  await mkdir(target, { recursive: true })
  const title = 'DSHM 升级验收 0.0.6', heading = 'DSHM 升级版本 0.0.6'
  for (const file of files) {
    let text = (await execute(tar, ['-xOf', old, 'package/' + file], options)).stdout
    if (file === 'package.json') {
      const manifest = JSON.parse(text)
      expect(manifest.name).toBe(packageName); expect(manifest.version).toBe('0.0.5')
      for (const key of ['scripts', 'dependencies', 'optionalDependencies']) expect(manifest[key]).toBeUndefined()
      manifest.version = '0.0.6'; text = JSON.stringify(manifest, null, 2) + '\n'
    }
    if (file === 'client.js') {
      expect(text.split('DSHM 面板验收')).toHaveLength(3)
      expect(text.split('DSHM 独立面板验证')).toHaveLength(2)
      text = text.replaceAll('DSHM 面板验收', title).replace('DSHM 独立面板验证', heading)
    }
    await writeFile(resolve(target, file), text, { flag: 'wx' })
  }
  for (const file of ['client.js', 'index.js'])
    await execute(process.execPath, ['--check', resolve(target, file)], options)
  const spec = resolve(target, '../dsh-mobile-panel-ui-verification-0.0.6.tgz')
  await execute(tar, ['-czf', spec, '-C', resolve(target, '..'), 'package'], options)
  return { spec, version: '0.0.6', title, heading, packageName,
    bytes: (await readFile(spec)).length, sha256: createHash('sha256').update(await readFile(spec)).digest('hex'),
    originalArchiveSha256: createHash('sha256').update(await readFile(old)).digest('hex'),
    sourceFiles: files, noInstallScripts: true, productsBuilt: false }
}

/** 对照正常公开目录与会话日志，保护其他包、配置和聊天。 */
export function officialPluginUpgradeChecks({ readSession, bundles, profilePath }: {
  readSession: () => Promise<{ records: any[] }>; bundles: () => Promise<any[]>; profilePath: string
}) {
  let history: any[] | undefined, others: any[] | undefined, profile: string | undefined, restarted = false
  const digest = async () => createHash('sha256').update(await readFile(profilePath)).digest('hex')
  const ordered = (rows: any[]) => rows.filter(row => row.name !== packageName).sort((a, b) => a.name.localeCompare(b.name))
  return {
    noteRestart() { expect(history).toBeDefined(); expect(restarted).toBe(false); restarted = true },
    async prepare() {
      history = (await readSession()).records; others = ordered(await bundles()); profile = await digest()
      expect((await bundles()).some(row => row.name === packageName)).toBe(false)
      return { historyRecords: history.length, otherBundles: others.length, baselineCaptured: true }
    },
    async unchanged(cleanup = false) {
      if (!history) return { initialized: false, unchanged: true }
      const current = (await readSession()).records
      expect(current.slice(0, history.length)).toEqual(history)
      const added = current.slice(history.length)
      // 冷会话只读不创建Agent；实际实例化才追加恢复标记。仅允许一次已知标记。
      const boundary = restarted && added[0]?.event.type === 'session/end-seed'
      expect(added.map(row => row.event.type)).toEqual([
        ...(boundary ? ['session/end-seed'] : []), ...(cleanup ? ['command/run', 'command/done'] : []),
      ])
      if (boundary) expect(added[0].event.data).toEqual({})
      expect(ordered(await bundles())).toEqual(others)
      expect((await bundles()).some(row => row.name === packageName)).toBe(false)
      expect(await digest()).toBe(profile)
      return { initialized: true, unchanged: true, historyPrefixUnchanged: true, cleanupCommandsVerified: cleanup,
        officialResumeBoundaryVerified: restarted,
        resumeBoundaryPresent: boundary,
        historyUnchanged: added.length === 0, otherBundlesUnchanged: true,
        profileUnchanged: true, testBundleRemoved: true }
    },
  }
}
