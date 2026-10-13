import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'
import type { officialPromptTransport } from './official-prompt-transport.js'

type File = { name: string; path: string; bytes: number; sha256: string; extension: string }

/** 原件从真实手机上传；仅核对官方签发的receipt、原会话消息和独立附件字节流。 */
export function officialAttachmentSendingChecks({ sessionId, files, rpc, readSession, verifyReply, profilePath,
  transport, request, receive, send, adoptSession, workspaceId, processExit = false, hostExit = false, stopHost, startHost }: {
  sessionId: string; files: File[]; profilePath: string; workspaceId: string
  rpc: (method: string, args: unknown) => Promise<any>; readSession: () => Promise<any>
  verifyReply: (marker: string) => Promise<any>; transport: Awaited<ReturnType<typeof officialPromptTransport>>
  request: (operation: unknown) => string; receive: (match: (frame: any) => boolean) => Promise<any>
  send: (frame: unknown) => void; adoptSession: (id: string) => void; processExit?: boolean; hostExit?: boolean
  stopHost?: () => Promise<any>; startHost?: () => Promise<any>
}) {
  expect(processExit && hostExit).toBe(false)
  if (hostExit) { expect(stopHost).toBeTypeOf('function'); expect(startHost).toBeTypeOf('function') }
  const phases: any[] = []
  let phase: 'before-forward' | 'after-receipt', baseline: any, original: any, profile: Buffer, cut: any, partial: any
  let checkpoint: any, recoveredRecords: any[] | undefined, originalRecovery: any
  const targets = Object.fromEntries(['before-forward', 'after-receipt'].map((key, index) => {
    const file = files[index]!
    return [key, { sessionId, fileCount: 1, file,
      text: (hostExit && key === 'after-receipt' ? '先在内部逐步核算123456789乘987654321，然后' : '')
        + `只读取本轮上传的 ${file.name} 的第一行，只回复第一行原文，不要读取其他附件，不修改文件。` }]
  })) as Record<'before-forward' | 'after-receipt', { sessionId: string; fileCount: number; file: File; text: string }>
  const followup = { sessionId, text: `这是一条独立的新消息，之前的任务已结束，不要继续或补答旧任务。只读取此前上传的 ${files[1]!.name} 的第一行，只回复第一行原文，不要读取其他附件，不修改文件。` }
  const source = async (name: string) => {
    const file = files.find(item => item.name === name); expect(file).toBeTruthy()
    const bytes = await readFile(file!.path); expect(bytes.length).toBe(file!.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file!.sha256); return bytes
  }
  const marker = async (file: File) => (await source(file.name)).toString('utf8').split('\n')[0]!
  const identity = (state: any) => ({ model: state.snapshot.values.modelSelection, permissions: state.snapshot.values.permissions })
  const unchanged = async (state: any) => {
    expect(await readFile(profilePath)).toEqual(profile); expect(identity(state)).toEqual(identity(original))
    expect(state.records.slice(0, original.records.length)).toEqual(original.records)
    if (baseline) expect(state.records.slice(0, baseline.records.length)).toEqual(baseline.records)
    if (checkpoint) expect(state.records.slice(0, checkpoint.records.length)).toEqual(checkpoint.records)
    if (recoveredRecords) expect(state.records.slice(0, recoveredRecords.length)).toEqual(recoveredRecords)
  }
  const users = (state: any, requestId: string) => state.records.filter((row: any) => row.event.type === 'user/message'
    && row.event.data.source?.kind === 'user' && row.event.data.source.rpcId === requestId)
  const running = async () => (await rpc('session/list', { _request: {} })).items.find((row: any) => row.sessionId === sessionId)?.running
  const storedFile = async (state: any, requestId: string, file: File) => {
    const sent = users(state, requestId); expect(sent).toHaveLength(1)
    const refs = sent[0].event.data.content.filter((part: any) => part.type === 'file').map((part: any) => part.attachment)
    expect(refs).toHaveLength(1); expect(refs[0]).toMatchObject({ name: file.name, bytes: file.bytes })
    const ref = refs[0], id = request({ method: 'remote.attachment', sessionId, kind: 'file', name: ref.name,
      attachmentId: ref.attachmentId }), parts: Buffer[] = []
    let metadata = false, offset = 0
    try {
      for (;;) {
        const frame = await receive(item => item.id === id)
        if (frame.type === 'end') break
        expect(frame.type).toBe('event')
        if (frame.value.type === 'metadata') { expect(metadata).toBe(false); expect(frame.value.attachment).toEqual(ref); metadata = true }
        else {
          expect(metadata).toBe(true); expect(frame.value).toMatchObject({ type: 'chunk', offset })
          const bytes = Buffer.from(frame.value.data, 'base64'); expect(bytes.toString('base64')).toBe(frame.value.data)
          expect(bytes.length).toBeGreaterThan(0); expect(bytes.length).toBeLessThanOrEqual(65536)
          parts.push(bytes); offset += bytes.length; send({ type: 'ack', id, count: 1 })
        }
      }
      expect(metadata).toBe(true); expect(offset).toBe(file.bytes); expect(Buffer.concat(parts)).toEqual(await source(file.name))
    } finally { send({ type: 'cancel', id }) }
    return { requestId, userSeq: sent[0].event.seq, attachment: ref, originalBytesVerified: true, chunks: parts.length }
  }
  const settled = async (requestId: string, file: File) => {
    const token = await marker(file)
    await expect.poll(async () => (await readSession()).records.some((row: any) => row.event.type === 'assistant/message'
      && row.event.data.message.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n').trim() === token),
    { timeout: 180000 }).toBe(true)
    await expect.poll(async () => (await rpc('session/list', { _request: {} })).items
      .find((row: any) => row.sessionId === sessionId)?.running, { timeout: 30000 }).toBe(false)
    const state = await readSession(); await unchanged(state)
    return { ...await storedFile(state, requestId, file), marker: token, reply: await verifyReply(token) }
  }
  return {
    sessionId, files, targets: { ...targets, followup }, source, processExit, hostExit,
    async armUpload() {
      original = await readSession(); profile = await readFile(profilePath)
      transport.armUpload({ sessionId, name: files[0]!.name }, processExit, hostExit); return { records: original.records.length }
    },
    uploadHeld() { return transport.uploadHeld() },
    async uploadCut() {
      partial = await transport.uploadCut(); expect(partial.forwardedBytes).toBe(65536)
      expect(partial.endForwarded).toBe(false); expect(partial.receipt).toBeUndefined()
      expect(partial.consumedCredit).toMatchObject({ type: 'event', id: partial.id, value: { type: 'credit', count: 1 } })
      expect(partial.chunks[0].sha256).toBe(createHash('sha256').update((await source(files[0]!.name)).subarray(0, 65536)).digest('hex'))
      const state = await readSession(); await unchanged(state); expect(state.records).toEqual(original.records)
      return partial
    },
    async uploadReconnected() {
      await new Promise(done => setTimeout(done, 2000))
      expect(transport.uploads({ sessionId, name: files[0]!.name })).toHaveLength(1)
      const state = await readSession(); await unchanged(state)
      if (hostExit) expect(state.records.slice(original.records.length).filter((row: any) =>
        ['user/message', 'assistant/message', 'turn/start'].includes(row.event.type))).toHaveLength(0)
      else expect(state.records).toEqual(original.records)
      return { noAutomaticUploadOrMessage: true }
    },
    async prepared(name: string, count: number) {
      const file = files.find(item => item.name === name)!; expect(file).toBeTruthy()
      await expect.poll(() => transport.uploads({ sessionId, name }).length, { timeout: 30000 }).toBe(count)
      await expect.poll(() => transport.uploads({ sessionId, name }).at(-1)?.receipt?.value?.ok, { timeout: 30000 }).toBe(true)
      const rows = transport.uploads({ sessionId, name }), row = rows.at(-1)!
      expect(row.endForwarded).toBe(true); expect(row.forwardedBytes).toBe(file.bytes); expect(row.sha256).toBe(file.sha256)
      expect(row.receipt.value.value).toMatchObject({ receiptId: expect.any(String), file: { name, bytes: file.bytes } })
      return { count, upload: row, realOfficialReceipt: true, originalBytesVerified: true }
    },
    async arm(next: 'before-forward' | 'after-receipt') {
      phase = next; checkpoint = undefined; recoveredRecords = undefined; originalRecovery = undefined
      baseline = await readSession(); await unchanged(baseline)
      transport.arm(targets[phase], phase, processExit, hostExit); return { sessionId, records: baseline.records.length }
    },
    held() { return transport.held() },
    async stop(upload = false) {
      expect(hostExit).toBe(true); checkpoint = await readSession(); await unchanged(checkpoint)
      const isRunning = await running(); expect(isRunning).toBe(!upload && phase === 'after-receipt')
      if (upload) {
        partial = await transport.uploadHeld(); expect(partial.forwardedBytes).toBe(65536)
        expect(partial.endForwarded).toBe(false); expect(partial.receipt).toBeUndefined()
        expect(partial.chunks[0].sha256).toBe(createHash('sha256').update((await source(files[0]!.name)).subarray(0, 65536)).digest('hex'))
        expect(partial.consumedCredit).toMatchObject({ type: 'event', id: partial.id, value: { type: 'credit', count: 1 } })
        expect(checkpoint.records).toEqual(original.records)
      } else {
        cut = await transport.held(); expect(cut.awaitingHostExit).toBe(true); expect(cut.request.mode).toBe('queue')
        const receipt = transport.uploads({ sessionId, name: targets[phase].file.name }).at(-1)!.receipt.value.value.receiptId
        expect(cut.request.content).toEqual([{ type: 'text', text: targets[phase].text }, { type: 'file', receiptId: receipt }])
        expect(users(checkpoint, cut.request.requestId)).toHaveLength(phase === 'before-forward' ? 0 : 1)
        if (phase === 'after-receipt') expect(checkpoint.records.filter((row: any) => row.event.type === 'turn/end'
          && row.event.seq > users(checkpoint, cut.request.requestId)[0].event.seq)).toHaveLength(0)
      }
      const stopped = await stopHost!(), disconnected = await (upload ? transport.uploadHostExited() : transport.hostExited())
      expect(disconnected.awaitingHostExit).toBe(true); expect(disconnected.hostDisconnectFrames.length).toBeGreaterThan(0)
      return { stopped, disconnected, originalRunningAtStop: isRunning, checkpointRecords: checkpoint.records,
        checkpointSha256: createHash('sha256').update(JSON.stringify(checkpoint.records)).digest('hex'), realHostDisconnectForwarded: true }
    },
    async start(upload = false) {
      expect(hostExit).toBe(true)
      if (upload) transport.resumeUploadHost(); else transport.resumeHost()
      return startHost!()
    },
    async disconnected() {
      cut = await transport.cut(); expect(cut.request.mode).toBe('queue')
      expect(cut.request.content).toEqual([{ type: 'text', text: targets[phase].text }, { type: 'file', receiptId: expect.any(String) }])
      expect(transport.writes(targets[phase])).toHaveLength(1)
      const upload = transport.uploads({ sessionId, name: targets[phase].file.name }).at(-1)!
      expect(cut.request.content[1].receiptId).toBe(upload.receipt.value.value.receiptId)
      if (phase === 'before-forward') {
        expect(cut.forwarded).toBe(false); expect((await readSession()).records).toEqual(baseline.records)
      } else expect(cut.receipt).toMatchObject({ type: 'result', id: cut.id, value: { ok: true, value: { accepted: true } } })
      return cut
    },
    resume() { transport.resume() },
    async reconnected() {
      await new Promise(done => setTimeout(done, 2000)); expect(transport.writes(targets[phase])).toHaveLength(1)
      if (phase === 'before-forward') {
        const state = await readSession(); await unchanged(state); expect(users(state, cut.request.requestId)).toHaveLength(0)
        return { noOriginalUserMessage: true, noAutomaticResend: true }
      }
      if (hostExit) {
        await expect.poll(running, { timeout: 30000 }).toBe(false)
        const state = await readSession(); await unchanged(state)
        const messages = users(state, cut.request.requestId); expect(messages).toHaveLength(1)
        const ends = state.records.slice(baseline.records.length).filter((row: any) => row.event.type === 'turn/end'
          && row.event.seq > messages[0].event.seq); expect(ends).toHaveLength(1)
        expect(['completed', 'interrupted']).toContain(ends[0].event.data.reason.kind)
        originalRecovery = { ...await storedFile(state, cut.request.requestId, targets[phase].file),
          endSeq: ends[0].event.seq, reason: ends[0].event.data.reason, originalSettledWithoutReplay: true, noAutomaticResend: true }
        recoveredRecords = state.records
        return originalRecovery
      }
      return { ...await settled(cut.request.requestId, targets[phase].file), noAutomaticResend: true }
    },
    async settled() {
      await expect.poll(() => transport.writes(targets[phase]).length, { timeout: 30000 }).toBe(phase === 'before-forward' ? 2 : 1)
      const writes = transport.writes(targets[phase]), write = writes.filter(row => row.forwarded).at(-1)!
      if (phase === 'before-forward') expect(write.request.requestId).not.toBe(cut.request.requestId)
      if (hostExit && phase === 'after-receipt') {
        await expect.poll(() => transport.writes(followup).length, { timeout: 30000 }).toBe(1)
        const next = transport.writes(followup)[0]!, token = await marker(targets[phase].file)
        expect(next.forwarded).toBe(true); expect(next.request.requestId).not.toBe(cut.request.requestId)
        await expect.poll(async () => (await readSession()).records.some((row: any) => row.event.type === 'assistant/message'
          && row.event.data.message.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n').trim() === token),
        { timeout: 180000 }).toBe(true)
        await expect.poll(running, { timeout: 30000 }).toBe(false)
        const state = await readSession(); await unchanged(state)
        expect(users(state, next.request.requestId)).toHaveLength(1)
        expect(users(state, next.request.requestId)[0].event.data.content).toEqual([{ type: 'text', text: followup.text }])
        const value = { phase, cut, writes, ...originalRecovery, marker: token, reply: await verifyReply(token),
          followup: { requestId: next.request.requestId, writes: transport.writes(followup), explicitNewRequest: true } }
        phases.push(value); return value
      }
      const value = { phase, cut, writes, ...await settled(write.request.requestId, targets[phase].file) }
      phases.push(value); return value
    },
    async final() {
      const state = await readSession(); await unchanged(state)
      expect(phases.map(item => item.phase)).toEqual(['before-forward', 'after-receipt'])
      expect(users(state, phases[0].cut.request.requestId)).toHaveLength(0)
      for (const item of phases) {
        expect(users(state, item.requestId)).toHaveLength(1); expect(transport.writes(targets[item.phase as keyof typeof targets])).toEqual(item.writes)
      }
      if (hostExit) expect(users(state, phases[1].followup.requestId)).toHaveLength(1)
      const other = await rpc('session/create', { request: { workspaceId } }); adoptSession(other.sessionId)
      for (const item of phases) {
        const id = request({ method: 'remote.attachment', sessionId: other.sessionId, kind: 'file', name: item.attachment.name,
          attachmentId: item.attachment.attachmentId })
        expect(await receive(frame => frame.id === id)).toMatchObject({ type: 'error', code: 'remote_attachment_not_referenced' })
      }
      return { phases, partial, history: state, noDuplicateOriginalMessages: true, originalFilesAndHistoryVerified: true,
        wrongSessionDenied: true, profileModelPermissionsUnchanged: true, passed: true }
    },
  }
}
