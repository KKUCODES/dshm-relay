import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'

/** 只使用已安装的公开预设；临时默认值沿官方设置恢复，不创建补丁归档。 */
export function officialPresetChecks({ rpc, profilePath, readSession, sessionId, workspacePath, sessions }: {
  rpc: (method: string, args: unknown) => Promise<any>; profilePath: string; sessionId: string;
  readSession: () => Promise<{ records: any[]; snapshot: any }>; workspacePath: string; sessions: Set<string>
}) {
  let baseline: { value: any; user: any; roster: any; records: any[]; preset: string; profileHash: string } | undefined
  let chosen: string | undefined
  const current = async () => {
    const view = (await rpc('settings/describe', {})).namespaces.find((item: any) => item.ns === 'agent-preset-registry')
    expect(view).toBeTruthy()
    return { value: structuredClone(view.value), user: structuredClone(view.user ?? {}), revision: view.revision,
      roster: await rpc('agentPresets/list', {}),
      profileHash: createHash('sha256').update(await readFile(profilePath)).digest('hex') }
  }
  const historyUnchanged = async () => {
    expect(baseline).toBeTruthy()
    const history = await readSession()
    expect(history.records).toEqual(baseline!.records)
    expect(history.snapshot.values.agentPreset).toBe(baseline!.preset)
  }
  const restore = async () => {
    if (!baseline) return { initialized: false, restored: true }
    let state = await current()
    if (JSON.stringify(state.value) !== JSON.stringify(baseline.value) || JSON.stringify(state.user) !== JSON.stringify(baseline.user)) {
      expect(state.value).toEqual({ ...baseline.value, selectedDefault: chosen })
      expect(state.user).toEqual({ ...baseline.user, selectedDefault: chosen })
      await rpc('settings/mutate', { ns: 'agent-preset-registry', expectedRevision: state.revision,
        ops: [Object.hasOwn(baseline.user, 'selectedDefault')
          ? { op: 'set', path: ['selectedDefault'], value: baseline.user.selectedDefault }
          : { op: 'unset', path: ['selectedDefault'] }] })
      state = await current()
    }
    expect(state.value).toEqual(baseline.value); expect(state.user).toEqual(baseline.user)
    expect(state.roster).toEqual(baseline.roster); expect(state.profileHash).toBe(baseline.profileHash)
    await historyUnchanged()
    return { initialized: true, restored: true, defaultsAndInheritanceRestored: true,
      profileRestored: true, historyUnchanged: true }
  }
  return {
    async verify(phase: string, selected?: string, content?: string) {
      const state = await current()
      if (phase === 'initial') {
        const history = await readSession(), preset = history.snapshot.values.agentPreset
        expect(preset).toBeTypeOf('string')
        chosen = state.roster.presets.find((row: any) => row.id === 'minimal' && row.isDefault !== true && row.broken === undefined)?.id
        expect(chosen).toBe('minimal')
        baseline = { ...state, records: history.records, preset }
        const defaultRow = state.roster.presets.find((row: any) => row.isDefault)
        expect(defaultRow).toBeTruthy()
        return { chosen, originalDefault: defaultRow.id, originalPreset: preset,
          rows: state.roster.presets.map((row: any) => ({ id: row.id, isDefault: row.isDefault })), sessionId }
      }
      await historyUnchanged()
      if (phase === 'declaration') {
        const document = await rpc('agentPresets/read', { agentPreset: chosen })
        expect(document.agentPreset).toBe(chosen); expect(content).toBe(document.content)
        return { officialDeclarationMatched: true, bytes: Buffer.byteLength(document.content),
          sha256: createHash('sha256').update(document.content).digest('hex') }
      }
      if (phase === 'default') {
        expect(state.value).toEqual({ ...baseline!.value, selectedDefault: chosen })
        expect(state.user).toEqual({ ...baseline!.user, selectedDefault: chosen })
        expect(state.roster.presets.map((row: any) => ({ ...row, isDefault: row.id === chosen })))
          .toEqual(state.roster.presets)
        expect(state.roster.presets.map(({ isDefault, ...row }: any) => row))
          .toEqual(baseline!.roster.presets.map(({ isDefault, ...row }: any) => row))
        return { officialDefaultChanged: true, rosterAndOtherFieldsPreserved: true, historyUnchanged: true }
      }
      if (phase === 'restore') return restore()
      if (phase === 'location') return { path: profilePath, historyUnchanged: true }
      if (phase === 'blank' || phase === 'inherited') {
        // 官方会话身份带 session- 前缀；归属由实际目录和投影核对，不猜裸 UUID。
        expect(selected).toBeTypeOf('string'); expect(selected).not.toBe(sessionId)
        sessions.add(selected!)
        const rows = (await rpc('session/list', { _request: {} })).items
        expect(rows.find((row: any) => row.sessionId === selected)?.cwd).toBe(workspacePath)
        const projection = await rpc('session/projections', { request: { sessionId: selected } })
        expect(projection.kind).toBe('sequenced'); expect(projection.values.agentPreset).toBe(chosen)
        // turnBoundary是Host内部状态，不在公开投影中；按原日志证明尚未开始聊天。
        const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: selected },
          throughSeq: projection.asOfSeq, maxMessages: 100 } })
        expect(page.hasMore).toBe(false)
        expect(page.records.some((row: any) => ['turn/start', 'user/message'].includes(row.event.type))).toBe(false)
        return { phase, selected, preset: chosen, sameWorkspace: true, officialProjectionVerified: true }
      }
      throw Error('unknown_official_preset_phase')
    },
    cleanup: restore,
  }
}
