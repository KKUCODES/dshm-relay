import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import { officialTimedQuestionChecks } from './official-timed-question.js'

type Inputs = Parameters<typeof officialTimedQuestionChecks>[0]

/** 原pending工具结果必须保持；两条真实连接的补答只能追加一条原问题用户消息。 */
export function officialTimedRaceChecks(inputs: Inputs & { openReplyConnection: () => Promise<any> }) {
  const base = officialTimedQuestionChecks(inputs)
  const { readSession } = inputs
  const targets = new Map<string, any[]>(), prefixes = new Map<string, any[]>(), pendingResults = new Map<string, any>()
  const replies = (records: any[], callId: string) => records.filter(item => item.event.type === 'user/message'
    && item.event.data.source?.kind === 'user-question-reply' && item.event.data.source.callId === callId)
  return {
    ...base,
    async prepare(seed: any) {
      const proof = await base.verify(seed, 'continued'), current = await readSession()
      expect(replies(current.records, seed.callId)).toHaveLength(0)
      const result = current.records.filter((item: any) => item.event.type === 'tool/result'
        && item.event.data.message.toolCallId === seed.callId)
      expect(result).toHaveLength(1)
      pendingResults.set(seed.callId, result[0]); prefixes.set(seed.callId, current.records)
      const readers = [await inputs.openReplyConnection(), await inputs.openReplyConnection()]
      expect(new Set(readers.map(reader => reader.summary.clientId)).size).toBe(2)
      targets.set(seed.callId, readers)
      return { ...proof, completePrefixRecords: current.records.length,
        completePrefixSha256: createHash('sha256').update(JSON.stringify(current.records)).digest('hex'),
        observers: readers.map(reader => reader.summary) }
    },
    async compete(seed: any) {
      const readers = targets.get(seed.callId)!, choices = seed.round === 0 ? ['蓝色', '绿色'] : ['绿色', '蓝色']
      expect(readers).toHaveLength(2)
      const sends: any[] = []
      const responses = await Promise.all(readers.map(async (reader, index) => {
        const sent = { clientId: reader.summary.clientId, selected: choices[index], startedAt: performance.now(), receivedAt: 0 }
        sends.push(sent)
        const response = await reader.answer(seed.callId, { answers: [{ id: seed.questionId, selected: [choices[index]] }] })
        sent.receivedAt = performance.now(); return { selected: choices[index], response }
      }))
      expect(Math.max(...sends.map(item => item.startedAt))).toBeLessThan(Math.min(...sends.map(item => item.receivedAt)))
      const accepted = responses.filter(item => item.response.type === 'result'
        && item.response.value?.ok === true && item.response.value.value === true)
      expect(accepted).toHaveLength(1)
      for (const item of responses.filter(item => item !== accepted[0])) {
        expect(item.response.type).toBe('result')
        const result = item.response.value
        if (result.ok === true) expect(result.value).toBe(false)
        else expect(JSON.stringify(result.error)).toMatch(/REPLY_QUEUED|a reply is already queued for this question/)
      }
      return { sends, responses, requestsOverlapped: true, acceptedReplies: 1, acceptedColor: accepted[0]!.selected }
    },
    async settledWinner(seed: any, selected: string) {
      expect(['蓝色', '绿色']).toContain(selected)
      const token = seed.prefix + selected
      const reply = await base.settled(token)
      const proof = await base.verify({ ...seed, selected }, 'answered'), current = await readSession()
      const before = prefixes.get(seed.callId)!
      expect(current.records.slice(0, before.length)).toEqual(before)
      expect(current.records.filter((item: any) => item.event.type === 'tool/result'
        && item.event.data.message.toolCallId === seed.callId)).toEqual([pendingResults.get(seed.callId)])
      const late = replies(current.records, seed.callId)
      expect(late).toHaveLength(1)
      const batch = JSON.parse(late[0].event.data.content.find((part: any) => part.type === 'text').text)
      expect(batch).toMatchObject({ kind: 'answer_to_pending_question', callId: seed.callId,
        answers: [{ id: seed.questionId, selected: [selected] }] })
      return { ...proof, winner: selected, token, reply, completePrefixRecords: before.length,
        pendingResultUnchanged: true, lateReplySeq: late[0].event.seq, singleNewUserReply: true }
    },
    async duplicate(seed: any, winner: string) {
      const before = (await readSession()).records, readers = targets.get(seed.callId)!
      const opposite = winner === '蓝色' ? '绿色' : '蓝色'
      const responses = await Promise.all(readers.map(reader => reader.answer(seed.callId,
        { answers: [{ id: seed.questionId, selected: [opposite] }] })))
      for (const response of responses) expect(response).toMatchObject({ type: 'result', value: { ok: true, value: false } })
      expect((await readSession()).records).toEqual(before)
      for (const reader of readers) reader.close()
      targets.delete(seed.callId)
      return { responses, noAdditionalUserReplyOrSteering: true, officialRecordsUnchanged: true }
    },
  }
}
