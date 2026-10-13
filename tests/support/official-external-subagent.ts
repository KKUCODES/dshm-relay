import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect } from 'vitest'

type Rpc = (method: string, args: unknown) => Promise<any>

/** 只撤回本次正常安装器追加的已核验版本例外；其他配置变化必须保留并报错。 */
export async function restoreOfficialExternalPolicy(path: string, original: Buffer) {
  const current = await readFile(path)
  let removed: string[] = []
  if (!current.equals(original)) {
    const base = original.toString().trimEnd()
    expect(base).not.toContain('minimumReleaseAgeExclude:')
    const prefix = base + '\nminimumReleaseAgeExclude:\n'
    expect(current.toString().startsWith(prefix)).toBe(true)
    const lines = current.toString().slice(prefix.length).trimEnd().split('\n')
    expect(lines.length).toBeGreaterThan(0); expect(lines.length).toBeLessThanOrEqual(2)
    removed = lines.map(line => {
      const match = /^  - '(@deepseek-ai\/dsh-(?:brand|subagent-acp)@0\.2\.1-alpha\.2)'$/.exec(line)
      expect(match).not.toBeNull()
      return match![1]!
    })
    expect(new Set(removed).size).toBe(removed.length)
    await writeFile(path, original)
  }
  expect(await readFile(path)).toEqual(original)
  return { packageManagerPolicyRestored: true, removedReleaseAgeExceptions: removed }
}

/** 正常插件安装官方 ACP 后端和独立模式，不改变标准模式或官方安装文件。 */
export function officialExternalPreset(rpc: Rpc, directory: string, run: string, root: string) {
  const name = '@dsh-mobile/external-verification-' + run.slice(0, 8), id = 'dshm-external-' + run.slice(0, 8)
  const fixture = resolve(directory, 'official-external-fixtures', run), spec = resolve(fixture, 'external.tgz')
  const policyPath = resolve(root, 'home/profiles/web/pnpm-workspace.yaml')
  let original: any, standard: any, policy: Buffer, attempted = false
  return {
    id,
    async install() {
      original = await rpc('agentPresets/list', {})
      standard = await rpc('agentPresets/read', { agentPreset: 'standard' })
      expect(original.presets.some((item: any) => item.id === id)).toBe(false)
      policy = await readFile(policyPath)
      const content = standard.content.trimEnd() + [
        '', '- id: ' + id + '-tool', "  name: '@deepseek-ai/dsh-tool-subagent'", '  config:',
        '    provider: ' + id, '    toolName: dshm_external', '    maxDepth: provider-managed', '',
      ].join('\n')
      await mkdir(resolve(fixture, 'package'), { recursive: true })
      await writeFile(resolve(fixture, 'policy-baseline.json'), JSON.stringify({ path: policyPath,
        bytes: policy.toString('base64'), scope: 'non-credential-package-manager-policy' }, null, 2) + '\n', { flag: 'wx' })
      await writeFile(resolve(fixture, 'package/package.json'), JSON.stringify({ name, version: '0.0.1',
        private: true, type: 'module', exports: { '.': './index.js', './package.json': './package.json' },
        files: ['index.js', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } },
        dependencies: { '@deepseek-ai/dsh-subagent-acp': '0.2.1-alpha.2' },
      }, null, 2) + '\n', { flag: 'wx' })
      await writeFile(resolve(fixture, 'package/index.js'), 'export default function verificationBundle() {}\n', { flag: 'wx' })
      await writeFile(resolve(fixture, 'package/cordis.patch.yml'), [
        '- insert:', '    - id: ' + id + '-provider', "      name: '@deepseek-ai/dsh-subagent-acp'", '      config:',
        '        providerName: ' + id, '        command: ' + JSON.stringify(process.execPath),
        '        args:', '          - ' + JSON.stringify(resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')),
        '          - --profile', '          - acp', '        permission: reject', '        env:',
        '          DSH_HOME: ' + JSON.stringify(resolve(root, 'home')),
        '    - id: ' + id, "      name: '@deepseek-ai/dsh-agent-preset'", '      config:',
        '        id: ' + id, '        name: DSHM外部任务验收', '        plugins:',
        ...content.trimEnd().split('\n').map(line => '          ' + line), '',
      ].join('\n'), { flag: 'wx' })
      await promisify(execFile)('C:/Windows/System32/tar.exe', ['-czf', spec, '-C', fixture, 'package'],
        { cwd: fixture, windowsHide: true })
      attempted = true
      const result = await rpc('pluginManager/installBundle', { spec })
      expect(result.application, result.error?.diagnostic).not.toBe('failed')
      await expect.poll(async () => (await rpc('agentPresets/list', {})).presets.some((item: any) => item.id === id),
        { timeout: 120000 }).toBe(true)
      expect(await rpc('agentPresets/read', { agentPreset: 'standard' })).toEqual(standard)
      expect((await rpc('agentPresets/list', {})).presets.filter((item: any) => item.id !== id)).toEqual(original.presets)
      expect((await rpc('agentPresets/read', { agentPreset: id })).content.trimEnd()).toBe(content.trimEnd())
      return { id, name, application: result.application, officialAcpBackend: '0.2.1-alpha.2',
        normalProfile: 'acp', permission: 'reject', noCredentialForwarding: true, standardUnchanged: true }
    },
    async cleanup() {
      if (!attempted) return { installAttempted: false }
      const bundle = (await rpc('pluginManager/listBundles', {})).find((item: any) => item.name === name)
      if (bundle) {
        expect(bundle.version).toBe('0.0.1')
        expect(bundle.source.replaceAll('\\', '/')).toContain(spec.replaceAll('\\', '/'))
        expect((await rpc('pluginManager/removeBundle', { name })).application).not.toBe('failed')
      }
      await expect.poll(async () => (await rpc('pluginManager/listBundles', {})).some((item: any) => item.name === name),
        { timeout: 120000 }).toBe(false)
      expect(await rpc('agentPresets/list', {})).toEqual(original)
      expect(await rpc('agentPresets/read', { agentPreset: 'standard' })).toEqual(standard)
      const restored = await restoreOfficialExternalPolicy(policyPath, policy)
      return { bundleRemoved: true, testPresetRemoved: true, standardUnchanged: true, ...restored }
    },
  }
}

