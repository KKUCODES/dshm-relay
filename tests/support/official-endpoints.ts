import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'
import { latestModelListing } from './latest-model-listing.js'

/** 用公开设置逐项核验地址写入；空凭据用户目录不发真实模型请求。 */
export async function officialEndpointChecks({ rpc, profilePath, readSession, policy = false, guard }: {
  rpc: (method: string, args: unknown) => Promise<any>; profilePath: string; readSession: () => Promise<{ records: any[] }>;
  policy?: boolean; guard?: (route: string) => Promise<unknown>
}) {
  expect(profilePath).toContain('official-dsh-alpha2-endpoint')
  const first = await latestModelListing(), second = await latestModelListing()
  const route = 'dshm-phone-management', phases: string[] = []
  const names = { chat: 'llm-deepseek', search: 'web-search-deepseek', provider: 'llm-pi-ai' } as const
  type Target = keyof typeof names
  const saved = new Map<Target, string>(), targetHashes = new Map<Target, string>()
  let baseline: { hash: string; records: any[]; views: any[] } | undefined, ownProvider: any, ownProviderUser: any
  let providerPresent = false, providerRestored = false, discoveryPerformed = false
  let searchAddressUser: Record<string, unknown> | undefined
  let bypassGuard: unknown, catalog: { value: any; user: any } | undefined, catalogSet = false
  const hash = async () => createHash('sha256').update(await readFile(profilePath)).digest('hex')
  const views = async () => {
    const all = (await rpc('settings/describe', {})).namespaces
    return Object.values(names).map(ns => {
      const item = all.find((row: any) => row.ns === ns); expect(item).toBeTruthy()
      return { ns, revision: item.revision, value: item.value, user: item.user ?? {} }
    })
  }
  const providerView = async () => (await views()).find(row => row.ns === names.provider)!
  const mutate = async (target: Target, change: 'set' | 'unset', value?: string) => {
    const current = (await views()).find(row => row.ns === names[target])!
    await rpc('settings/mutate', { ns: current.ns, expectedRevision: current.revision, ops: [{ op: change,
      path: target === 'provider' ? ['providers', route, 'baseURL'] : ['baseURL'], ...(change === 'set' ? { value } : {}) }] })
  }
  const keyUnconfigured = async () => {
    expect((await rpc('credentials/describe', { refs: ['DEEPSEEK_API_KEY'] })).DEEPSEEK_API_KEY)
      .toMatchObject({ configured: false, writable: true })
  }
  return {
    async verify(phase: string) {
      await keyUnconfigured()
      if (phase === 'prepare') {
        const current = await views(); expect((await providerView()).value.providers).toEqual({})
        baseline = { hash: await hash(), records: (await readSession()).records, views: structuredClone(current) }
        // 官方编辑器为搜索地址显式保留默认凭据引用；先用公开接口独立核对并恢复，不能忽略任意邻接字段。
        const search = current.find(row => row.ns === names.search)!
        searchAddressUser = { ...structuredClone(search.user), apiKeyEnv: search.value.apiKeyEnv }
        await mutate('search', 'set', first.baseURL)
        const control = (await views()).find(row => row.ns === names.search)!
        expect(control.value).toEqual({ ...search.value, baseURL: first.baseURL })
        expect(control.user).toEqual({ ...searchAddressUser, baseURL: first.baseURL })
        await mutate('search', 'unset')
        expect((await views()).map(({ revision, ...row }) => row)).toEqual(current.map(({ revision, ...row }) => row))
        expect(await hash()).toBe(baseline.hash)
        return { address: first.baseURL, alternate: second.baseURL, httpsAddress: 'https://example.invalid/anthropic/v1', route }
      }
      expect(baseline).toBeTruthy(); expect((await readSession()).records).toEqual(baseline!.records)
      if (phase.startsWith('catalog:')) {
        expect(policy).toBe(true)
        const action = phase.split(':')[1]
        let provider = await providerView()
        if (action === 'created') {
          expect(provider.value.providers).toEqual({})
          await rpc('settings/mutate', { ns: provider.ns, expectedRevision: provider.revision,
            ops: [{ op: 'set', path: ['providers', 'openai'], value: {} }] })
          provider = await providerView()
          catalog = { value: structuredClone(provider.value.providers.openai), user: structuredClone(provider.user.providers.openai) }
          expect(catalog.value.baseURL).toBeUndefined()
        } else if (action === 'saved') catalogSet = true
        else if (action === 'restored') catalogSet = false
        if (action !== 'removed') {
          expect(catalog).toBeTruthy()
          expect(provider.value.providers).toEqual({ openai: { ...catalog!.value, ...(catalogSet ? { baseURL: second.baseURL } : {}) } })
          expect(provider.user.providers).toEqual({ openai: { ...catalog!.user, ...(catalogSet ? { baseURL: second.baseURL } : {}) } })
        } else expect(provider.value.providers).toEqual({})
        for (const item of (await views()).filter(row => row.ns !== names.provider)) {
          const original = baseline!.views.find(row => row.ns === item.ns)
          expect(item.value).toEqual(original.value); expect(item.user).toEqual(original.user)
        }
        phases.push(phase); return { phase, address: second.baseURL, catalogDefaultRestored: action === 'restored' }
      }
      const [target, action] = phase.split(':') as [Target, string]
      expect(Object.hasOwn(names, target)).toBe(true)
      if (action === 'created') {
        expect(target).toBe('provider')
        const created = await providerView()
        ownProvider = structuredClone(created.value.providers[route]); ownProviderUser = structuredClone(created.user.providers[route])
        expect(ownProvider).toMatchObject({ baseURL: first.baseURL, api: 'openai-completions', models: [{ id: 'phone-model' }] })
        expect(ownProviderUser).toEqual({ baseURL: first.baseURL, api: 'openai-completions', models: [{ id: 'phone-model' }] })
        expect(ownProvider.apiKeyEnv).toBeUndefined(); providerPresent = true
      }
      if (action === 'saved') saved.set(target, target === 'provider' ? second.baseURL : first.baseURL)
      if (action === 'cut-after') saved.set(target, target === 'provider' ? second.baseURL : first.baseURL)
      if (action === 'race-phone') saved.set(target, target === 'provider' ? second.baseURL : first.baseURL)
      if (action === 'race-other') saved.set(target, target === 'provider' ? 'https://example.invalid/anthropic/v1' : second.baseURL)
      if (action === 'fault-reset') {
        const original = baseline!.views.find(row => row.ns === names[target])!
        if (target === 'provider') await mutate(target, 'set', ownProvider.baseURL)
        else if (Object.hasOwn(original.user, 'baseURL')) await mutate(target, 'set', original.user.baseURL)
        else await mutate(target, 'unset')
        saved.delete(target)
      }
      if (action === 'https') saved.set(target, 'https://example.invalid/anthropic/v1')
      if (action === 'external') {
        const value = target === 'provider' ? first.baseURL : second.baseURL
        await mutate(target, 'set', value); saved.set(target, value)
      }
      if (action === 'reset-baseline') {
        expect(target).toBe('provider'); targetHashes.set(target, await hash())
        // 手工声明的路由没有内置模型目录站点；官方写入校验拒绝删掉唯一地址。
        await expect(mutate(target, 'unset')).rejects.toThrow('needs a baseURL')
        expect(await hash()).toBe(targetHashes.get(target))
      }
      if (action === 'reset-policy') {
        expect(policy && guard).toBeTruthy(); targetHashes.set(target, await hash())
        bypassGuard = await guard!(route)
        expect(await hash()).toBe(targetHashes.get(target))
      }
      if (action === 'restored') { saved.delete(target); if (target === 'provider') providerRestored = true }
      if (action === 'removed') { expect(target).toBe('provider'); providerPresent = false }
      if (action === 'discovered') discoveryPerformed = true
      const current = await views()
      for (const item of current) {
        const original = baseline!.views.find(row => row.ns === item.ns)
        if (item.ns !== names.provider) {
          const kind = item.ns === names.chat ? 'chat' : 'search'
          const expectedValue = structuredClone(original.value)
          const expectedUser = structuredClone(kind === 'search' && saved.has(kind) ? searchAddressUser : original.user)
          if (saved.has(kind)) { expectedValue.baseURL = saved.get(kind); expectedUser.baseURL = saved.get(kind) }
          expect(item.value).toEqual(expectedValue); expect(item.user).toEqual(expectedUser)
        } else if (providerPresent) {
          const expected = structuredClone(ownProvider)
          const expectedUser = structuredClone(ownProviderUser)
          if (saved.has('provider')) expected.baseURL = expectedUser.baseURL = saved.get('provider')
          else if (providerRestored) { delete expected.baseURL; delete expectedUser.baseURL }
          expect(item.value.providers).toEqual({ [route]: expected })
          expect(item.user.providers).toEqual({ [route]: expectedUser })
          if (action.startsWith('cut-') || action.startsWith('race-') || action === 'fault-reset') {
            const { providers: _originalProviders, ...originalValue } = original.value
            const { providers: _originalUserProviders, ...originalUser } = original.user
            const { providers: _currentProviders, ...currentValue } = item.value
            const { providers: _currentUserProviders, ...currentUser } = item.user
            expect(currentValue).toEqual(originalValue); expect(currentUser).toEqual(originalUser)
          }
        } else {
          expect(item.value.providers).toEqual({}); expect(item.user.providers ?? {}).toEqual({})
        }
      }
      if (action === 'initial') targetHashes.set(target, await hash())
      if (action === 'invalid' || action === 'cancel' || action === 'reset-refused' || action === 'cut-before' || action === 'fault-reset') expect(await hash()).toBe(targetHashes.get(target))
      expect(first.calls).toEqual([])
      expect(second.calls).toEqual(discoveryPerformed ? [{ path: '/v1/models', authentication: 'none' }] : [])
      phases.push(phase)
      const currentTarget = current.find(row => row.ns === names[target])!
      const currentURL = target === 'provider' ? currentTarget.value.providers[route]?.baseURL : currentTarget.value.baseURL
      return { phase, allThreeNamespacesVerified: true, otherFieldsUnchanged: true, historyUnchanged: true,
        ...(action.startsWith('cut-') || action.startsWith('race-') ? { currentOrigin: currentURL ? new URL(currentURL).origin : null,
          revision: currentTarget.revision, profileHash: await hash() } : {}),
        credentialsConfigured: false, inferenceVerified: false }
    },
    async cleanup() {
      try {
        if (baseline) {
          for (const target of ['chat', 'search'] as const) {
            const current = (await views()).find(row => row.ns === names[target])!, original = baseline.views.find(row => row.ns === names[target])!
            if (Object.hasOwn(original.user, 'baseURL')) await mutate(target, 'set', original.user.baseURL)
            else if (Object.hasOwn(current.user, 'baseURL')) await mutate(target, 'unset')
          }
          let provider = await providerView()
          if (provider.value.providers[route]) {
            expect(provider.value.providers[route].apiKeyEnv).toBeUndefined()
            await rpc('settings/mutate', { ns: provider.ns, expectedRevision: provider.revision, ops: [{ op: 'unset', path: ['providers', route] }] })
            provider = await providerView()
          }
          if (provider.value.providers.openai && policy) {
            await rpc('settings/mutate', { ns: provider.ns, expectedRevision: provider.revision,
              ops: [{ op: 'unset', path: ['providers', 'openai'] }] }); provider = await providerView()
          }
          expect(provider.value.providers).toEqual({})
          if (!Object.hasOwn(baseline.views.find(row => row.ns === names.provider)!.user, 'providers') && Object.hasOwn(provider.user, 'providers'))
            await rpc('settings/mutate', { ns: provider.ns, expectedRevision: provider.revision, ops: [{ op: 'unset', path: ['providers'] }] })
          expect((await views()).map(({ revision, ...row }) => row)).toEqual(baseline.views.map(({ revision, ...row }) => row))
          expect(await hash()).toBe(baseline.hash); expect((await readSession()).records).toEqual(baseline.records)
        }
        await keyUnconfigured()
        return { restored: true, profileRestored: true, phases, directoryCalls: second.calls,
          ...(policy ? { bypassGuard, catalogDefaultRestored: phases.includes('catalog:restored') } : {}),
          officialSearchReferenceControlVerified: searchAddressUser !== undefined,
          credentialsConfigured: false, credentialContentsRead: false, inferenceVerified: false }
      } finally { await first.close(); await second.close() }
    },
  }
}
