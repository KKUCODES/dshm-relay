import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect } from 'vitest'
import type { officialHistoryTransport } from './official-history-transport.js'

/** 复用有独立真实来源证据的本项目长会话，只读并逐条检查原历史未变化。 */
export async function officialHistoryInflightChecks({ rpc, transport, readCurrent }: {
  rpc: (method: string, args: unknown) => Promise<any>
  transport: Awaited<ReturnType<typeof officialHistoryTransport>>; readCurrent: () => Promise<any>
}) {
  const seedRun = 'c0956c21-99f1-4838-b726-6bdd9a02c439'
  const report = JSON.parse(await readFile(resolve('artifacts/official-plugin-only', `official-android-${seedRun}.json`), 'utf8'))
  expect(report).toMatchObject({ version: '0.2.1-alpha.2', scope: 'phone-long-session-history-pagination-and-reconnect',
    passed: true, longHistoryVerified: true, cleanupCompleted: true })
  const sessionId = report.sessionId, title = 'DSHM 官方纯插件测试 ' + seedRun.slice(0, 8)
  const row = (await rpc('session/list', { _request: {} })).items.find((item: any) => item.sessionId === sessionId)
  expect(row).toMatchObject({ running: false })
  const current = async () => {
    const snapshot = await rpc('session/projections', { request: { sessionId } })
    expect(snapshot.values.title).toBe(title)
    const full = await rpc('session/page', { request: { address: { kind: 'session', sessionId },
      throughSeq: snapshot.asOfSeq, maxMessages: 500 } })
    expect(full.hasMore).toBe(false)
    const markers = Array.from({ length: 52 }, (_, index) =>
      'DSHM_HISTORY_' + seedRun.replaceAll('-', '') + '_' + String(index + 1).padStart(2, '0'))
    const pages: any[] = []
    let beforeSeq: number | undefined
    for (let index = 0; index < 8; index++) {
      const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId },
        throughSeq: snapshot.asOfSeq, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 },
        ...(beforeSeq === undefined ? {} : { beforeSeq }) } })
      const first = page.records[0].event.seq, last = page.records.at(-1).event.seq
      if (beforeSeq !== undefined) expect(last + 1).toBe(beforeSeq)
      pages.push({ first, last, count: page.records.length, hasMore: page.hasMore })
      if (!page.hasMore) break
      beforeSeq = first
    }
    expect(pages.length).toBeGreaterThanOrEqual(3); expect(pages.at(-1).hasMore).toBe(false)
    return { sessionId, records: full.records, pages, markers }
  }
  const baseline = await current()
  return {
    sessionId, title, current,
    arm: async (beforeSeq: number) => transport.arm({ sessionId, beforeSeq }),
    held: () => transport.held(), release: async () => transport.release(), reads: async () => transport.snapshot().reads,
    original: async () => (await readCurrent()).records.map((row: any) => row.event),
    async unchanged() {
      expect((await current()).records).toEqual(baseline.records)
      const row = (await rpc('session/list', { _request: {} })).items.find((item: any) => item.sessionId === sessionId)
      expect(row).toMatchObject({ running: false })
      return { seedRun, sessionId, records: baseline.records.length, originalHistoryUnchanged: true, noModelWorkInSeed: true }
    },
  }
}
