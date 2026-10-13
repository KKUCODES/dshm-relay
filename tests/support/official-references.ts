import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect } from 'vitest'

type Rpc = (method: string, args: unknown) => Promise<any>
const text = (parts: any[]) => parts.filter(part => part.type === 'text').map(part => part.text).join('\n')

/** 真实来源聊天和文件；答案只存在来源中，不放入目标消息。 */
export async function officialReferenceChecks({ rpc, readSession, sessionId, workspaceId, workspacePath,
  provider, model, run, sessions, fixtures, profilePath }: {
  rpc: Rpc; readSession: () => Promise<any>; sessionId: string; workspaceId: string; workspacePath: string;
  provider: string; model: string; run: string; sessions: Set<string>; fixtures: Map<string, Buffer>; profilePath: string
}) {
  const directory = resolve(workspacePath, '引用资料')
  await mkdir(directory)
  const sourceHistory = async (id: string) => {
    const snapshot = await rpc('session/projections', { request: { sessionId: id } })
    return rpc('session/page', { request: { address: { kind: 'session', sessionId: id },
      throughSeq: snapshot.asOfSeq, maxMessages: 60 } })
  }
  const targets: Record<string, any> = {}
  for (const mode of ['at', 'menu']) {
    const fileName = mode + ' reference.txt', path = resolve(directory, fileName)
    const fileMarker = 'FILE_' + randomUUID().replaceAll('-', ''), chatMarker = 'CHAT_' + randomUUID().replaceAll('-', '')
    const bytes = Buffer.from(fileMarker + '\n')
    await writeFile(path, bytes, { flag: 'wx' }); fixtures.set(path, bytes)
    const source = await rpc('session/create', { request: { workspaceId } }); sessions.add(source.sessionId)
    const title = 'DSHM_REF_' + mode.toUpperCase() + '_' + run.slice(0, 8)
    await rpc('session/rename', { request: { sessionId: source.sessionId, title } })
    await rpc('session/selectModel', { request: { sessionId: source.sessionId, provider, model } })
    await rpc('session/prompt', { request: { sessionId: source.sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: `这是引用资料。验收标记为 ${chatMarker}。请只回复 READY，不调用工具。` }] } })
    await expect.poll(async () => (await sourceHistory(source.sessionId)).records.some((row: any) =>
      row.event.type === 'turn/end'), { timeout: 180000 }).toBe(true)
    const original = (await sourceHistory(source.sessionId)).records
    const reply = original.filter((row: any) => row.event.type === 'assistant/message'
      && text(row.event.data.message.content).trim() === 'READY')
    expect(reply).toHaveLength(1); expect(reply[0].event.data.message.source.provider).toBe(provider)
    expect(original.filter((row: any) => row.event.type === 'tool/call')).toHaveLength(0)
    const candidates = await rpc('sessionReferenceResolver/candidates', { agentId: sessionId, query: title })
    const candidate = candidates.find((item: any) => item.sessionId === source.sessionId)
    expect(candidate).toMatchObject({ sessionId: source.sessionId, sameWorkspace: true })
    const files = await rpc('fileReferences/list', { agentId: sessionId, query: '引用资料/' + fileName })
    const file = files.find((item: any) => item.kind === 'file' && resolve(workspacePath, item.path) === path)
    expect(file, JSON.stringify({ path, files })).toBeDefined()
    targets[mode] = { fileName, path, relativePath: file.path, title, sourceId: source.sessionId,
      mention: candidate.mention, fileMarker, chatMarker, original }
  }
  let baseline: any, profile: Buffer
  return {
    targets: Object.fromEntries(Object.entries(targets).map(([mode, target]) => [mode, {
      fileName: target.fileName, relativePath: target.relativePath, title: target.title,
      sourceId: target.sourceId, mention: target.mention, fileMarker: target.fileMarker, chatMarker: target.chatMarker,
    }])),
    async before() {
      baseline = await readSession(); profile = await readFile(profilePath)
      return baseline.snapshot.asOfSeq
    },
    async unsubmitted() {
      expect((await readSession()).records).toEqual(baseline.records)
      return { noImplicitMessageOrTool: true }
    },
    async verify(mode: string, draft: string) {
      const target = targets[mode]; expect(target).toBeDefined()
      const expected = target.fileMarker + '\n' + target.chatMarker
      await expect.poll(async () => (await readSession()).records.some((row: any) =>
        row.event.seq > baseline.snapshot.asOfSeq && row.event.type === 'assistant/message'
        && text(row.event.data.message.content).trim() === expected), { timeout: 180000 }).toBe(true)
      await expect.poll(async () => (await rpc('session/list', { _request: {} })).items
        .find((item: any) => item.sessionId === sessionId)?.running, { timeout: 30000 }).toBe(false)
      const current = await readSession(), added = current.records.filter((row: any) => row.event.seq > baseline.snapshot.asOfSeq)
      const users = added.filter((row: any) => row.event.type === 'user/message' && row.event.data.source.kind === 'user')
      expect(users).toHaveLength(1)
      // 官方解析聊天引用后从直接消息中去掉mention，原引用身份记录在recall中。
      expect(text(users[0].event.data.content)).toContain(target.relativePath)
      expect(draft).toContain(target.mention); expect(draft).not.toContain(target.fileMarker); expect(draft).not.toContain(target.chatMarker)
      const recalls = added.filter((row: any) => row.event.type === 'user/message' && row.event.data.source.kind === 'session-reference')
      expect(recalls).toHaveLength(1)
      expect(recalls[0].event.data.source).toMatchObject({ kind: 'session-reference', form: 'recall',
        references: [{ sessionId: target.sourceId, capturedThroughSeq: target.original.at(-1).event.seq }] })
      expect(text(recalls[0].event.data.content)).toContain(target.chatMarker)
      const calls = added.filter((row: any) => row.event.type === 'tool/call')
      expect(calls).toHaveLength(1); expect(calls[0].event.data.name).toBe('read')
      expect(resolve(workspacePath, JSON.parse(calls[0].event.data.arguments).file_path)).toBe(target.path)
      const results = added.filter((row: any) => row.event.type === 'tool/result'
        && row.event.data.message.toolCallId === calls[0].event.data.callId)
      expect(results).toHaveLength(1); expect(results[0].event.data.message.isError).not.toBe(true)
      expect(JSON.stringify(results[0].event.data.message)).toContain(target.fileMarker)
      const answers = added.filter((row: any) => row.event.type === 'assistant/message'
        && text(row.event.data.message.content).trim() === expected)
      expect(answers).toHaveLength(1); expect(answers[0].event.data.message.source.provider).toBe(provider)
      expect(added.filter((row: any) => row.event.type === 'turn/end')).toHaveLength(1)
      expect(added.find((row: any) => row.event.type === 'turn/end').event.data.reason.kind).toBe('completed')
      expect(current.records.slice(0, baseline.records.length)).toEqual(baseline.records)
      expect((await sourceHistory(target.sourceId)).records).toEqual(target.original)
      expect(await readFile(target.path)).toEqual(fixtures.get(target.path))
      expect(await readFile(profilePath)).toEqual(profile)
      return { sourceId: target.sourceId, path: target.path, userSeq: users[0].event.seq,
        recallSeq: recalls[0].event.seq, resultSeq: results[0].event.seq, replySeq: answers[0].event.seq,
        genuineSourceSnapshot: true, uniqueReadAndReply: true, noAnswerInTargetPrompt: true,
        originalHistoryPrefixUnchanged: true, sourceHistoryAndFileUnchanged: true, profileUnchanged: true }
    },
  }
}
