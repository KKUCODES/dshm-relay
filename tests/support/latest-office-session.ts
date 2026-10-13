import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect } from 'vitest'

type Rpc = (method: string, args: unknown) => Promise<any>

/** 全部会话、工作区和消息由原电脑接口创建；不伪造手机列表或附件归属。 */
export function latestOfficeSession(rpc: Rpc, home: string, sessionId: string, workspaceId: string,
  workspacePath: string, source: Uint8Array, differentSource: Uint8Array,
  attachment: { attachmentId: string; name: string; bytes: number }, texts: { source: string; different: string }) {
  let prepared: any
  const fileName = 'latest-session-office.docx'
  const otherPath = resolve(home, 'office-session-project')
  const stat = (id: string) => rpc('workspaceFiles/stat', { workspaceFileScopeId: id, path: fileName })
  const create = async (id: string, workspaceId: string, title: string) => {
    expect(await rpc('session/create', { request: { workspaceId, sessionId: id } })).toMatchObject({ sessionId: id })
    await rpc('session/rename', { request: { sessionId: id, title } })
    // 真实消息让原 Recent 列表展示该会话；无 Key 的失败不计为模型推理。
    expect(await rpc('session/prompt', { request: { sessionId: id, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: 'DSHM Office session ownership check: ' + title }] } }))
      .toMatchObject({ accepted: true })
    await expect.poll(async () => (await rpc('session/list', { _request: {} })).items
      .find((item: { sessionId: string }) => item.sessionId === id)?.running).toBe(false)
  }
  return { async verify(phase: 'office-session-prepare' | 'office-session-finish') {
    if (phase === 'office-session-prepare') {
      expect(prepared).toBeUndefined()
      expect(Buffer.from(source)).not.toEqual(Buffer.from(differentSource))
      await writeFile(resolve(workspacePath, fileName), source)
      await mkdir(otherPath)
      await writeFile(resolve(otherPath, fileName), differentSource)
      const registered = await rpc('workspace/create', { request: { path: otherPath } })
      const sameId = 'latest-office-same-' + randomUUID(), otherId = 'latest-office-other-' + randomUUID()
      await create(sameId, workspaceId, 'Latest Office same workspace')
      await create(otherId, registered.workspace.workspaceId, 'Latest Office other workspace')
      const original = await stat(sessionId), same = await stat(sameId), other = await stat(otherId)
      expect(same).toEqual(original)
      expect(other.absolutePath).toBe(resolve(otherPath, fileName))
      expect(other.absolutePath).not.toBe(original.absolutePath)
      expect(other.version).not.toBe(original.version)
      const sessions = [{ sessionId, title: 'Latest Remote isolated test', metadata: original, text: texts.source },
        { sessionId: sameId, title: 'Latest Office same workspace', metadata: same, text: texts.source },
        { sessionId: otherId, title: 'Latest Office other workspace', metadata: other, text: texts.different }]
      const list = (await rpc('session/list', { _request: {} })).items
      for (const session of sessions) expect(list.find((item: { sessionId: string }) => item.sessionId === session.sessionId))
        .toMatchObject({ blank: false, projections: { values: { title: session.title } } })
      prepared = { fileName, sessions, attachment, generation: await rpc('officeToPdf/generation', {}) }
      return prepared
    }
    expect(phase).toBe('office-session-finish'); expect(prepared).toBeDefined()
    expect(await readFile(resolve(workspacePath, fileName))).toEqual(Buffer.from(source))
    expect(await readFile(resolve(otherPath, fileName))).toEqual(Buffer.from(differentSource))
    for (const session of prepared.sessions) expect(await stat(session.sessionId)).toEqual(session.metadata)
    expect(await rpc('officeToPdf/generation', {})).toBe(prepared.generation)
    return { sourceAndServiceUnchanged: true, sessions: prepared.sessions }
  } }
}
