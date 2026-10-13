import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'

/** 只通过官方提交接口生成真实多轮记录，再独立核对公开分页；不注入历史或模型结果。 */
export function officialLongHistoryChecks({ run, sessionId, provider, rpc, readSession }: {
  run: string; sessionId: string; provider: string
  rpc: (method: string, args: unknown) => Promise<any>; readSession: () => Promise<any>
}) {
  const markers: string[] = []
  const current = async () => {
    const state = await readSession(), pages: any[] = [], records: any[] = []
    let beforeSeq: number | undefined
    for (let index = 0; index < 8; index++) {
      const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId },
        throughSeq: state.snapshot.asOfSeq, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 },
        ...(beforeSeq === undefined ? {} : { beforeSeq }) } })
      expect(page.records.length).toBeGreaterThan(0)
      const first = page.records[0].event.seq, last = page.records.at(-1).event.seq
      if (beforeSeq !== undefined) expect(last + 1).toBe(beforeSeq)
      pages.push({ first, last, count: page.records.length, hasMore: page.hasMore })
      records.unshift(...page.records)
      if (!page.hasMore) break
      beforeSeq = first
    }
    expect(pages.at(-1).hasMore).toBe(false)
    expect(pages.length).toBeGreaterThanOrEqual(3)
    expect(records).toEqual(state.records)
    expect(new Set(records.map(row => row.event.seq)).size).toBe(records.length)
    for (let index = 1; index < records.length; index++)
      expect(records[index].event.seq).toBe(records[index - 1].event.seq + 1)
    return { records, pages, markers: [...markers], sessionId,
      contiguousOfficialPages: true, independentFullHistoryMatch: true }
  }
  return {
    sessionId,
    async prepare() {
      expect(markers).toHaveLength(0)
      // 52 个真实短轮次，加上原电脑/手机两轮，超过官方每页50条消息的两个窗口。
      for (let index = 1; index <= 52; index++) {
        const marker = 'DSHM_HISTORY_' + run.replaceAll('-', '') + '_' + String(index).padStart(2, '0')
        const text = `请只回复 ${marker}，不要调用工具。`
        await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue',
          content: [{ type: 'text', text }] } })
        await expect.poll(async () => (await rpc('session/list', { _request: {} })).items
          .find((item: any) => item.sessionId === sessionId)?.running, { timeout: 90000 }).toBe(false)
        const state = await readSession()
        const users = state.records.filter((row: any) => row.event.type === 'user/message'
          && JSON.stringify(row.event.data).includes(text))
        const replies = state.records.filter((row: any) => row.event.type === 'assistant/message'
          && row.event.data.message.content.filter((part: any) => part.type === 'text')
            .map((part: any) => part.text).join('\n').trim() === marker)
        expect(users).toHaveLength(1); expect(replies).toHaveLength(1)
        expect(replies[0].event.data.message.source.provider).toBe(provider)
        expect(state.records.some((row: any) => row.event.type === 'turn/end'
          && row.event.seq > replies[0].event.seq && row.event.data.reason.kind === 'completed')).toBe(true)
        markers.push(marker)
        if (index % 8 === 0 || index === 52) console.log(JSON.stringify({ historyTurnsCompleted: index, total: 52 }))
      }
      return { ...(await current()), realModelTurns: markers.length, realProviderVerified: true }
    },
    current,
  }
}
