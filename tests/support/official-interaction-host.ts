import { createHash, randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { officialTimedQuestionChecks } from './official-timed-question.js'

type Inputs = Parameters<typeof officialTimedQuestionChecks>[0]

/** 默认提问/计划的 waterfall 不持久化；只核对官方未知结果与显式新请求。 */
export function officialInteractionHostChecks(inputs: Inputs & {
  mode: 'legacy' | 'plan'; stop: () => Promise<any>; start: () => Promise<any>;
}) {
  const { rpc, sessionId, readSession, verifyReply, observeInteraction, mode } = inputs
  const prefixes = new Map<string, any[]>(), readers = new Map<string, any>()
  const unknowns = new Map<string, any>()
  let idle: any[], idlePlan: any
  const digest = (records: any[]) => createHash('sha256').update(JSON.stringify(records)).digest('hex')
  const results = (records: any[], callId: string) => records.filter(item => item.event.type === 'tool/result'
    && item.event.data.message.toolCallId === callId)
  const running = async () => (await rpc('session/list', { _request: {} })).items
    .find((item: any) => item.sessionId === sessionId)?.running
  const verifyCall = (records: any[], seed: any) => {
    const calls = records.filter(item => item.event.type === 'tool/call' && item.event.seq > seed.initialSeq)
    expect(calls).toHaveLength(1)
    expect(calls[0].event.data).toMatchObject({ name: mode === 'legacy' ? 'ask_user_question' : 'exit_plan_mode',
      callId: seed.callId })
    const args = JSON.parse(calls[0].event.data.arguments)
    if (mode === 'plan') expect(args).toEqual({ plan: seed.plan })
    else {
      expect(args.timeout).toBeUndefined()
      expect(args.questions).toHaveLength(1)
      expect(args.questions[0]).toMatchObject({ id: seed.questionId, question: seed.question })
      expect(args.questions[0].options.map((item: any) => item.label)).toEqual(['蓝色', '绿色'])
      expect(args.questions[0].multi_select === true).toBe(false)
      const header = records.findLast(item => item.event.type === 'request/header' && item.event.seq < calls[0].event.seq)
      expect(header.event.data.header.tools.find((item: any) => item.name === 'ask_user_question')
        .parameters.properties).not.toHaveProperty('timeout')
    }
    expect(records.filter(item => item.event.type === 'user/message'
      && item.event.data.content.some((part: any) => part.type === 'text' && part.text === seed.prompt))).toHaveLength(1)
  }
  const noLateAnswer = (records: any[], callId: string) => expect(records.filter(item => item.event.type === 'user/message'
    && item.event.data.source?.kind === 'user-question-reply' && item.event.data.source.callId === callId)).toHaveLength(0)
  return {
    mode, stop: inputs.stop, startHost: inputs.start,
    async state(active: boolean) {
      const plan = (await readSession()).snapshot.values.plan
      expect(plan).toEqual({ active, pending: false }); return plan
    },
    async start(prompt: string) {
      const requestId = randomUUID()
      await rpc('session/prompt', { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: prompt }] } })
      return { origin: 'official-desktop-public-session-prompt', requestId }
    },
    async checkpoint(seed: any) {
      const current = await readSession()
      verifyCall(current.records, seed)
      expect(results(current.records, seed.callId)).toHaveLength(0)
      expect(current.snapshot.values.userQuestions.active).toHaveLength(0)
      expect(current.snapshot.values.plan).toEqual({ active: mode === 'plan', pending: false })
      expect(await running()).toBe(true)
      expect(prefixes.has(seed.callId)).toBe(false)
      prefixes.set(seed.callId, current.records)
      const reader = await observeInteraction(sessionId, seed.callId, mode === 'plan'
        ? { plan: seed.plan } : { id: seed.questionId, question: seed.question })
      readers.set(seed.callId, reader)
      return { records: current.records.length, sha256: digest(current.records), observer: reader.summary }
    },
    async recovered(seed: any) {
      await expect.poll(async () => results((await readSession()).records, seed.callId)
        .some(item => item.event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN'), { timeout: 45000 }).toBe(true)
      const current = await readSession(), before = prefixes.get(seed.callId)!
      expect(before).toBeTruthy(); expect(current.records.slice(0, before.length)).toEqual(before)
      verifyCall(current.records, seed)
      const found = results(current.records, seed.callId)
      expect(found).toHaveLength(1)
      expect(found[0].event.data.message.isError).toBe(true)
      expect(found[0].event.data.error.code).toBe('TOOL_OUTCOME_UNKNOWN')
      expect(JSON.stringify(found[0].event.data.message.content)).toContain('The tool call was interrupted after it was recorded')
      noLateAnswer(current.records, seed.callId)
      expect(current.snapshot.values.userQuestions).toEqual({ active: [], settled: [] })
      expect(current.snapshot.values.plan).toEqual({ active: mode === 'plan', pending: false })
      const ends = current.records.filter((item: any) => item.event.type === 'turn/end' && item.event.seq > seed.initialSeq)
      expect(ends).toHaveLength(1); expect(ends[0].event.data.reason.kind).toBe('interrupted')
      expect(await running()).toBe(false)
      unknowns.set(seed.callId, found[0])
      return { originalRecords: before.length, currentRecords: current.records.length,
        originalPrefixSha256: digest(before), resultSeq: found[0].event.seq, errorCode: 'TOOL_OUTCOME_UNKNOWN',
        turnEndSeq: ends[0].event.seq, oldQuestionNotContinued: true, plan: current.snapshot.values.plan }
    },
    async oldAnswer(seed: any) {
      const before = (await readSession()).records, reader = readers.get(seed.callId)!
      expect(reader).toBeTruthy()
      const response = mode === 'plan' ? await reader.planDecision('approve')
        : await reader.answerRaw({ answers: [{ id: seed.questionId, selected: ['蓝色'] }] })
      // 记录实际协议响应；拒绝或旧事件幂等空操作都不得影响已中断的会话。
      expect(['result', 'error']).toContain(response.type)
      expect((await readSession()).records).toEqual(before)
      expect(await running()).toBe(false)
      reader.close(); readers.delete(seed.callId)
      return { response, officialRecordsUnchanged: true, noSteeringOrReplay: true }
    },
    async settled(token: string) {
      await expect.poll(async () => {
        const records = (await readSession()).records
        const reply = records.find((item: any) => item.event.type === 'assistant/message'
          && item.event.data.message.content.filter((part: any) => part.type === 'text')
            .map((part: any) => part.text).join('\n').trim() === token)
        return !!reply && records.some((item: any) => item.event.type === 'turn/end' && item.event.seq > reply.event.seq
          && item.event.data.reason.kind === 'completed')
      }, { timeout: 180000 }).toBe(true)
      await expect.poll(running, { timeout: 20000 }).toBe(false)
      return verifyReply(token)
    },
    async answered(seed: any, old: any) {
      const current = await readSession()
      verifyCall(current.records, seed)
      expect(results(current.records, old.callId)).toEqual([unknowns.get(old.callId)])
      expect(current.records.slice(0, prefixes.get(old.callId)!.length)).toEqual(prefixes.get(old.callId))
      noLateAnswer(current.records, old.callId)
      const calls = current.records.filter((item: any) => item.event.type === 'tool/call' && item.event.seq > old.initialSeq)
      expect(calls.map((item: any) => item.event.data.callId)).toEqual([old.callId, seed.callId])
      const found = results(current.records, seed.callId)
      expect(found).toHaveLength(1)
      const message = found[0].event.data.message
      const text = message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
      if (mode === 'legacy') {
        expect(message.isError === true).toBe(false)
        expect(JSON.parse(text)).toEqual({ answers: [{ id: seed.questionId, selected: [seed.selected] }] })
      } else {
        expect(message.isError === true).toBe(seed.outcome === 'modify')
        expect(text).toContain(seed.outcome === 'modify' ? 'dismissed the plan review' : 'Plan approved')
      }
      expect(current.snapshot.values.userQuestions.active).toHaveLength(0)
      expect(current.snapshot.values.plan).toEqual({ active: mode === 'plan' && seed.outcome === 'modify', pending: false })
      expect(await running()).toBe(false)
      return { oldCallId: old.callId, newCallId: seed.callId, originalUnknownResultUnchanged: true,
        explicitNewToolCalls: 1, resultSeq: found[0].event.seq, plan: current.snapshot.values.plan }
    },
    async idleCheckpoint() {
      const current = await readSession(); idle = current.records; idlePlan = current.snapshot.values.plan
      expect(await running()).toBe(false)
      return { records: idle.length, sha256: digest(idle), plan: idlePlan }
    },
    async verifyIdle() {
      const current = await readSession()
      expect(current.records.slice(0, idle.length)).toEqual(idle)
      for (const type of ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end', 'plan/mode'])
        expect(current.records.filter((item: any) => item.event.type === type)).toEqual(idle.filter(item => item.event.type === type))
      expect(current.snapshot.values.userQuestions.active).toHaveLength(0)
      expect(current.snapshot.values.plan).toEqual(idlePlan); expect(await running()).toBe(false)
      return { originalRecords: idle.length, currentRecords: current.records.length, originalPrefixSha256: digest(idle),
        appendedTypes: current.records.slice(idle.length).map((item: any) => item.event.type), noReplay: true, plan: idlePlan }
    },
  }
}
