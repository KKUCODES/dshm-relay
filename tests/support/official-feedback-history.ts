import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'
import type { officialFeedbackCollector } from './official-feedback.js'

/** 真实公开历史与反馈；重启只走正常CLI，冷写不激活Agent，分支保留官方归属。 */
export function officialFeedbackHistoryChecks({ run, sessionId, workspacePath, rpc, readSession, profilePath,
  collector, archiveState, adoptFork, stopHost, startHost }: {
  run: string; sessionId: string; workspacePath: string; profilePath: string
  rpc: (method: string, args: unknown) => Promise<any>; readSession: () => Promise<any>
  collector: Awaited<ReturnType<typeof officialFeedbackCollector>>
  archiveState: () => Promise<any>; adoptFork: (id: string) => void
  stopHost: () => Promise<any>; startHost: () => Promise<any>
}) {
  const note = 'DSHM_FEEDBACK_HISTORY_' + run.replaceAll('-', '')
  let initial: any, profile: Buffer, messageId: string, inherited: any, positive: any, childId: string | undefined, childInitial: any
  const phases: any[] = [], restarts: any[] = []
  const read = async (id: string) => {
    if (id === sessionId) return readSession()
    const snapshot = await rpc('session/projections', { request: { sessionId: id } })
    const history = await rpc('session/page', { request: { address: { kind: 'session', sessionId: id }, throughSeq: snapshot.asOfSeq, maxMessages: 100 } })
    return { snapshot, records: history.records }
  }
  const feedback = (state: any, id: string) => state.records.map((row: any) => row.event)
    .filter((event: any) => event.type.startsWith('feedback/') && event.data.sessionId === id)
  const list = async (id: string) => {
    const result = await rpc('messageFeedback/list', { request: { sessionId: id } })
    expect(result.ok).toBe(true); return result.value.items
  }
  const roster = async (id: string) => {
    const row = (await rpc('session/list', { _request: {} })).items.find((item: any) => item.sessionId === id)
    expect(row).toBeTruthy(); expect(row.running).toBe(false); return row
  }
  const unchanged = async (id: string, baseline: any, allowRestore: boolean) => {
    const current = await read(id), old = baseline.records.filter((row: any) => !row.event.type.startsWith('feedback/'))
    const other = current.records.filter((row: any) => !row.event.type.startsWith('feedback/'))
    expect(other.slice(0, old.length)).toEqual(old)
    const suffix = other.slice(old.length)
    expect(suffix.every((row: any) => row.event.type === 'session/end-seed')).toBe(true)
    expect(suffix.length).toBeLessThanOrEqual(allowRestore ? 1 : 0)
    expect(current.snapshot.values.modelSelection).toEqual(baseline.snapshot.values.modelSelection)
    expect(current.snapshot.values.permissions).toEqual(baseline.snapshot.values.permissions)
    expect(await readFile(profilePath)).toEqual(profile); await roster(id)
    return { current, originalMessagesUnchanged: true, profileUnchanged: true, modelAndPermissionsUnchanged: true,
      noModelWork: true, officialRestoreMarkers: suffix.length }
  }
  const verify = async (phase: string, rating: string | null, cold = false) => {
    const checked = await unchanged(sessionId, initial, !cold), items = await list(sessionId)
    expect(items.find((item: any) => item.messageId === inherited.messageId)).toEqual(inherited)
    const target = items.find((item: any) => item.messageId === messageId)
    expect(items.length).toBe(rating === null ? 1 : 2)
    if (rating === null) expect(target).toBeUndefined()
    else expect(target).toMatchObject({ messageId, rating })
    if (cold) expect((await roster(sessionId)).agentAvailable).toBe(false)
    const value = { phase, sessionId, rating, events: feedback(checked.current, sessionId),
      ...Object.fromEntries(Object.entries(checked).filter(([key]) => key !== 'current')),
      ...(cold ? { noAgentCreated: true } : {}), item: target }
    phases.push(value); return value
  }
  return {
    note, sessionId,
    async prepareInherited(marker: string) {
      const state = await readSession(), replies = state.records.filter((row: any) => row.event.type === 'assistant/message'
        && row.event.data.message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n').trim() === marker)
      expect(replies).toHaveLength(1)
      const result = await rpc('messageFeedback/put', { request: { sessionId, messageId: replies[0].event.data.message.id,
        rating: 'positive', note: note + '_INHERITED', category: 'task-result', ifVersion: null } })
      expect(result.ok).toBe(true); inherited = result.value
      return { messageId: inherited.messageId, version: inherited.version, actualFirstReplyFeedback: true }
    },
    async initial(marker: string) {
      initial = await readSession(); profile = await readFile(profilePath)
      const replies = initial.records.filter((row: any) => row.event.type === 'assistant/message'
        && row.event.data.message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n').trim() === marker)
      expect(replies).toHaveLength(1); messageId = replies[0].event.data.message.id
      expect(messageId).not.toBe(inherited.messageId); expect(await list(sessionId)).toEqual([inherited])
      return { sessionId, messageId, inherited, originalFeedbackCount: feedback(initial, sessionId).length }
    },
    async phonePositive() {
      const value = await verify('phone-positive', 'positive'); positive = value.item
      expect(positive).toMatchObject({ note, category: 'task-result' })
      expect(value.events.map((event: any) => event.type)).toEqual(['feedback/message-put', 'feedback/message-put'])
      const received = await collector.verify(sessionId, value.events)
      return { ...value, received }
    },
    async archived() {
      expect((await archiveState()).archivedSessionIds).toContain(sessionId)
      return verify('phone-archived', 'positive')
    },
    async stop() { const value = await stopHost(); restarts.push({ stopped: value }); return value },
    async start() { const value = await startHost(); restarts.at(-1).started = value; return value },
    async coldNegative() {
      expect((await roster(sessionId)).agentAvailable).toBe(false)
      await verify('cold-restored-original-positive', 'positive', true)
      const result = await rpc('messageFeedback/put', { request: { sessionId, messageId, rating: 'negative',
        note: note + '_COLD', category: 'other', ifVersion: positive.version } })
      expect(result.ok).toBe(true); expect(result.value.version).not.toBe(positive.version)
      const value = await verify('cold-desktop-negative', 'negative', true)
      expect(value.events).toHaveLength(3)
      return { ...value, received: await collector.verify(sessionId, value.events) }
    },
    opened: () => verify('phone-opened-archived-history', 'negative'),
    async phoneRetracted() {
      const value = await verify('phone-retracted-archived-history', null)
      expect(value.events).toHaveLength(4); expect(value.events.at(-1).type).toBe('feedback/message-delete'); return value
    },
    async restoredPositive() {
      expect((await archiveState()).archivedSessionIds).not.toContain(sessionId)
      const value = await verify('phone-restored-parent-positive', 'positive')
      expect(value.item.note).toBe(note + '_RESTORED'); expect(value.events).toHaveLength(5); return value
    },
    async fork(id: string) {
      expect(id).not.toBe(sessionId)
      expect(await roster(id)).toMatchObject({ parentSessionId: sessionId, cwd: workspacePath })
      childId = id; adoptFork(id); childInitial = await read(id)
      const root = await readSession(), messages = (value: any) => value.records.filter((row: any) =>
        ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(row.event.type)).map((row: any) => row.event)
      expect(messages(childInitial)).toEqual(messages(root))
      const inheritedEvents = childInitial.records.filter((row: any) => row.event.type === 'feedback/message-put'
        && row.event.data.sessionId === sessionId && row.event.data.item.messageId === inherited.messageId)
      expect(inheritedEvents).toHaveLength(1); expect(inheritedEvents[0].event.data.item).toEqual(inherited)
      expect(await list(id)).toEqual([])
      return { childId: id, parentId: sessionId, inheritedMessagesMatched: true, actualInheritedFeedbackIgnored: true,
        inheritedFeedbackSeq: inheritedEvents[0].event.seq, inheritedFeedbackMessageId: inherited.messageId, childInitiallyUnrated: true }
    },
    async childNegative() {
      const checked = await unchanged(childId!, childInitial, false), items = await list(childId!)
      expect(items).toHaveLength(1); expect(items[0]).toMatchObject({ messageId, rating: 'negative', note: note + '_FORK', category: 'other' })
      expect((await list(sessionId)).find((item: any) => item.messageId === messageId)?.rating).toBe('positive')
      return { sessionId: childId, item: items[0], events: feedback(checked.current, childId!), parentPositiveUnchanged: true,
        ...Object.fromEntries(Object.entries(checked).filter(([key]) => key !== 'current')) }
    },
    async parentDeleted() {
      const items = await list(sessionId), target = items.find((item: any) => item.messageId === messageId)
      expect(target).toBeTruthy()
      expect(await rpc('messageFeedback/delete', { request: { sessionId, messageId, ifVersion: target.version } }))
        .toEqual({ ok: true, value: { absent: true } })
      const value = await verify('desktop-parent-deleted-child-independent', null)
      expect(value.events).toHaveLength(6)
      const child = await unchanged(childId!, childInitial, false)
      expect(await list(childId!)).toHaveLength(1)
      // 评价落盘与异步日志送达是两件事；本专项先核对实际送达，再测试重启后的状态。
      return { ...value, received: await collector.verify(sessionId, value.events),
        childReceived: await collector.verify(childId!, feedback(child.current, childId!)),
        childFeedbackUnchanged: true, childMessagesUnchanged: child.originalMessagesUnchanged }
    },
    async childRecovered() {
      const value = await unchanged(childId!, childInitial, true), items = await list(childId!)
      expect(items).toHaveLength(1); expect(items[0].rating).toBe('negative')
      expect(feedback(value.current, childId!)).toHaveLength(1)
      await verify('second-host-restart-parent-still-unrated', null)
      return { sessionId: childId, item: items[0], events: feedback(value.current, childId!),
        ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'current')) }
    },
    async childRetracted() {
      const value = await unchanged(childId!, childInitial, true); expect(await list(childId!)).toEqual([])
      const events = feedback(value.current, childId!); expect(events).toHaveLength(2)
      expect(events.map((event: any) => event.type)).toEqual(['feedback/message-put', 'feedback/message-delete'])
      const parent = await verify('final-parent-and-child-independent', null)
      return { sessionId: childId, events, parentEvents: parent.events, restarts,
        parentReceived: await collector.verify(sessionId, parent.events), childReceived: await collector.verify(childId!, events),
        ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'current')), childUnrated: true,
        parentInheritedRatingUnchanged: true, phases }
    },
    async cleanup() {
      for (const id of [sessionId, ...(childId ? [childId] : [])])
        await rpc('workspace/unarchiveSession', { request: { sessionId: id } })
      return { ownedSessionsUnarchivedForCleanup: true, childId }
    },
  }
}
