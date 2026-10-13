import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'

/** Creator入口只选择空白会话；通过公开日志和配置证明没有启动任务或改写历史。 */
export function officialPresetCreatorChecks({ rpc, profilePath, readSession, sessionId, workspacePath, sessions }: {
  rpc: (method: string, args: unknown) => Promise<any>; profilePath: string; sessionId: string;
  readSession: () => Promise<{ records: any[]; snapshot: any }>; workspacePath: string; sessions: Set<string>
}) {
  let baseline: any, creatorSession: string | undefined, previousSessions: Set<string> | undefined
  const current = async () => {
    const view = (await rpc('settings/describe', {})).namespaces.find((item: any) => item.ns === 'agent-preset-registry')
    expect(view).toBeTruthy()
    const history = await readSession()
    return { value: structuredClone(view.value), user: structuredClone(view.user ?? {}),
      roster: await rpc('agentPresets/list', {}), records: history.records, preset: history.snapshot.values.agentPreset,
      profileHash: createHash('sha256').update(await readFile(profilePath)).digest('hex') }
  }
  const unchanged = async () => {
    if (!baseline) return { initialized: false, unchanged: true }
    expect(await current()).toEqual(baseline)
    return { initialized: true, unchanged: true, profileUnchanged: true, defaultsAndInheritanceUnchanged: true,
      rosterUnchanged: true, historyUnchanged: true }
  }
  return {
    async verify(phase: string, selected?: string, content?: string) {
      if (phase === 'initial') {
        baseline = await current()
        expect(baseline.roster.presets.map((row: any) => row.id).sort()).toEqual(['cordis', 'minimal', 'ptc', 'standard'])
        expect(baseline.roster.presets.every((row: any) => row.broken === undefined)).toBe(true)
        return { rows: baseline.roster.presets.map((row: any) => ({ id: row.id })), sessionId,
          originalDefault: baseline.roster.presets.find((row: any) => row.isDefault)?.id, originalPreset: baseline.preset }
      }
      await unchanged()
      if (phase === 'creator-ready') {
        const rows = (await rpc('session/list', { _request: {} })).items
        previousSessions = new Set(rows.map((row: any) => row.sessionId))
        return { previousSessionCount: previousSessions.size, workspaceSessionIds:
          rows.filter((row: any) => row.cwd === workspacePath).map((row: any) => row.sessionId) }
      }
      if (phase === 'declaration') {
        expect(baseline.roster.presets.some((row: any) => row.id === selected)).toBe(true)
        const document = await rpc('agentPresets/read', { agentPreset: selected })
        expect(document.agentPreset).toBe(selected); expect(content).toBe(document.content)
        return { id: selected, officialDeclarationMatched: true, bytes: Buffer.byteLength(document.content),
          sha256: createHash('sha256').update(document.content).digest('hex') }
      }
      if (phase === 'finish') return unchanged()
      if (phase === 'choice' || ['history', 'blank', 'plugin'].includes(phase)) {
        expect(selected).toBeTypeOf('string'); expect(selected).not.toBe(sessionId)
        sessions.add(selected!)
        const rows = (await rpc('session/list', { _request: {} })).items
        expect(rows.find((row: any) => row.sessionId === selected)?.cwd).toBe(workspacePath)
        const projection = await rpc('session/projections', { request: { sessionId: selected } })
        expect(projection.kind).toBe('sequenced')
        const preset = phase === 'choice' ? content : 'cordis'
        expect(baseline.roster.presets.some((row: any) => row.id === preset)).toBe(true)
        expect(projection.values.agentPreset).toBe(preset)
        const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: selected },
          throughSeq: projection.asOfSeq, maxMessages: 100 } })
        expect(page.hasMore).toBe(false)
        expect(page.records.some((row: any) => ['turn/start', 'user/message'].includes(row.event.type))).toBe(false)
        if (phase === 'history') {
          expect(previousSessions).toBeTruthy(); expect(previousSessions!.has(selected!)).toBe(false)
          creatorSession = selected
        }
        else if (phase !== 'choice') expect(selected).toBe(creatorSession)
        return { phase, selected, preset, sameWorkspace: true, officialProjectionVerified: true,
          noTaskStarted: true, historyAndDefaultsUnchanged: true, ...(phase === 'history' ? { newlyCreated: true } : {}),
          ...(phase === 'blank' || phase === 'plugin' ? { blankReused: true } : {}) }
      }
      throw Error('unknown_official_preset_creator_phase')
    },
    cleanup: unchanged,
  }
}
