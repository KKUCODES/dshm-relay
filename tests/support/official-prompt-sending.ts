import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { expect } from 'vitest'
import type { officialPromptTransport } from './official-prompt-transport.js'

/** 只读官方会话原件，按原请求身份核对；测试不会代替手机补发消息。 */
export function officialPromptSendingChecks({ run, sessionId, rpc, readSession, verifyReply, profilePath, transport, processExit = false }: {
  run: string; sessionId: string; profilePath: string
  rpc: (method: string, args: unknown) => Promise<any>; readSession: () => Promise<any>
  verifyReply: (token: string) => Promise<any>; transport: Awaited<ReturnType<typeof officialPromptTransport>>
  processExit?: boolean
}) {
  const targets = Object.fromEntries(['before-forward', 'after-receipt'].map(phase => {
    const marker = 'DSHM_PROMPT_' + phase.replaceAll('-', '_') + '_' + run
    return [phase, { sessionId, marker, text: `请只回复 ${marker}，不要调用工具。` }]
  })) as Record<string, { sessionId: string; marker: string; text: string }>
  const targetOf = (phase: string) => {
    const target = targets[phase]
    if (!target) throw new Error('unknown_prompt_sending_phase')
    return target
  }
  let baseline: any, profile: Buffer, currentPhase: string, cut: any
  const phases: any[] = []
  const identity = (state: any) => ({ model: state.snapshot.values.modelSelection, permissions: state.snapshot.values.permissions })
  const unchanged = async (state: any) => {
    expect(await readFile(profilePath)).toEqual(profile)
    expect(identity(state)).toEqual(identity(baseline))
    expect(state.records.slice(0, baseline.records.length)).toEqual(baseline.records)
  }
  const users = (state: any, requestId: string) => state.records.filter((row: any) => row.event.type === 'user/message'
    && row.event.data.source?.kind === 'user' && row.event.data.source.rpcId === requestId)
  const accepted = async (requestId: string) => {
    const target = targetOf(currentPhase)
    await expect.poll(async () => (await readSession()).records.filter((row: any) => row.event.type === 'assistant/message'
      && row.event.data.message.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n').trim() === target.marker).length,
    { timeout: 180000 }).toBe(1)
    await expect.poll(async () => (await rpc('session/list', { _request: {} })).items.find((item: any) => item.sessionId === sessionId)?.running,
      { timeout: 30000 }).toBe(false)
    const state = await readSession(); await unchanged(state)
    const messages = users(state, requestId); expect(messages).toHaveLength(1)
    expect(messages[0].event.data.content).toEqual([{ type: 'text', text: target.text }])
    const added = state.records.slice(baseline.records.length)
    expect(added.filter((row: any) => row.event.type === 'user/message')).toHaveLength(1)
    expect(added.filter((row: any) => row.event.type === 'turn/start')).toHaveLength(1)
    expect(added.filter((row: any) => row.event.type === 'tool/call')).toHaveLength(0)
    return { originalRequestId: requestId, userSeq: messages[0].event.seq,
      reply: await verifyReply(target.marker), state, singleRealTurn: true, profileModelPermissionsUnchanged: true }
  }
  return {
    targets, processExit,
    async arm(phase: 'before-forward' | 'after-receipt') {
      currentPhase = phase; baseline = await readSession(); profile = await readFile(profilePath)
      expect((await rpc('session/list', { _request: {} })).items.find((item: any) => item.sessionId === sessionId)?.running).toBe(false)
      transport.arm(targetOf(phase), phase, processExit)
      return { sessionId, asOfSeq: baseline.snapshot.asOfSeq, identity: identity(baseline) }
    },
    held: () => transport.held(),
    async disconnected() {
      cut = await transport.cut(); expect(cut.request.sessionId).toBe(sessionId)
      expect(cut.request.mode).toBe('queue'); expect(cut.socketClosed).toBe(true)
      expect(transport.writes(targetOf(currentPhase))).toHaveLength(1)
      if (currentPhase === 'before-forward') {
        expect(cut.forwarded).toBe(false); expect(cut.receipt).toBeUndefined()
        const state = await readSession(); await unchanged(state); expect(state.records).toEqual(baseline.records)
        return { cut, noOfficialReceiptOrEvent: true, unchangedHistory: true }
      }
      expect(cut.forwarded).toBe(true); expect(cut.receipt).toMatchObject({ type: 'result', id: cut.id, value: { ok: true } })
      expect(cut.withheldTypes.at(-1)).toBe('result')
      const value = await accepted(cut.request.requestId)
      return { cut, ...value, state: undefined, modelCompletedWhilePhoneOffline: true }
    },
    resume: () => transport.resume(),
    async reconnected() {
      // 给真实恢复订阅一个观察窗口，不发送补偿请求，也不以测试结果替换生产状态。
      await new Promise(done => setTimeout(done, 2000))
      expect(transport.writes(targetOf(currentPhase))).toHaveLength(1)
      const state = await readSession(); await unchanged(state)
      if (currentPhase === 'before-forward') expect(state.records).toEqual(baseline.records)
      else expect(users(state, cut.request.requestId)).toHaveLength(1)
      return { noAutomaticReplay: true, requestCount: 1, originalRequestId: cut.request.requestId }
    },
    async settled() {
      const writes = transport.writes(targetOf(currentPhase))
      expect(writes).toHaveLength(currentPhase === 'before-forward' ? 2 : 1)
      const received = writes.filter(write => write.forwarded); expect(received).toHaveLength(1)
      const write = received[0]; assert.ok(write)
      if (currentPhase === 'before-forward') {
        expect(write.request.requestId).not.toBe(cut.request.requestId)
        expect(users(await readSession(), cut.request.requestId)).toHaveLength(0)
      }
      const value = await accepted(write.request.requestId)
      const phase = { phase: currentPhase, cut, writes, ...value, state: undefined,
        explicitRetryOnly: currentPhase === 'before-forward', noAutomaticReplay: true }
      phases.push(phase); return phase
    },
    async final() {
      const state = await readSession(); await unchanged(state)
      expect(phases.map(item => item.phase)).toEqual(['before-forward', 'after-receipt'])
      for (const item of phases) {
        expect(users(state, item.originalRequestId)).toHaveLength(1)
        await verifyReply(targetOf(item.phase).marker)
        expect(transport.writes(targetOf(item.phase))).toEqual(item.writes)
      }
      return { sessionId, phases, noDuplicateUserMessagesOrRealReplies: true, originalHistoryPrefixUnchanged: true,
        profileModelPermissionsUnchanged: true, passed: true }
    },
  }
}
