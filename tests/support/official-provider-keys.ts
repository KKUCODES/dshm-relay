import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'
import { latestModelListing } from './latest-model-listing.js'

/** 只核验独立空存储中的生成引用和状态；不读取凭据文件或获取 Key 明文。 */
export async function officialProviderKeyChecks({ rpc, profilePath, readSession }: {
  rpc: (method: string, args: unknown) => Promise<any>; profilePath: string; readSession: () => Promise<{ records: any[] }>
}) {
  expect(profilePath).toContain('official-dsh-alpha2-key')
  const route = 'dshm-phone-management', listing = await latestModelListing()
  const refs = new Set<string>(), phases: string[] = []
  let baseline: { hash: string; records: any[]; parentOverridden: boolean } | undefined
  const view = async () => (await rpc('settings/describe', {})).namespaces.find((item: any) => item.ns === 'llm-pi-ai')
  const hash = async () => createHash('sha256').update(await readFile(profilePath)).digest('hex')
  const info = async (ref: string) => (await rpc('credentials/describe', { refs: [ref] }))[ref]
  const capture = (provider: any) => {
    if (!provider?.apiKeyEnv) return
    expect(provider.baseURL).toBe(listing.baseURL)
    expect(provider.apiKeyEnv).toMatch(/^DSHM_PROVIDER_[A-F0-9]{32}_API_KEY$/)
    refs.add(provider.apiKeyEnv)
  }
  return {
    async verify(phase: string) {
      const current = await view(); expect(current).toBeTruthy()
      if (phase === 'prepare') {
        expect(current.value.providers).toEqual({})
        expect((await info('DEEPSEEK_API_KEY')).configured).toBe(false)
        baseline = { hash: await hash(), records: (await readSession()).records,
          parentOverridden: Object.hasOwn(current.user ?? {}, 'providers') }
        return { baseURL: listing.baseURL }
      }
      expect(baseline).toBeTruthy()
      expect((await readSession()).records).toEqual(baseline!.records)
      expect((await info('DEEPSEEK_API_KEY')).configured).toBe(false)
      expect(Object.keys(current.value.providers).filter(id => id !== route)).toEqual([])
      const provider = current.value.providers[route]
      capture(provider)
      if (phase.endsWith('removed-provider')) {
        expect(provider).toBeUndefined()
        expect((await rpc('session/modelCatalog', {})).groups.some((item: any) => item.id === route)).toBe(false)
        for (const ref of refs) expect(await info(ref)).toMatchObject({ configured: false, writable: true })
      } else {
        expect(provider).toMatchObject({ baseURL: listing.baseURL, api: 'openai-completions', models: [{ id: 'phone-model', name: 'Phone model' }] })
        if (phase === 'existing-created') expect(provider.apiKeyEnv).toBeUndefined()
        else {
          expect(provider.apiKeyEnv).toBeTruthy()
          const configured = phase.endsWith('saved-key') || phase.endsWith('authenticated')
          expect(await info(provider.apiKeyEnv)).toMatchObject({ configured, writable: true })
        }
      }
      const expectedCalls = phase.startsWith('creation-') || phase === 'existing-removed-provider'
        ? phase === 'creation-authenticated' || phase === 'creation-removed-key' || phase === 'creation-removed-provider' ? 2 : 1
        : phase === 'existing-authenticated' || phase === 'existing-removed-key' || phase === 'existing-missing-key' ? 1 : 0
      expect(listing.calls).toEqual(Array.from({ length: expectedCalls }, () => ({ path: '/v1/models', authentication: 'stored' })))
      phases.push(phase)
      return { phase, publicStateVerified: true, credentialContentsRead: false, directoryRequests: listing.calls.length }
    },
    async cleanup() {
      try {
        const current = await view(), provider = current.value.providers[route]
        capture(provider)
        for (const ref of refs) {
          if ((await info(ref)).configured) await rpc('credentials/unset', { ref })
          expect(await info(ref)).toMatchObject({ configured: false, writable: true })
        }
        if (provider) await rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: current.revision,
          ops: [{ op: 'unset', path: ['providers', route] }] })
        const next = await view(); expect(next.value.providers).toEqual({})
        if (baseline && !baseline.parentOverridden && Object.hasOwn(next.user ?? {}, 'providers'))
          await rpc('settings/mutate', { ns: 'llm-pi-ai', expectedRevision: next.revision, ops: [{ op: 'unset', path: ['providers'] }] })
        if (baseline) expect(await hash()).toBe(baseline.hash)
        return { restored: true, profileRestored: true, refsUnconfigured: refs.size, phases,
          directoryCalls: listing.calls, credentialContentsRead: false, inferenceVerified: false }
      } finally { await listing.close() }
    },
  }
}
