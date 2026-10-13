import { createHash, randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { officialTimedQuestionChecks } from './official-timed-question.js'

type Inputs = Parameters<typeof officialTimedQuestionChecks>[0]

/** 两条真实已批准连接竞答同一waterfall；从官方单条结果判定获胜者。 */
export function officialInteractionRaceChecks(inputs: Inputs & { mode: 'legacy' | 'plan' }) {
  const { rpc, sessionId, readSession, verifyReply, observeInteraction, mode } = inputs
  const prefixes = new Map<string, any[]>(), readers = new Map<string, any[]>()
  const digest = (records: any[]) => createHash('sha256').update(JSON.stringify(records)).digest('hex')
  const results = (records: any[], callId: string) => records.filter(item => item.event.type === 'tool/result'
    && item.event.data.message.toolCallId === callId)
  const running = async () => (await rpc('session/list', { _request: {} })).items
    .find((item: any) => item.sessionId === sessionId)?.running
  const checkCall = (records: any[], seed: any) => {
    const calls = records.filter(item => item.event.type === 'tool/call' && item.event.seq > seed.initialSeq)
    expect(calls).toHaveLength(1)
    expect(calls[0].event.data).toMatchObject({ name: mode === 'plan' ? 'exit_plan_mode' : 'ask_user_question', callId: seed.callId })
    const args = JSON.parse(calls[0].event.data.arguments)
    if (mode === 'plan') expect(args).toEqual({ plan: seed.plan })
    else {
      expect(args.timeout).toBeUndefined(); expect(args.questions).toHaveLength(1)
      expect(args.questions[0]).toMatchObject({ id: seed.questionId, question: seed.question })
      expect(args.questions[0].options.map((item: any) => item.label)).toEqual(['蓝色', '绿色'])
      expect(args.questions[0].multi_select === true).toBe(false)
    }
    expect(records.filter(item => item.event.type === 'user/message'
      && item.event.data.content.some((part: any) => part.type === 'text' && part.text === seed.prompt))).toHaveLength(1)
  }
  const sendDecision = (reader: any, seed: any, decision: string) => mode === 'plan'
    ? reader.planDecision(decision)
    : reader.answerRaw({ answers: [{ id: seed.questionId, selected: [decision] }] })
  return {
    mode,
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
      checkCall(current.records, seed); expect(results(current.records, seed.callId)).toHaveLength(0)
      expect(current.snapshot.values.userQuestions.active).toHaveLength(0)
      expect(current.snapshot.values.plan).toEqual({ active: mode === 'plan', pending: false })
      expect(await running()).toBe(true); expect(prefixes.has(seed.callId)).toBe(false)
      prefixes.set(seed.callId, current.records)
      const targets = []
      for (let index = 0; index < 2; index++) targets.push(await observeInteraction(sessionId, seed.callId,
        mode === 'plan' ? { plan: seed.plan } : { id: seed.questionId, question: seed.question }))
      expect(new Set(targets.map(reader => reader.summary.clientId)).size).toBe(2)
      expect(new Set(targets.map(reader => reader.summary.eventId)).size).toBe(1)
      readers.set(seed.callId, targets)
      return { records: current.records.length, sha256: digest(current.records), observers: targets.map(reader => reader.summary) }
    },
    async compete(seed: any) {
      const targets = readers.get(seed.callId)!
      expect(targets).toHaveLength(2)
      const choices = mode === 'plan' ? ['approve', 'modify'] : ['蓝色', '绿色']
      const ordered = seed.round === 0 ? choices : [...choices].reverse()
      const sends: any[] = []
      const responses = await Promise.all(targets.map(async (reader, index) => {
        const sent = { clientId: reader.summary.clientId, eventId: reader.summary.eventId,
          decision: ordered[index], startedAt: performance.now(), receivedAt: 0 }
        sends.push(sent)
        const response = await sendDecision(reader, seed, ordered[index]!)
        sent.receivedAt = performance.now()
        expect(response).toMatchObject({ type: 'result', value: { ok: true } })
        return { decision: sent.decision, response }
      }))
      // 两个请求都已发起才收到任何结果；不把顺序旧答复检查冒充并发提交。
      expect(Math.max(...sends.map(item => item.startedAt))).toBeLessThan(Math.min(...sends.map(item => item.receivedAt)))
      await expect.poll(() => targets.reduce((sum, reader) => sum + reader.cancellations().length, 0), { timeout: 15000 })
        .toBe(1)
      return { sends, responses, requestsOverlapped: true, cancellationFrames: targets.map(reader => ({
        clientId: reader.summary.clientId, frames: reader.cancellations(),
      })) }
    },
    async pending(seed: any) {
      const current = await readSession(), before = prefixes.get(seed.callId)!
      expect(before).toBeTruthy(); expect(current.records).toEqual(before)
      checkCall(current.records, seed); expect(results(current.records, seed.callId)).toHaveLength(0)
      expect(current.snapshot.values.userQuestions.active).toHaveLength(0)
      expect(current.snapshot.values.plan).toEqual({ active: mode === 'plan', pending: false })
      expect(await running()).toBe(true)
      return { records: current.records.length, sha256: digest(current.records), originalRecordsUnchanged: true,
        singlePendingTool: true, plan: current.snapshot.values.plan }
    },
    async settled(seed: any) {
      await expect.poll(async () => results((await readSession()).records, seed.callId).length, { timeout: 180000 }).toBe(1)
      const found = results((await readSession()).records, seed.callId)[0]
      const message = found.event.data.message
      const text = message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
      let winner: string
      if (mode === 'legacy') {
        expect(message.isError === true).toBe(false)
        const answer = JSON.parse(text)
        expect(answer.answers).toHaveLength(1); expect(answer.answers[0].id).toBe(seed.questionId)
        expect(answer.answers[0].selected).toHaveLength(1)
        winner = answer.answers[0].selected[0]; expect(['蓝色', '绿色']).toContain(winner)
      } else {
        winner = message.isError === true ? 'modify' : 'approve'
        expect(text).toContain(winner === 'modify' ? 'dismissed the plan review' : 'Plan approved')
      }
      const token = seed.prefix + (mode === 'legacy' ? winner : winner.toUpperCase())
      await expect.poll(async () => {
        const records = (await readSession()).records
        const reply = records.find((item: any) => item.event.type === 'assistant/message'
          && item.event.data.message.content.filter((part: any) => part.type === 'text')
            .map((part: any) => part.text).join('\n').trim() === token)
        return !!reply && records.some((item: any) => item.event.type === 'turn/end' && item.event.seq > reply.event.seq
          && item.event.data.reason.kind === 'completed')
      }, { timeout: 180000 }).toBe(true)
      await expect.poll(running, { timeout: 20000 }).toBe(false)
      const current = await readSession(), before = prefixes.get(seed.callId)!
      expect(current.records.slice(0, before.length)).toEqual(before)
      checkCall(current.records, seed); expect(results(current.records, seed.callId)).toEqual([found])
      expect(current.snapshot.values.userQuestions.active).toHaveLength(0)
      expect(current.snapshot.values.plan).toEqual({ active: mode === 'plan' && winner === 'modify', pending: false })
      return { winner, token, reply: await verifyReply(token), resultSeq: found.event.seq,
        originalRecords: before.length, currentRecords: current.records.length, originalPrefixSha256: digest(before),
        singleToolAndResult: true, plan: current.snapshot.values.plan }
    },
    async duplicate(seed: any, winner: string) {
      const before = (await readSession()).records, targets = readers.get(seed.callId)!
      const opposite = mode === 'plan' ? winner === 'approve' ? 'modify' : 'approve' : winner === '蓝色' ? '绿色' : '蓝色'
      const responses = await Promise.all(targets.map(reader => sendDecision(reader, seed, opposite)))
      for (const response of responses) expect(response).toMatchObject({ type: 'result', value: { ok: true } })
      expect((await readSession()).records).toEqual(before); expect(await running()).toBe(false)
      for (const reader of targets) reader.close()
      readers.delete(seed.callId)
      return { responses, oppositeOldAnswersAreNoop: true, officialRecordsUnchanged: true }
    },
  }
}
