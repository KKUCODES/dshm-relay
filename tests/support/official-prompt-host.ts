import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'
import type { officialPromptTransport } from './official-prompt-transport.js'

/** 原手机提交尚未确认时真正结束官方Host；恢复只读取原记录，不能代发或续跑旧轮。 */
export function officialPromptHostChecks({ run, sessionId, rpc, readSession, verifyReply, profilePath, transport,
  stopHost, startHost }: {
  run: string; sessionId: string; profilePath: string
  rpc: (method: string, args: unknown) => Promise<any>; readSession: () => Promise<any>
  verifyReply: (token: string) => Promise<any>; transport: Awaited<ReturnType<typeof officialPromptTransport>>
  stopHost: () => Promise<any>; startHost: () => Promise<any>
}) {
  const make = (phase: string) => {
    const marker = 'DSHM_PROMPT_HOST_' + phase.replaceAll('-', '_') + '_' + run
    return { sessionId, marker, text: phase === 'after-receipt'
      ? `请在内部逐步核算123456789乘987654321，最后只回复 ${marker}，不要调用工具。`
      : phase === 'followup'
        ? `这是一条独立的新消息。之前的请求已结束，不要继续、补答或重复之前任何请求的答案。只处理本条，严格只回复一行 ${marker}，不要包含其他标志或文字，不要调用工具。`
        : `请只回复 ${marker}，不要调用工具。` }
  }
  const targets = { 'before-forward': make('before-forward'), 'after-receipt': make('after-receipt'), followup: make('followup') }
  let phase: 'before-forward' | 'after-receipt', baseline: any, checkpoint: any, cut: any, profile: Buffer
  let recoveredRecords: any[] | undefined, originalRecovery: any
  const phases: any[] = []
  const identity = (state: any) => ({ model: state.snapshot.values.modelSelection, permissions: state.snapshot.values.permissions })
  const unchanged = async (state: any) => {
    expect(await readFile(profilePath)).toEqual(profile)
    expect(identity(state)).toEqual(identity(baseline))
    expect(state.records.slice(0, baseline.records.length)).toEqual(baseline.records)
    if (checkpoint) expect(state.records.slice(0, checkpoint.records.length)).toEqual(checkpoint.records)
    if (recoveredRecords) expect(state.records.slice(0, recoveredRecords.length)).toEqual(recoveredRecords)
  }
  const users = (state: any, requestId: string) => state.records.filter((row: any) => row.event.type === 'user/message'
    && row.event.data.source?.kind === 'user' && row.event.data.source.rpcId === requestId)
  const replies = (state: any, marker: string) => state.records.filter((row: any) => row.event.type === 'assistant/message'
    && row.event.data.message.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n').trim() === marker)
  const running = async () => (await rpc('session/list', { _request: {} })).items.find((item: any) => item.sessionId === sessionId)?.running
  const completed = async (target: typeof targets.followup, requestId: string) => {
    await expect.poll(async () => {
      const state = await readSession(), messages = users(state, requestId)
      return messages.length === 1 && state.records.some((row: any) => row.event.type === 'turn/end'
        && row.event.seq > messages[0].event.seq)
    }, { timeout: 180000 }).toBe(true)
    await expect.poll(running, { timeout: 30000 }).toBe(false)
    const state = await readSession(); await unchanged(state)
    const messages = users(state, requestId); expect(messages).toHaveLength(1)
    expect(messages[0].event.data.content).toEqual([{ type: 'text', text: target.text }])
    expect(replies(state, target.marker)).toHaveLength(1)
    return { requestId, userSeq: messages[0].event.seq, reply: await verifyReply(target.marker) }
  }
  const original = async () => {
    const state = await readSession(); await unchanged(state); expect(await running()).toBe(false)
    const messages = users(state, cut.request.requestId)
    const added = state.records.slice(baseline.records.length)
    expect(added.filter((row: any) => row.event.type === 'tool/call')).toHaveLength(0)
    if (phase === 'before-forward') {
      expect(messages).toHaveLength(0)
      expect(added.filter((row: any) => ['user/message', 'assistant/message', 'turn/start'].includes(row.event.type))).toHaveLength(0)
      return { originalRequestId: cut.request.requestId, noOfficialUserOrTurn: true }
    }
    expect(messages).toHaveLength(1)
    expect(added.filter((row: any) => row.event.type === 'turn/start')).toHaveLength(1)
    const ends = added.filter((row: any) => row.event.type === 'turn/end' && row.event.seq > messages[0].event.seq)
    expect(ends).toHaveLength(1)
    const kind = ends[0].event.data.reason.kind
    expect(['completed', 'interrupted']).toContain(kind)
    const modelReplies = replies(state, targets[phase].marker); expect(modelReplies.length).toBeLessThanOrEqual(1)
    // 正常运行中的核对与进程树真正结束之间，模型仍可能完成；不能把真实完成误判为重复发送。
    const reply = kind === 'completed' ? await verifyReply(targets[phase].marker) : modelReplies[0]?.event
    return { originalRequestId: cut.request.requestId, userSeq: messages[0].event.seq,
      endSeq: ends[0].event.seq, reason: ends[0].event.data.reason, reply,
      originalReplyCount: modelReplies.length, originalSettledWithoutReplay: true }
  }
  return {
    targets, hostExit: true,
    async arm(next: 'before-forward' | 'after-receipt') {
      phase = next; checkpoint = undefined; recoveredRecords = undefined; originalRecovery = undefined
      baseline = await readSession(); profile = await readFile(profilePath)
      expect(await running()).toBe(false); transport.arm(targets[phase], phase, false, true)
      return { sessionId, asOfSeq: baseline.snapshot.asOfSeq, identity: identity(baseline) }
    },
    async held() {
      cut = await transport.held(); expect(cut.awaitingHostExit).toBe(true); expect(cut.socketClosed).toBe(false)
      expect(cut.request.sessionId).toBe(sessionId); expect(cut.request.mode).toBe('queue')
      expect(transport.writes(targets[phase])).toHaveLength(1)
      const state = await readSession(); await unchanged(state)
      if (phase === 'before-forward') {
        expect(cut.forwarded).toBe(false); expect(cut.receipt).toBeUndefined(); expect(state.records).toEqual(baseline.records)
      } else {
        expect(cut.forwarded).toBe(true)
        expect(cut.receipt).toMatchObject({ type: 'result', id: cut.id, value: { ok: true, value: { accepted: true } } })
        await expect.poll(async () => users(await readSession(), cut.request.requestId).length, { timeout: 30000 }).toBe(1)
      }
      return cut
    },
    async stop() {
      checkpoint = await readSession(); await unchanged(checkpoint)
      const isRunning = await running()
      expect(isRunning).toBe(phase === 'after-receipt')
      if (phase === 'before-forward') expect(checkpoint.records).toEqual(baseline.records)
      else {
        const user = users(checkpoint, cut.request.requestId); expect(user).toHaveLength(1)
        expect(replies(checkpoint, targets[phase].marker)).toHaveLength(0)
        expect(checkpoint.records.filter((row: any) => row.event.type === 'turn/end' && row.event.seq > user[0].event.seq)).toHaveLength(0)
      }
      const stopped = await stopHost(), disconnected = await transport.hostExited()
      expect(disconnected.awaitingHostExit).toBe(true); expect(disconnected.hostDisconnectFrames.length).toBeGreaterThan(0)
      return { stopped, disconnected, originalRunningAtStop: isRunning, originalRecords: checkpoint.records.length,
        checkpointSha256: createHash('sha256').update(JSON.stringify(checkpoint.records)).digest('hex'), realHostDisconnectForwarded: true }
    },
    async start() { transport.resumeHost(); return startHost() },
    async reconnected() {
      await new Promise(done => setTimeout(done, 2000))
      expect(transport.writes(targets[phase])).toHaveLength(1)
      originalRecovery = await original(); recoveredRecords = (await readSession()).records
      return { ...originalRecovery, noAutomaticReplay: true, requestCount: 1 }
    },
    async settled() {
      // 手机点击完成不代表真实WebSocket帧已经到达门控；等待原请求实际到达再检查唯一性。
      await expect.poll(() => transport.writes(phase === 'before-forward' ? targets[phase] : targets.followup).length,
        { timeout: 30000 }).toBe(phase === 'before-forward' ? 2 : 1)
      const writes = transport.writes(targets[phase])
      if (phase === 'before-forward') {
        expect(writes).toHaveLength(2)
        const accepted = writes.filter(write => write.forwarded); expect(accepted).toHaveLength(1)
        const write = accepted[0]; if (!write) throw Error('official_prompt_host_retry_missing')
        expect(write.request.requestId).not.toBe(cut.request.requestId)
        expect(users(await readSession(), cut.request.requestId)).toHaveLength(0)
        const value = await completed(targets[phase], write.request.requestId)
        const state = await readSession(); expect(state.records.slice(baseline.records.length)
          .filter((row: any) => row.event.type === 'user/message')).toHaveLength(1)
        phases.push({ phase, cut, writes, ...value, explicitRetryOnly: true })
      } else {
        expect(writes).toHaveLength(1)
        const followup = transport.writes(targets.followup)
        expect(followup).toHaveLength(1)
        const write = followup[0]; if (!write) throw Error('official_prompt_host_followup_missing')
        expect(write.forwarded).toBe(true); expect(write.request.requestId).not.toBe(cut.request.requestId)
        const value = await completed(targets.followup, write.request.requestId)
        // 新轮的turn/start先于其user/message，不能用下一条用户消息的序号切割旧轮。
        // 保持恢复时已经核对的整段原记录，再独立核对显式新轮及原请求不重复。
        const recovered = originalRecovery; expect(recovered.originalSettledWithoutReplay).toBe(true)
        phases.push({ phase, cut, writes, recovered, followup: { writes: followup, ...value }, noAutomaticReplay: true })
      }
      return phases.at(-1)
    },
    async final() {
      const state = await readSession(); await unchanged(state)
      expect(phases.map(item => item.phase)).toEqual(['before-forward', 'after-receipt'])
      expect(users(state, phases[0].cut.request.requestId)).toHaveLength(0)
      for (const item of phases) {
        expect(transport.writes(targets[item.phase as keyof typeof targets])).toEqual(item.writes)
        const requestId = item.phase === 'before-forward' ? item.requestId : item.cut.request.requestId
        expect(users(state, requestId)).toHaveLength(1)
      }
      expect(users(state, phases[1].followup.requestId)).toHaveLength(1)
      for (const type of ['user/message', 'turn/start']) expect(state.records.slice(baseline.records.length)
        .filter((row: any) => row.event.type === type)).toHaveLength(2)
      await verifyReply(targets['before-forward'].marker); await verifyReply(targets.followup.marker)
      expect(replies(state, targets['after-receipt'].marker).length).toBeLessThanOrEqual(1)
      return { sessionId, phases, noDuplicateOriginalUserMessages: true, explicitNewTasksHaveRealReplies: true,
        settledOriginalNotReexecuted: true, originalHistoryPrefixUnchanged: true, profileModelPermissionsUnchanged: true, passed: true }
    },
  }
}
