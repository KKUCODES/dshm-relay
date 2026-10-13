import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { officialExternalPreset, restoreOfficialExternalPolicy } from './support/official-external-subagent.js'

const output = resolve('artifacts/official-plugin-only')
const base = Buffer.from('packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
const exceptions = "minimumReleaseAgeExclude:\n  - '@deepseek-ai/dsh-brand@0.2.1-alpha.2'\n  - '@deepseek-ai/dsh-subagent-acp@0.2.1-alpha.2'\n"

test('ACP清理恢复实际安装器的两条版本例外，保持原配置字节', async () => {
  await mkdir(output, { recursive: true })
  const directory = await mkdtemp(resolve(output, 'external-policy-')), path = resolve(directory, 'pnpm-workspace.yaml')
  try {
    await writeFile(path, Buffer.concat([base, Buffer.from(exceptions)]))
    const result = await restoreOfficialExternalPolicy(path, base)
    expect(result.removedReleaseAgeExceptions).toEqual([
      '@deepseek-ai/dsh-brand@0.2.1-alpha.2', '@deepseek-ai/dsh-subagent-acp@0.2.1-alpha.2',
    ])
    expect(await readFile(path)).toEqual(base)
    expect((await restoreOfficialExternalPolicy(path, base)).removedReleaseAgeExceptions).toEqual([])
  } finally { await rm(path, { force: true }); await rmdir(directory) }
})

test.each([
  exceptions.replace('dsh-brand@0.2.1-alpha.2', 'unrelated@0.2.1-alpha.2'),
  exceptions.replace('dsh-subagent-acp@0.2.1-alpha.2', 'dsh-brand@0.2.1-alpha.2'),
  exceptions + 'allowBuilds:\n  unrelated: true\n',
])('ACP清理拒绝覆盖其他配置、重复例外或额外策略 %s', async suffix => {
  await mkdir(output, { recursive: true })
  const directory = await mkdtemp(resolve(output, 'external-policy-')), path = resolve(directory, 'pnpm-workspace.yaml')
  const current = Buffer.concat([base, Buffer.from(suffix)])
  try {
    await writeFile(path, current)
    await expect(restoreOfficialExternalPolicy(path, base)).rejects.toThrow()
    expect(await readFile(path)).toEqual(current)
  } finally { await rm(path, { force: true }); await rmdir(directory) }
})

test.skipIf(process.env.DSHM_OFFICIAL_EXTERNAL_INSTALL_CHECK !== '1')('正常官方Host安装ACP测试提供方后自动清理，无模型请求', async () => {
  const root = resolve('../plugin/artifacts/official-dsh-alpha2')
  const receipt = JSON.parse(await readFile(resolve(root, 'official-web-receipt.json'), 'utf8'))
  expect(receipt.stage).toBe('plugin-ready'); expect(receipt.version).toBe('0.2.1-alpha.2')
  expect(receipt.entry).toBe('pnpm dsh web'); expect(receipt.port).toBe(16958)
  process.kill(receipt.pid, 0)
  expect(receipt.privateLog).toBe(resolve(root, `web-${receipt.run}.private.log`))
  // 登录凭据仅供本次正常官方HTTP调用，不记录或输出。
  const log = await readFile(receipt.privateLog, 'utf8')
  const url = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)?.[1]
  expect(new URL(url!).origin).toBe('http://127.0.0.1:16958')
  const login = await fetch(url!, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  expect(login.status).toBe(303)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const rpc = async (method: string, args: unknown) => {
    // 安装专项不得意外发起模型会话或读取凭据。
    expect(['agentPresets/list', 'agentPresets/read', 'pluginManager/listBundles',
      'pluginManager/installBundle', 'pluginManager/removeBundle']).toContain(method)
    const response = await fetch('http://127.0.0.1:16958/api/' + method, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
      signal: AbortSignal.timeout(120000),
    })
    expect(response.status).toBe(200)
    const frame = await response.json(); expect(frame.result.ok).toBe(true)
    return frame.result.value
  }
  const run = randomUUID(), report: Record<string, unknown> = { run, passed: false, inferenceVerified: false,
    androidVerified: false, originalAppTouched: false, officialLaunchPid: receipt.pid, entry: receipt.entry }
  await mkdir(output, { recursive: true })
  const fixture = officialExternalPreset(rpc, output, run, root)
  try {
    report.installed = await fixture.install()
    const current = await readFile(resolve(root, 'home/profiles/web/pnpm-workspace.yaml'), 'utf8')
    report.releaseAgeExceptionsObserved = current.includes('minimumReleaseAgeExclude:')
  } finally {
    try { report.cleanup = await fixture.cleanup(); report.cleanupCompleted = true }
    finally { await writeFile(resolve(output, `external-install-${run}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }) }
  }
  report.passed = true
  await writeFile(resolve(output, `external-install-${run}.json`), JSON.stringify(report, null, 2) + '\n')
}, 180000)
