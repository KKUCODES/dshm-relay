import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'

/** 核对手机停止的是实际子会话的只读工具轮；父会话允许收到官方结算通知。 */
export function officialChildStopChecks({ readChild, readParent, profilePath }: {
  readChild: () => Promise<{ snapshot: any; records: any[] }>;
  readParent: () => Promise<{ records: any[] }>; profilePath: string
}) {
  let before: any[] | undefined, parent: any[] | undefined, profile: string | undefined
  const hash = async () => createHash('sha256').update(await readFile(profilePath)).digest('hex')
  const rows = (records: any[], seq: number) => records.filter(row => row.event.seq > seq)
  const call = (records: any[], initialSeq: number, command: string) => {
    const calls = rows(records, initialSeq).filter(row => row.event.type === 'tool/call')
    expect(calls).toHaveLength(1)
    expect(calls[0].event.data.name).toBe('pwsh')
    const args = JSON.parse(calls[0].event.data.arguments)
    expect(args.command).toBe(command); expect(args.run_in_background).toBe(false)
    return calls[0].event.data.callId
  }
  return {
    async prepare() {
      const child = await readChild()
      // 官方委派保留read-only沙箱，并固定never审批；组合显示为custom。
      expect(child.snapshot.values.permissions.currentValue).toBe('custom')
      const sandbox = child.records.filter(row => row.event.type === 'sandbox/mode').at(-1)
      const approval = child.records.filter(row => row.event.type === 'approval/policy').at(-1)
      expect(sandbox.event.data).toEqual({ mode: 'read-only', source: 'delegation' })
      expect(approval.event.data).toEqual({ policy: 'never', source: 'delegation' })
      before = child.records; parent = (await readParent()).records; profile = await hash()
      return { initialSeq: child.snapshot.asOfSeq, originalRecords: before!.length,
        permissions: { currentValue: 'custom', sandbox: 'read-only', approval: 'never', delegationRecorded: true } }
    },
    async started(initialSeq: number, command: string) {
      let callId: string | undefined
      await expect.poll(async () => {
        const child = await readChild(), active = rows(child.records, initialSeq)
        if (!active.some(row => row.event.type === 'tool/call')) return false
        callId = call(child.records, initialSeq, command)
        expect(active.some(row => row.event.type === 'tool/result'
          && row.event.data.message.toolCallId === callId)).toBe(false)
        return true
      }, { timeout: 60000 }).toBe(true)
      return { callId, officialChildToolRunning: true }
    },
    async settled(initialSeq: number, command: string, endMarker: string, reply: string) {
      await expect.poll(async () => rows((await readChild()).records, initialSeq)
        .filter(row => row.event.type === 'turn/end').length, { timeout: 30000 }).toBe(1)
      const child = await readChild(), active = rows(child.records, initialSeq)
      const callId = call(child.records, initialSeq, command)
      const result = active.filter(row => row.event.type === 'tool/result'
        && row.event.data.message.toolCallId === callId)
      expect(result).toHaveLength(1); expect(result[0].event.data.message.isError).toBe(true)
      const output = JSON.stringify(result[0].event.data.message.content)
      expect(output).not.toContain(endMarker)
      const end = active.find(row => row.event.type === 'turn/end')
      expect(end.event.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
      expect(active.filter(row => row.event.type === 'assistant/message').some(row =>
        JSON.stringify(row.event.data.message.content).includes(reply))).toBe(false)
      expect(child.records.slice(0, before!.length)).toEqual(before)
      expect((await readParent()).records.slice(0, parent!.length)).toEqual(parent)
      expect(await hash()).toBe(profile)
      return { callId, resultSeq: result[0].event.seq, reason: end.event.data.reason,
        originalChildHistoryUnchanged: true, parentHistoryPrefixUnchanged: true, profileUnchanged: true,
        onlyReadOnlyCommand: true, noDuplicateCallOrResult: true, noCompletionOrRetry: true }
    },
  }
}
