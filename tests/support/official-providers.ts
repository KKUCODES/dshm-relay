import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'
import { latestModelListing } from './latest-model-listing.js'

/** 真实目录HTTP和正常官方设置API；只管理无Key的专用测试路由，不读凭据文件。 */
export async function officialProviderChecks({ rpc, profilePath, readSession, modelProbeAvailable }: {
  rpc: (method: string, args: unknown) => Promise<any>; profilePath: string; readSession: () => Promise<{ records: any[] }>; modelProbeAvailable: boolean
}) {
  const route = 'dshm-phone-management', listing = await latestModelListing()
  let baseline: { hash: string; records: any[]; parentOverridden: boolean } | undefined
  let savedProfile: any, advancedBase: any, advancedUser: any, advancedCalls = 0, existingStart = 0
  const phases: string[] = []
  const native = async () => {
    const value = (await rpc('settings/describe', {})).namespaces.find((item: any) => item.ns === 'llm-pi-ai')
    expect(value).toBeTruthy(); return value
  }
  const hash = async () => createHash('sha256').update(await readFile(profilePath)).digest('hex')
  const normalize = (raw: any) => {
    const result = structuredClone(raw)
    const compat = (value: any) => {
      for (const key of ['chatTemplateArgs', 'chatTemplateKwargs']) if (value.compat?.[key] && Object.keys(value.compat[key]).length === 0) delete value.compat[key]
      if (value.compat && Object.keys(value.compat).length === 0) delete value.compat
    }
    compat(result)
    for (const row of result.models ?? []) { if (Array.isArray(row.input) && row.input.length === 0) delete row.input; compat(row) }
    return result
  }
  return {
    async verify(phase: string, actualRoute = route) {
      expect(actualRoute).toBe(route)
      const view = await native()
      if (phase === 'prepare') {
        expect(modelProbeAvailable).toBe(false)
        expect(view.value.providers).toEqual({})
        expect(view.user?.providers ?? {}).toEqual({})
        baseline = { hash: await hash(), records: (await readSession()).records,
          parentOverridden: Object.hasOwn(view.user ?? {}, 'providers') }
        phases.push(phase)
        return { baseURL: listing.baseURL, redirectURL: listing.redirectURL, draftURL: listing.baseURL.replace('/v1', '/draft/v1'), modelProbeAvailable }
      }
      expect(baseline).toBeTruthy()
      expect((await readSession()).records).toEqual(baseline!.records)
      expect(listing.calls.every(call => call.authentication === 'none')).toBe(true)
      expect(listing.calls.some(call => call.path.startsWith('/forbidden/'))).toBe(false)
      expect(Object.keys(view.value.providers).filter(id => id !== route)).toEqual([])
      if (phase.startsWith('probe-')) {
        expect(view.value.providers).toEqual({})
        expect(phase).toBe('probe-unavailable')
        expect(listing.calls.length).toBe(0)
        expect(await hash()).toBe(baseline!.hash)
      } else if (phase === 'removed') {
        expect(view.value.providers).toEqual({})
        expect((await rpc('session/modelCatalog', {})).groups.some((item: any) => item.id === route)).toBe(false)
      } else if (phase.startsWith('advanced-')) {
        if (phase === 'advanced-prepare') {
          advancedBase = structuredClone(view.value.providers[route]); advancedUser = structuredClone(view.user.providers[route])
          advancedCalls = listing.calls.length
        } else {
          expect(advancedUser).toBeTruthy()
          const expected = structuredClone(advancedUser), effective = structuredClone(advancedBase)
          if (['advanced-set', 'advanced-disabled'].includes(phase)) {
            const advanced = { input: ['image', 'text'], reasoningEfforts: phase === 'advanced-disabled' ? false : { off: null, high: 'high' },
              compat: { supportsStore: false, maxTokensField: 'max_tokens', thinkingFormat: 'chat-template', vllmPriority: -1,
                chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' }, effort: { $var: 'thinking.effort', omitWhenOff: true },
                  marker: 'latest', count: 3, enabled: false, empty: null }, chatTemplateArgs: { budget: { $var: 'thinking.budget' } } } }
            expected.models[0] = { ...expected.models[0], ...advanced }
            effective.models[0] = { ...effective.models[0], ...advanced, compat: { ...effective.models[0].compat, ...advanced.compat } }
          }
          if (['advanced-provider-defaults', 'advanced-protocol-cancel', 'advanced-protocol-switched', 'advanced-protocol-restored'].includes(phase)) {
            expected.compat = { supportsStrictMode: true }; effective.compat = { ...effective.compat, ...expected.compat }
            if (phase === 'advanced-protocol-switched') expected.api = 'openai-responses'
          }
          effective.api = expected.api
          expect(normalize(view.user.providers[route])).toEqual(normalize(expected))
          expect(normalize(view.value.providers[route])).toEqual(normalize(effective))
          expect(listing.calls.length).toBe(advancedCalls)
        }
      } else {
        const modelSaved = !['created', 'renamed', 'existing-discovered', 'existing-adopted'].includes(phase)
        const models = [{ id: 'phone-model', name: modelSaved ? '手机模型改名' : 'Phone model', contextWindow: 128001, maxTokens: 4097 },
          ...(modelSaved ? [{ id: 'probe-discovered', name: 'HTTP 新模型', contextWindow: 128001, maxTokens: 4097 }] : [])]
        expect(view.value.providers[route]).toMatchObject({ displayName: phase === 'created' ? '手机提供方验收' : '手机提供方改名',
          api: 'openai-completions', baseURL: listing.baseURL, models })
        expect(view.value.providers[route].apiKeyEnv).toBeUndefined()
        const group = (await rpc('session/modelCatalog', {})).groups.find((item: any) => item.id === route)
        expect(group).toMatchObject({ id: route, models: models.map(({ id, name }) => ({ id, name })) })
        if (['renamed', 'model-renamed'].includes(phase)) savedProfile = structuredClone(view.value.providers[route])
        if (phase === 'existing-discovered') existingStart = listing.calls.length - 1
        if (phase.startsWith('existing-')) {
          expect(view.value.providers[route]).toEqual(savedProfile)
          const count = phase === 'existing-saved-address' ? 2 : 1
          expect(listing.calls.slice(existingStart)).toEqual([
            { path: '/v1/models', authentication: 'none' },
            { path: '/v1/models', authentication: 'none' },
          ].slice(0, count))
        }
      }
      phases.push(phase)
      return { phase, publicStateVerified: true, originalHistoryUnchanged: true, credentialContentsRead: false }
    },
    async cleanup() {
      try {
        if (!baseline) return { initialized: false, restored: true }
        let view = await native()
        expect(Object.keys(view.value.providers).filter(id => id !== route)).toEqual([])
        if (view.value.providers[route]) {
          // 路由和站点来自本轮明确创建的回执；不删除现有提供方或凭据。
          expect(view.value.providers[route].baseURL).toBe(listing.baseURL)
          expect(view.value.providers[route].apiKeyEnv).toBeUndefined()
          await rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: view.revision,
            ops: [{ op: 'unset', path: ['providers', route] }] })
          view = await native()
        }
        expect(view.value.providers).toEqual({}); expect(view.user?.providers ?? {}).toEqual({})
        if (!baseline.parentOverridden && Object.hasOwn(view.user ?? {}, 'providers')) {
          await rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: view.revision, ops: [{ op: 'unset', path: ['providers'] }] })
        }
        expect(await hash()).toBe(baseline.hash)
        return { initialized: true, restored: true, profileRestored: true, phases,
          directoryCalls: listing.calls, credentialsRead: false, modelRequestsToFixture: false }
      } finally { await listing.close() }
    },
  }
}
