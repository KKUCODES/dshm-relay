import { expect } from 'vitest'

/** 另读官方状态与日志核对手机目标操作；失败收尾仅清除本轮专用会话的目标。 */
export function officialGoalChecks({ rpc, readSession, verifyReply, sessionId, marker }: {
  rpc: (method: string, args: unknown) => Promise<any>
  readSession: () => Promise<any>
  verifyReply: (marker: string) => Promise<any>
  sessionId: string
  marker: string
}) {
  const read = () => rpc('goals/get', { agentId: sessionId })
  const ref = (goal: any) => ({ id: goal.id, revision: goal.revision })
  return {
    marker, sessionId, read, history: readSession,
    async initial() {
      await rpc('commands/execute', { agentId: sessionId,
        line: '/permission read-only', submittedAttachments: [] })
      expect((await readSession()).snapshot.values.permissions.currentValue).toBe('read-only')
      expect(await read()).toBeUndefined()
      expect((await readSession()).snapshot.values.goal ?? null).toBeNull()
    },
    async verify(phone: any) {
      const goal = await read(), current = await readSession()
      expect(goal).toEqual(phone)
      expect(goal.objective).toContain(marker)
      const { activation, ...durable } = goal
      const { goal: identity, ...projection } = current.snapshot.values.goal
      expect({ ...identity, ...projection }).toEqual(durable)
      expect(['armed', 'disarmed']).toContain(activation)
      expect(current.snapshot.values.permissions.currentValue).toBe('read-only')
      return { officialStateAndProjectionVerified: true, goal }
    },
    async editOnComputer(objective: string) {
      const goal = await read()
      expect(goal.phase).toBe('paused')
      expect(objective).toContain(marker)
      return rpc('goals/edit', { agentId: sessionId, ref: ref(goal), request: { objective } })
    },
    async settled() {
      await expect.poll(async () => (await rpc('session/list', { _request: {} })).items
        .find((item: any) => item.sessionId === sessionId)?.running, { timeout: 180000 }).toBe(false)
      return readSession()
    },
    async verifyRound(before: any, objective: string, token: string) {
      await expect.poll(async () => (await read())?.phase, { timeout: 180000 }).toBe('blocked')
      const current = await readSession(), goal = await read()
      expect(current.records.slice(0, before.records.length)).toEqual(before.records)
      const added = current.records.filter((row: any) => row.event.seq > before.snapshot.asOfSeq)
      const rounds = added.filter((row: any) => row.event.type === 'user/message' && row.event.data.source.kind === 'goal'
        && row.event.data.source.round > 0)
      expect(rounds).toHaveLength(1)
      expect(rounds[0].event.data.source).toMatchObject({ goalId: goal.id, round: goal.maxGoalRounds })
      expect(JSON.stringify(rounds[0].event.data.content)).toContain(objective)
      expect(added.filter((row: any) => row.event.type === 'tool/call')).toHaveLength(0)
      expect(goal).toMatchObject({ objective, activation: 'disarmed', roundsStarted: goal.maxGoalRounds,
        blockedReason: { code: 'round-limit' } })
      return { ...await verifyReply(token), goal, automaticSource: rounds[0].event.data.source,
        originalPrefixRetained: true, exactlyOneAutomaticRound: true }
    },
    async cleared(before: any) {
      expect(await read()).toBeUndefined()
      const current = await readSession()
      expect(current.snapshot.values.goal).toBeNull()
      expect(current.records.slice(0, before.records.length)).toEqual(before.records)
      const added = current.records.slice(before.records.length)
      expect(added.filter((row: any) => row.event.type === 'goal/change')).toHaveLength(1)
      expect(added.filter((row: any) => ['assistant/message', 'tool/call', 'tool/result'].includes(row.event.type))).toHaveLength(0)
      return { goalCleared: true, originalHistoryRetained: true }
    },
    async cleanup() {
      let goal = await read()
      if (!goal) return { noGoalRemaining: true }
      expect(goal.objective).toContain(marker)
      if (goal.phase === 'active') goal = await rpc('goals/pause', { agentId: sessionId, ref: ref(goal) })
      await rpc('goals/clear', { agentId: sessionId, ref: ref(goal) })
      expect(await read()).toBeUndefined()
      return { testGoalRemoved: true }
    },
  }
}