/** 只观察实际工具调用和官方结算事件，不制造子会话或模型事件。 */
export function officialExternalChecks({ rpc, readSession, sessionId, marker }: {
  rpc: Rpc; readSession: () => Promise<{ snapshot: any; records: any[] }>; sessionId: string; marker: string
}) {
  const label = 'DSHM ACP 外部任务 ' + marker.slice(-8), reply = marker + '_CHILD'
  return {
    label, reply, marker, parentId: sessionId,
    async before() { return (await readSession()).snapshot.asOfSeq },
    async settled(initialSeq: number) {
      await expect.poll(async () => (await readSession()).records.some(row => row.event.seq > initialSeq
        && row.event.type === 'user/message' && row.event.data.source?.kind === 'subagent-settled'
        && JSON.stringify(row.event.data.content).includes(reply)), { timeout: 180000 }).toBe(true)
      const parent = await readSession(), rows = parent.records.filter(row => row.event.seq > initialSeq)
      const calls = rows.filter(row => row.event.type === 'tool/call')
      expect(calls).toHaveLength(1); expect(calls[0].event.data.name).toBe('dshm_external')
      expect(JSON.parse(calls[0].event.data.arguments).description).toBe(label)
      const entry = parent.snapshot.values.subagentCatalog.find((item: any) => item.label === label)
      expect(entry?.mode).toBe('external')
      const notices = rows.filter(row => row.event.type === 'user/message' && row.event.data.source?.kind === 'subagent-settled')
      expect(notices).toHaveLength(1); expect(notices[0].event.data.source.senderSessionId).toBe(entry.id)
      const results = rows.filter(row => row.event.type === 'tool/result'
        && row.event.data.message.toolCallId === calls[0].event.data.callId)
      expect(results).toHaveLength(1); expect(results[0].event.data.message.isError).not.toBe(true)
      expect((await rpc('session/list', { _request: {} })).items.some((item: any) => item.sessionId === entry.id)).toBe(false)
      return { taskId: entry.id, mode: entry.mode, callId: calls[0].event.data.callId, noticeSeq: notices[0].event.seq,
        actualAcpReplyReturned: true, onlyOneCallAndSettlement: true, noLocalChildSession: true }
    },
  }
}
