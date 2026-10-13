import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { readFile, writeFile } from 'node:fs/promises'
import { expect } from 'vitest'

/** 官方OTLP实际出口，仅保存会话/事件类型/序号，不保存或转发日志正文与身份。 */
export async function officialFeedbackCollector(path: string) {
  const report = { endpoint: '', requests: 0, rejected: 0, events: [] as { sessionId: string; seq: number; type: string }[], closed: false }
  const save = () => writeFile(path, JSON.stringify(report, null, 2) + '\n')
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/logs') { response.writeHead(404).end(); return }
    try {
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of request) {
        size += chunk.length; assert.ok(size <= 4 * 1024 * 1024); chunks.push(chunk)
      }
      const bytes = Buffer.concat(chunks)
      const raw = request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }) : bytes
      const capture = JSON.parse(raw.toString())
      const events = capture.resourceLogs.flatMap((resource: any) => resource.scopeLogs.flatMap((scope: any) => scope.logRecords.map((record: any) => {
        assert.equal(record.eventName, 'session-log')
        const value = (key: string) => record.attributes.find((item: any) => item.key === key)?.value
        const event = { sessionId: value('session.id')?.stringValue, seq: Number(value('event.seq')?.intValue), type: value('event.type')?.stringValue }
        assert.equal(typeof event.sessionId, 'string'); assert.equal(typeof event.type, 'string'); assert.ok(Number.isSafeInteger(event.seq))
        return event
      })))
      report.events.push(...events); report.requests++; await save()
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    } catch { report.rejected++; await save(); response.writeHead(400).end('{}') }
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  report.endpoint = `http://127.0.0.1:${address.port}/v1/logs`; await save()
  return {
    endpoint: report.endpoint,
    snapshot: () => structuredClone(report),
    async verify(sessionId: string, events: any[]) {
      const wanted = events.filter(event => event.type.startsWith('feedback/')).map(({ seq, type }) => ({ sessionId, seq, type }))
      await expect.poll(() => wanted.every(event => report.events.some(actual => actual.sessionId === event.sessionId
        && actual.seq === event.seq && actual.type === event.type)), { timeout: 25000 }).toBe(true)
      expect(report.rejected).toBe(0)
      return { endpoint: report.endpoint, feedbackEventsReceived: wanted, actualOtlpRequests: report.requests, bodyDiscarded: true }
    },
    async close() { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); report.closed = true; await save(); return structuredClone(report) },
  }
}

/** 独立官方HTTP读写与原日志核对；不替换手机反馈生产请求或模型。 */
export function officialFeedbackChecks({ run, sessionId, rpc, readSession, profilePath, collector }: {
  run: string; sessionId: string; rpc: (method: string, args: unknown) => Promise<any>
  readSession: () => Promise<any>; profilePath: string; collector: Awaited<ReturnType<typeof officialFeedbackCollector>>
}) {
  const note = 'DSHM_LOCAL_FEEDBACK_' + run.replaceAll('-', '')
  let baseline: any, profile: Buffer, messageId: string, previousVersion: string
  const expected: string[] = [], phases: any[] = []
  const list = async () => {
    const result = await rpc('messageFeedback/list', { request: { sessionId } })
    expect(result.ok).toBe(true); return result.value.items
  }
  const verify = async (phase: string, rating: string | null, type?: string) => {
    if (type) expected.push(type)
    const current = await readSession(), rows = current.records.map((row: any) => row.event)
    const feedback = rows.filter((event: any) => event.type.startsWith('feedback/'))
    expect(feedback.map((event: any) => event.type)).toEqual(expected)
    expect(current.records.filter((row: any) => !row.event.type.startsWith('feedback/'))).toEqual(baseline.records)
    expect(current.snapshot.values.modelSelection).toEqual(baseline.snapshot.values.modelSelection)
    expect(current.snapshot.values.permissions).toEqual(baseline.snapshot.values.permissions)
    expect(await readFile(profilePath)).toEqual(profile)
    const items = await list()
    if (rating === null) expect(items).toEqual([])
    else { expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ messageId, rating }) }
    const evidence = { phase, rating, events: feedback.map(({ seq, type, data }: any) => ({ seq, type, data })),
      originalMessagesUnchanged: true, profileUnchanged: true, modelAndPermissionsUnchanged: true, noModelWork: true }
    phases.push(evidence); return { ...evidence, item: items[0] }
  }
  return {
    note, sessionId,
    async initial(marker: string) {
      baseline = await readSession(); profile = await readFile(profilePath)
      const replies = baseline.records.filter((row: any) => row.event.type === 'assistant/message'
        && row.event.data.message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n').trim() === marker)
      expect(replies).toHaveLength(1); messageId = replies[0].event.data.message.id
      expect(typeof messageId).toBe('string'); expect(messageId.length).toBeGreaterThan(0)
      expect(await list()).toEqual([]); expect(collector.snapshot().events.filter(event => event.sessionId === sessionId)).toEqual([])
      return { sessionId, messageId, emptyInitialRating: true, noTelemetryBeforeFeedback: true }
    },
    async phonePositive() {
      const value = await verify('phone-positive', 'positive', 'feedback/message-put')
      expect(value.item).toMatchObject({ note, category: 'task-result' }); previousVersion = value.item.version; return value
    },
    async desktopNegative() {
      const result = await rpc('messageFeedback/put', { request: { sessionId, messageId, rating: 'negative',
        note: note + '_DESKTOP', category: 'other', ifVersion: previousVersion } })
      expect(result.ok).toBe(true); expect(result.value.version).not.toBe(previousVersion)
      return verify('desktop-negative', 'negative', 'feedback/message-put')
    },
    async staleVersion() {
      const result = await rpc('messageFeedback/put', { request: { sessionId, messageId, rating: 'positive', ifVersion: previousVersion } })
      expect(result).toMatchObject({ ok: false, error: { code: 'version-conflict' } })
      await verify('stale-version-refused', 'negative'); return { versionConflict: true, noAddedEvent: true }
    },
    phoneRetracted: () => verify('phone-retracted', null, 'feedback/message-delete'),
    reconnected: () => verify('reconnected', 'positive'),
    async desktopPositive() {
      const result = await rpc('messageFeedback/put', { request: { sessionId, messageId, rating: 'positive', ifVersion: null } })
      expect(result.ok).toBe(true); return verify('desktop-positive', 'positive', 'feedback/message-put')
    },
    async desktopDelete() {
      const items = await list(); expect(items).toHaveLength(1)
      const result = await rpc('messageFeedback/delete', { request: { sessionId, messageId, ifVersion: items[0].version } })
      expect(result).toEqual({ ok: true, value: { absent: true } }); return verify('desktop-deleted', null, 'feedback/message-delete')
    },
    cancelled: () => verify('dialog-cancelled', null),
    async sessionRecorded() {
      await verify('session-recorded', null, 'feedback/record')
      const events = (await readSession()).records.map((row: any) => row.event)
      expect(events.filter((event: any) => event.type === 'feedback/record')).toHaveLength(1)
      expect(events.find((event: any) => event.type === 'feedback/record').data).toEqual({ text: note + '_SESSION', category: 'product-interaction' })
      return { phases, ...(await collector.verify(sessionId, events)), acknowledgementIsLoggedNotDurability: true }
    },
  }
}
