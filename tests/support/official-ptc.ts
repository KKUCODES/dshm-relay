import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'

/** 只读公开会话投影/原记录，核对模型实际run_code及内层pwsh；不注入工具结果。 */
export function officialPtcChecks({ rpc, readParent, sessions, workspacePath, profilePath, provider }: {
  rpc: (method: string, args: unknown) => Promise<any>; readParent: () => Promise<{ records: any[] }>;
  sessions: Set<string>; workspacePath: string; profilePath: string; provider: string
}) {
  let selected: string | undefined, original: any[] | undefined, profile: string | undefined
  const hash = async () => createHash('sha256').update(await readFile(profilePath)).digest('hex')
  const read = async () => {
    expect(selected).toBeTruthy()
    const snapshot = await rpc('session/projections', { request: { sessionId: selected } })
    const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: selected },
      throughSeq: snapshot.asOfSeq, maxMessages: 500 } })
    expect(snapshot.values.agentPreset).toBe('ptc')
    expect(snapshot.values.permissions.currentValue).toBe('read-only')
    return { snapshot, records: page.records }
  }
  const running = async () => (await rpc('session/list', { _request: {} })).items
    .find((row: any) => row.sessionId === selected)?.running
  const calls = (records: any[], initialSeq: number, code: string, command: string) => {
    const roots = records.filter(row => row.event.type === 'tool/call' && row.event.seq > initialSeq)
    expect(roots).toHaveLength(1)
    const root = roots[0].event.data
    expect(root.name).toBe('run_code')
    expect(JSON.parse(root.arguments).code).toBe(code)
    const starts = records.filter(row => row.event.type === 'tool/ptc-dispatch-start'
      && row.event.data.parentCallId === root.callId)
    expect(starts).toHaveLength(1)
    const inner = starts[0].event.data
    expect(inner.name).toBe('pwsh')
    // 官方 PTC 事件保留独立的 JSON 对象，顶层 tool/call 才使用参数字符串。
    expect(inner.arguments.command).toBe(command)
    return { root, inner }
  }
  const text = (content: any[]) => content.filter(part => part.type === 'text').map(part => part.text).join('\n')
  return {
    async prepare() {
      original = (await readParent()).records; profile = await hash()
      const roster = await rpc('agentPresets/list', {})
      expect(roster.presets.some((row: any) => row.id === 'ptc' && !row.broken)).toBe(true)
      return { originalRecords: original!.length, officialPtcAvailable: true }
    },
    async select(id: string) {
      expect(selected).toBeUndefined(); sessions.add(id); selected = id
      expect((await rpc('session/list', { _request: {} })).items.find((row: any) => row.sessionId === id)?.cwd).toBe(workspacePath)
      const current = await read()
      return { sessionId: id, initialSeq: current.snapshot.asOfSeq, preset: 'ptc', permissions: 'read-only' }
    },
    async before() { return (await read()).snapshot.asOfSeq },
    async started(initialSeq: number, code: string, command: string) {
      let active: ReturnType<typeof calls> | undefined
      await expect.poll(async () => {
        const current = await read()
        if (!current.records.some((row: any) => row.event.type === 'tool/ptc-dispatch-start' && row.event.seq > initialSeq)) return false
        active = calls(current.records, initialSeq, code, command)
        expect(current.records.some((row: any) => row.event.type === 'tool/result'
          && row.event.data.message.toolCallId === active!.root.callId)).toBe(false)
        return running()
      }, { timeout: 60000 }).toBe(true)
      expect(active).toBeDefined()
      return { callId: active!.root.callId, subCallId: active!.inner.subCallId,
        rootCallId: active!.inner.rootCallId, realInnerRunning: true }
    },
    async settled({ initialSeq, code, command, reply, stopped, endMarker, returnMarker }: any) {
      await expect.poll(running, { timeout: 180000 }).toBe(false)
      const current = await read(), { root, inner } = calls(current.records, initialSeq, code, command)
      const rows = current.records.filter((row: any) => row.event.seq > initialSeq)
      const result = rows.filter((row: any) => row.event.type === 'tool/result' && row.event.data.message.toolCallId === root.callId)
      expect(result).toHaveLength(1)
      const message = result[0].event.data.message, rootOutput = text(message.content)
      const dispatch = rows.filter((row: any) => row.event.type === 'tool/ptc-dispatch' && row.event.data.subCallId === inner.subCallId)
      expect(dispatch).toHaveLength(1)
      const nestedOutput = text(dispatch[0].event.data.content)
      const end = rows.filter((row: any) => row.event.type === 'turn/end')
      expect(end).toHaveLength(1)
      if (stopped) {
        expect(end[0].event.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
        expect(message.isError).toBe(true); expect(dispatch[0].event.data.isError).toBe(true)
        expect(rootOutput).not.toContain(endMarker); expect(nestedOutput).not.toContain(endMarker)
        expect(rows.filter((row: any) => row.event.type === 'assistant/message').flatMap((row: any) =>
          row.event.data.message.content.filter((part: any) => part.type === 'text')).some((part: any) => part.text.includes(reply))).toBe(false)
      } else {
        expect(end[0].event.data.reason.kind).toBe('completed')
        expect(message.isError === true).toBe(false); expect(dispatch[0].event.data.isError).toBe(false)
        expect(rootOutput).toContain(endMarker); expect(rootOutput).toContain(returnMarker); expect(nestedOutput).toContain(endMarker)
        const replies = rows.filter((row: any) => row.event.type === 'assistant/message'
          && text(row.event.data.message.content).trim() === reply)
        expect(replies).toHaveLength(1); expect(replies[0].event.data.message.source.provider).toBe(provider)
      }
      return { sessionId: selected, callId: root.callId, subCallId: inner.subCallId, resultSeq: result[0].event.seq,
        dispatchSeq: dispatch[0].event.seq, reason: end[0].event.data.reason, rootOutput, nestedOutput,
        noDuplicateCallOrResult: true, officialNestedDispatchVerified: true, stopped: !!stopped,
        onlyReadOnlyCommands: true, preset: 'ptc' }
    },
    async unchanged() {
      if (!original) return { initialized: false, unchanged: true }
      expect((await readParent()).records.slice(0, original.length)).toEqual(original)
      expect(await hash()).toBe(profile)
      if (selected) expect(await running()).toBe(false)
      return { initialized: true, unchanged: true, originalHistoryPrefixUnchanged: true,
        profileUnchanged: true, testSessionIdle: true }
    },
  }
}
