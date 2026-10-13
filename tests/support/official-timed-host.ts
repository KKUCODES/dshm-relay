import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import { officialTimedQuestionChecks } from './official-timed-question.js'

type Inputs = Parameters<typeof officialTimedQuestionChecks>[0]

/** 只核对官方恢复追加的未知结果及原问题补答；不重放工具或修写会话记录。 */
export function officialTimedHostChecks(inputs: Inputs & {
  stop: () => Promise<any>; start: () => Promise<any>;
}) {
  const base = officialTimedQuestionChecks(inputs)
  const { rpc, sessionId, readSession } = inputs
  let original: any[], interrupted: any[], unknown: any, idle: any[], idleQuestions: any
  const digest = (records: any[]) => createHash('sha256').update(JSON.stringify(records)).digest('hex')
  const results = (records: any[], callId: string) => records.filter(item => item.event.type === 'tool/result'
    && item.event.data.message.toolCallId === callId)
  const lateReplies = (records: any[], callId: string) => records.filter(item => item.event.type === 'user/message'
    && item.event.data.source.kind === 'user-question-reply' && item.event.data.source.callId === callId)
  const running = async () => (await rpc('session/list', { _request: {} })).items
    .find((item: any) => item.sessionId === sessionId)?.running
  return {
    ...base,
    host: {
      stop: inputs.stop,
      start: inputs.start,
      async checkpoint(seed: any) {
        const proof = await base.verify(seed, 'open')
        original = (await readSession()).records
        expect(results(original, seed.callId)).toHaveLength(0)
        expect(lateReplies(original, seed.callId)).toHaveLength(0)
        expect(await running()).toBe(true)
        return { ...proof, records: original.length, sha256: digest(original) }
      },
      async recovered(seed: any) {
        await expect.poll(async () => results((await readSession()).records, seed.callId)
          .some(item => item.event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN'), { timeout: 45000 }).toBe(true)
        const current = await readSession()
        expect(current.records.slice(0, original.length)).toEqual(original)
        const found = results(current.records, seed.callId)
        expect(found).toHaveLength(1)
        unknown = found[0]
        expect(unknown.event.data.message.isError).toBe(true)
        expect(unknown.event.data.error.code).toBe('TOOL_OUTCOME_UNKNOWN')
        expect(JSON.stringify(unknown.event.data.message.content)).toContain('The tool call was interrupted after it was recorded')
        expect(lateReplies(current.records, seed.callId)).toHaveLength(0)
        expect(current.snapshot.values.userQuestions.active).toEqual([{
          callId: seed.callId, state: 'continued',
          questions: [{ id: seed.questionId, question: seed.question,
            options: [{ label: '蓝色' }, { label: '绿色' }], multiSelect: false }],
        }])
        const ends = current.records.filter((item: any) => item.event.type === 'turn/end'
          && item.event.seq > seed.initialSeq)
        expect(ends).toHaveLength(1)
        expect(ends[0].event.data.reason.kind).toBe('interrupted')
        expect(await running()).toBe(false)
        interrupted = current.records
        return { originalRecords: original.length, currentRecords: interrupted.length,
          originalPrefixSha256: digest(original), resultSeq: unknown.event.seq,
          errorCode: unknown.event.data.error.code, turnEndSeq: ends[0].event.seq,
          continuedOriginalQuestion: true, originalToolNotReplayed: true, lateReplies: 0 }
      },
      async answered(seed: any) {
        const current = await readSession()
        expect(current.records.slice(0, interrupted.length)).toEqual(interrupted)
        expect(results(current.records, seed.callId)).toEqual([unknown])
        const calls = current.records.filter((item: any) => item.event.type === 'tool/call' && item.event.seq > seed.initialSeq)
        expect(calls).toHaveLength(1)
        expect(calls[0].event.data.callId).toBe(seed.callId)
        const late = lateReplies(current.records, seed.callId)
        expect(late).toHaveLength(1)
        expect(late[0].event.data.source).toMatchObject({ kind: 'user-question-reply', callId: seed.callId, outcome: 'answered' })
        const value = JSON.parse(late[0].event.data.content.find((part: any) => part.type === 'text').text)
        expect(value).toMatchObject({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: seed.callId,
          questions: [{ id: seed.questionId, question: seed.question }],
          answers: [{ id: seed.questionId, selected: [seed.selected] }] })
        expect(current.snapshot.values.userQuestions.active).toHaveLength(0)
        expect(current.snapshot.values.userQuestions.settled).toEqual([{
          callId: seed.callId, answers: [{ id: seed.questionId, selected: [seed.selected] }],
        }])
        expect(await running()).toBe(false)
        return { originalRecords: original.length, interruptedRecords: interrupted.length,
          currentRecords: current.records.length, originalPrefixSha256: digest(original),
          toolCalls: 1, toolResults: 1, originalUnknownResultPreserved: true,
          lateReplies: 1, lateReplySeq: late[0].event.seq, settledOriginalQuestion: true }
      },
      async idleCheckpoint() {
        const current = await readSession()
        expect(await running()).toBe(false)
        expect(current.snapshot.values.userQuestions.active).toHaveLength(0)
        idle = current.records; idleQuestions = current.snapshot.values.userQuestions
        return { records: idle.length, sha256: digest(idle) }
      },
      async verifyIdle(seed: any) {
        const current = await readSession()
        expect(current.records.slice(0, idle.length)).toEqual(idle)
        for (const type of ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end'])
          expect(current.records.filter((item: any) => item.event.type === type))
            .toEqual(idle.filter(item => item.event.type === type))
        expect(current.snapshot.values.userQuestions).toEqual(idleQuestions)
        expect(results(current.records, seed.callId)).toEqual([unknown])
        expect(lateReplies(current.records, seed.callId)).toHaveLength(1)
        expect(await running()).toBe(false)
        return { originalRecords: idle.length, currentRecords: current.records.length,
          originalPrefixSha256: digest(idle), appendedTypes: current.records.slice(idle.length).map((item: any) => item.event.type),
          messagesAndToolAndReplyAndTurnResultsUnchanged: true }
      },
    },
  }
}
