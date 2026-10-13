import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'

/** 只改独立官方实例一个目录行，原生Key不参与；完整公开行和正常profile摘要独立核对。 */
export function officialDeepSeekModelChecks({ rpc, profilePath, readSession, marker }: {
  rpc: (method: string, args: unknown) => Promise<any>; profilePath: string;
  readSession: () => Promise<{ records: any[] }>; marker: string
}) {
  let baseline: { models: any[]; fields: any; profileHash: string; records: any[] } | undefined
  let changedModels: any[] | undefined
  const current = async () => {
    const value = (await rpc('settings/describe', {})).namespaces.find((item: any) => item.ns === 'llm-deepseek')
    expect(value).toBeTruthy()
    expect(Array.isArray(value.value.models)).toBe(true)
    // 不记录namespace整体，也不调用凭据resolve；只保留明确非敏感字段。
    return { models: structuredClone(value.value.models), overridden: Object.hasOwn(value.user ?? {}, 'models'),
      fields: Object.fromEntries(['thinking', 'reasoningEffort', 'maxTokens', 'defaultContextWindow', 'streamIdleTimeoutMs']
        .map(key => [key, value.value[key]])), revision: value.revision,
      profileHash: createHash('sha256').update(await readFile(profilePath)).digest('hex'),
      records: (await readSession()).records }
  }
  const project = (models: any[]) => models.map(row => ({ ...Object.fromEntries(['id', 'name', 'contextWindow', 'maxTokens']
    .flatMap(key => row[key] === undefined ? [] : [[key, row[key]]])),
    advanced: row.inputModalities === undefined ? {} : { input: row.inputModalities } }))
  return {
    async verify(phase: string, phone: any) {
      const state = await current()
      expect(phone.rows).toEqual(project(state.models)); expect(phone.overridden).toBe(state.overridden)
      expect(phone.revision).toBe(state.revision); expect(phone.advancedEditable).toBe(true); expect(phone.compatEditable).toBe(false)
      if (phase === 'initial') {
        expect(state.overridden).toBe(false)
        expect(state.models.length).toBeGreaterThan(1)
        expect(state.models[0].inputModalities).toContain('image')
        expect(Number.isSafeInteger(state.models[0].contextWindow)).toBe(true)
        baseline = state
        changedModels = state.models.map((row: any, index: number) => index === 0
          ? { ...row, name: marker, contextWindow: row.contextWindow + 1, inputModalities: ['text'] } : row)
        return { originalName: state.models[0].name, changedName: marker,
          contextWindow: state.models[0].contextWindow, changedContextWindow: state.models[0].contextWindow + 1,
          count: state.models.length, originalOverridden: false }
      }
      expect(baseline).toBeTruthy()
      expect(state.fields).toEqual(baseline!.fields); expect(state.records).toEqual(baseline!.records)
      expect(state.models).toEqual(phase === 'changed' ? changedModels : baseline!.models)
      expect(state.overridden).toBe(phase === 'changed')
      const group = (await rpc('session/modelCatalog', {})).groups.find((item: any) => item.id === 'deepseek-official')
      expect(group.models.map((item: any) => ({ id: item.id, name: item.name })))
        .toEqual(state.models.map((row: any) => ({ id: row.id, name: row.name ?? row.id })))
      if (phase === 'restored') expect(state.profileHash).toBe(baseline!.profileHash)
      return { phase, officialDirectoryVerified: true, fullPublicRowsVerified: true,
        hiddenFieldsPreserved: true, otherSettingsUnchanged: true, historyUnchanged: true,
        defaultInheritanceRestored: phase === 'restored', profileRestored: phase === 'restored' }
    },
    async cleanup() {
      if (!baseline) return { initialized: false, restored: true }
      let state = await current()
      if (state.overridden || JSON.stringify(state.models) !== JSON.stringify(baseline.models)) {
        // 仅恢复本轮明确写入的完整值；不覆盖并发用户改动。
        expect(state.models).toEqual(changedModels); expect(state.overridden).toBe(true)
        await rpc('settings/mutate', { ns: 'llm-deepseek', expectedRevision: state.revision,
          ops: [{ op: 'unset', path: ['models'] }] })
        state = await current()
      }
      expect(state.models).toEqual(baseline.models); expect(state.fields).toEqual(baseline.fields)
      expect(state.overridden).toBe(false); expect(state.profileHash).toBe(baseline.profileHash)
      return { initialized: true, restored: true, modelsAndInheritanceRestored: true, profileRestored: true }
    },
  }
}
