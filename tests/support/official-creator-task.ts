import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'

/** 对照真实Cordis工具记录；只查询公开Host目录，不伪造Client检查响应。 */
export function officialCreatorTaskChecks({ readSession, profilePath }: {
  readSession: () => Promise<{ records: any[]; snapshot: any }>; profilePath: string
}) {
  let baseline: any[] | undefined, profileHash: string | undefined
  const hash = async () => createHash('sha256').update(await readFile(profilePath)).digest('hex')
  const unchanged = async () => {
    if (!baseline) return { initialized: false, unchanged: true }
    const current = await readSession()
    expect(current.snapshot.values.agentPreset).toBe('cordis')
    expect(current.records.slice(0, baseline.length)).toEqual(baseline)
    expect(await hash()).toBe(profileHash)
    return { initialized: true, unchanged: true, historyPrefixUnchanged: true, profileUnchanged: true, preset: 'cordis' }
  }
  return {
    async verify(phase: string, initialSeq?: number) {
      const current = await readSession()
      expect(current.snapshot.values.agentPreset).toBe('cordis')
      if (phase === 'prepare') {
        baseline = current.records; profileHash = await hash()
        return { initialSeq: current.snapshot.asOfSeq, preset: 'cordis' }
      }
      await unchanged()
      expect(initialSeq).toBeTypeOf('number')
      const calls = current.records.filter((row: any) => row.event.type === 'tool/call' && row.event.seq > initialSeq!)
      expect(calls.map((row: any) => row.event.data.name)).toEqual(['cordis_inspect_list', 'cordis_inspect_query'])
      const outputs = calls.map((row: any) => {
        const callId = row.event.data.callId
        const results = current.records.filter((item: any) => item.event.type === 'tool/result'
          && item.event.data.message.source?.callId === callId)
        expect(results).toHaveLength(1)
        const message = results[0].event.data.message
        expect(message.isError === true).toBe(false); expect(message.toolCallId).toBe(callId)
        const text = message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
        return { callId, resultSeq: results[0].event.seq, value: JSON.parse(text) }
      })
      const [discovery, query] = outputs
      if (!discovery || !query) throw new Error('Expected both official Cordis inspection results')
      const provider = discovery.value.providers.find((row: any) => row.platform === 'host' && row.id === 'Tool')
      expect(provider.methods.some((method: any) => method.name === 'listTools')).toBe(true)
      expect(JSON.parse(calls[1].event.data.arguments)).toMatchObject({ platform: 'host', provider: 'Tool', method: 'listTools' })
      expect(query.value).toMatchObject({ platform: 'host', provider: 'Tool', method: 'listTools' })
      const tools = query.value.data.tools
      expect(tools.some((tool: any) => tool.name === 'write')).toBe(true)
      expect(tools.some((tool: any) => tool.name === 'cordis_inspect_query')).toBe(true)
      return { preset: 'cordis', hostProviderDiscovered: true, queryMatchesActualManifest: true,
        realToolResultsVerified: true, profileUnchanged: true, historyPrefixUnchanged: true,
        callIds: calls.map((row: any) => row.event.data.callId), toolCount: tools.length,
        outputs: outputs.map(({ callId, resultSeq }) => ({ callId, resultSeq })) }
    },
    cleanup: unchanged,
  }
}
