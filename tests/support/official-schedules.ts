import { expect } from 'vitest'

/** 独立查询官方持久记录及实际消息；只清理专用会话中本轮创建的提醒。 */
export function officialScheduleChecks({ rpc, readSession, verifyReply, sessionId, marker }: {
  rpc: (method: string, args: unknown) => Promise<any>
  readSession: () => Promise<any>
  verifyReply: (marker: string) => Promise<any>
  sessionId: string
  marker: string
}) {
  const read = () => rpc('schedule/list', { request: { sessionId } })
  const deliveryToken = marker + '_DELIVERED'
  const prompt = `请只回复 ${deliveryToken}，不要调用任何工具，不读取或修改文件，不创建、修改或删除提醒。`
  let seeds: any[] = [], records: any[] = []
  return {
    marker, sessionId, deliveryToken, read, history: readSession,
    async initial() {
      await rpc('commands/execute', { agentId: sessionId, line: '/permission read-only', submittedAttachments: [] })
      expect((await readSession()).snapshot.values.permissions.currentValue).toBe('read-only')
      expect(await read()).toEqual([])
      seeds = [
        { title: marker + '_AFTER', prompt, after_seconds: 90 },
        { title: marker + '_AT', prompt, at: new Date(Date.now() + 3600000).toISOString() },
        { title: marker + '_EVERY', prompt, every_seconds: 3600 },
        { title: marker + '_DAILY', prompt, daily: { time: '23:59:00', time_zone: 'UTC' } },
        { title: marker + '_WEEKLY', prompt, weekly: { time: '23:59:00', time_zone: 'UTC', weekdays: [1, 3, 5] } },
        { title: marker + '_CRON', prompt, cron: { expression: '59 23 * * *', time_zone: 'UTC' } },
      ]
      return seeds
    },
    async created(before: any) {
      await expect.poll(async () => (await read()).length, { timeout: 60000 }).toBe(6)
      await expect.poll(async () => (await rpc('session/list', { _request: {} })).items
        .find((row: any) => row.sessionId === sessionId)?.running, { timeout: 60000 }).toBe(false)
      const current = await readSession()
      expect(current.records.slice(0, before.records.length)).toEqual(before.records)
      const added = current.records.filter((row: any) => row.event.seq > before.snapshot.asOfSeq)
      const calls = added.filter((row: any) => row.event.type === 'tool/call')
      expect(calls).toHaveLength(6)
      for (const seed of seeds) {
        const matches = calls.filter((row: any) => row.event.data.name === 'schedule_create'
          && JSON.parse(row.event.data.arguments).title === seed.title)
        expect(matches).toHaveLength(1)
        expect(JSON.parse(matches[0].event.data.arguments)).toEqual(seed)
        const results = added.filter((row: any) => row.event.type === 'tool/result'
          && row.event.data.message.toolCallId === matches[0].event.data.callId)
        expect(results).toHaveLength(1)
        expect(results[0].event.data.message.isError).toBe(false)
      }
      records = await read()
      expect(new Set(records.map(row => row.id)).size).toBe(6)
      expect(records.map(row => row.kind).sort()).toEqual(['after', 'at', 'cron', 'daily', 'every', 'weekly'])
      for (const row of records) {
        expect(seeds.some(seed => seed.title === row.title && seed.prompt === row.prompt)).toBe(true)
        expect(Date.parse(row.scheduledAt)).toBeGreaterThan(Date.now())
        if (row.kind === 'after') expect(row.afterSeconds).toBe(90)
        if (row.kind === 'every') expect(row.everySeconds).toBe(3600)
        if (row.kind === 'at') expect(row.scheduledAt).toBe(seeds[1].at)
        if (row.kind === 'daily' || row.kind === 'weekly') expect(row.time).toBe('23:59:00.000')
        if (['daily', 'weekly', 'cron'].includes(row.kind)) expect(row.timeZone).toBe('UTC')
        if (row.kind === 'weekly') expect(row.weekdays).toEqual([1, 3, 5])
        if (row.kind === 'cron') expect(row.expression).toBe('59 23 * * *')
      }
      return { records, ...await verifyReply(marker), originalToolsAndRulesVerified: true }
    },
    async renameOnComputer() {
      const before = await readSession(), original = records.find(row => row.kind === 'every')
      const updated = await rpc('schedule/update', { request: { sessionId, id: original.id,
        expected: original, title: marker + '_COMPUTER_EDIT' } })
      expect(updated.updated).toBe(true)
      expect(updated.record).toEqual({ ...original, title: marker + '_COMPUTER_EDIT' })
      expect((await readSession()).records).toEqual(before.records)
      records = await read()
      return { title: updated.record.title, records, originalTimingAndMessagesUnchanged: true }
    },
    async delivered(before: any) {
      await expect.poll(async () => (await read()).length, { timeout: 150000 }).toBe(5)
      await expect.poll(async () => (await readSession()).records.some((row: any) => row.event.type === 'assistant/message'
        && row.event.data.message.content.some((part: any) => part.type === 'text' && part.text.trim() === deliveryToken)),
      { timeout: 60000 }).toBe(true)
      await expect.poll(async () => (await rpc('session/list', { _request: {} })).items
        .find((row: any) => row.sessionId === sessionId)?.running, { timeout: 20000 }).toBe(false)
      const current = await readSession(), original = records.find(row => row.kind === 'after')
      expect(current.records.slice(0, before.records.length)).toEqual(before.records)
      const added = current.records.filter((row: any) => row.event.seq > before.snapshot.asOfSeq)
      const delivered = added.filter((row: any) => row.event.type === 'user/message' && row.event.data.source.kind === 'schedule')
      expect(delivered).toHaveLength(1)
      expect(JSON.stringify(delivered[0].event.data.content)).toContain(deliveryToken)
      expect(added.filter((row: any) => row.event.type === 'tool/call')).toHaveLength(0)
      const saved = await rpc('schedule/history', { request: { sessionId, id: original.id, limit: 10 } })
      expect(saved.records).toHaveLength(1)
      expect(saved.records[0]).toMatchObject({ scheduledAt: original.scheduledAt, prompt })
      expect(JSON.stringify(delivered[0].event.data)).toContain(saved.records[0].messageId)
      expect(saved.earlierRecordsUnavailable).toBe(false)
      const inactive = (await rpc('schedule/catalog', {})).find((row: any) => row.id === original.id)
      expect(inactive).toMatchObject({ ...original, sessionId, status: 'inactive', lastDelivery: {
        messageId: saved.records[0].messageId, scheduledAt: original.scheduledAt,
      } })
      expect((await read()).map((row: any) => row.id).sort()).toEqual(records.filter(row => row.kind !== 'after').map(row => row.id).sort())
      return { records: await read(), delivery: saved.records[0], ...await verifyReply(deliveryToken),
        exactlyOneRealScheduledMessage: true, originalHistoryRetained: true }
    },
    async cleanup() {
      const own = (await rpc('schedule/catalog', {})).filter((row: any) => row.sessionId === sessionId)
      expect(own.every((row: any) => row.title.startsWith(marker))).toBe(true)
      for (const row of own) expect(await rpc('schedule/delete', { request: { sessionId, id: row.id } }))
        .toEqual({ id: row.id, deleted: true })
      expect(await read()).toEqual([])
      expect((await rpc('schedule/catalog', {})).some((row: any) => row.sessionId === sessionId)).toBe(false)
      return { removed: own.length, noTestScheduleRemaining: true }
    },
  }
}
