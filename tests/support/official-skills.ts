import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect } from 'vitest'

/** 自有工作区中的普通技能文件；官方目录、加载和模型路径均不替换。 */
export async function officialSkillFixture(workspace: string, run: string, files: Map<string, Buffer>) {
  // 官方 findProjectRoot 只检查 .git 存在；标记仅属于本轮自有目录，避免读取父仓库技能。
  await mkdir(resolve(workspace, '.git'), { recursive: true })
  const name = 'dshm-skill-' + run.slice(0, 8), hidden = 'dshm-hidden-' + run.slice(0, 8)
  const reply = 'DSHM_SKILL_BODY_' + run.replaceAll('-', '')
  const rows = [
    { name, description: 'DSHM 只读技能调用验收', flags: 'disable-model-invocation: true', body:
      `这是只读联调技能。请只回复 ${reply}，不调用工具，不读写文件，不联网，不提权。` },
    { name: hidden, description: 'DSHM 不开放手动调用的验收技能',
      flags: 'disable-model-invocation: true\nuser-invocable: false', body: '此技能不应从手机技能选择器调用。' },
    { name: 'permission', description: 'DSHM 与电脑命令同名的验收技能',
      flags: 'disable-model-invocation: true', body: '此技能不应从手机技能选择器调用。' },
  ]
  const written = []
  for (const row of rows) {
    const directory = resolve(workspace, '.dsh/skills', row.name), path = resolve(directory, 'SKILL.md')
    await mkdir(directory, { recursive: true })
    const content = Buffer.from(`---\nname: ${row.name}\ndescription: ${row.description}\n${row.flags}\n---\n\n${row.body}\n`)
    await writeFile(path, content, { flag: 'wx' }); files.set(path, content)
    written.push({ name: row.name, path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
  }
  const sourcePath = resolve(workspace, '.dsh/skills', name, 'SKILL.md')
  const collisionPath = resolve(workspace, '.dsh/skills/permission/SKILL.md')
  return { name, hidden, collision: 'permission', reply, files: written, sourcePath, collisionPath,
    sourceText: files.get(sourcePath)!.toString() }
}

export function officialSkillChecks({ rpc, readSession, profilePath, sessionId, provider, fixture }: {
  rpc: (method: string, args: unknown) => Promise<any>; readSession: () => Promise<{ snapshot: any; records: any[] }>;
  profilePath: string; sessionId: string; provider: string; fixture: Awaited<ReturnType<typeof officialSkillFixture>>
}) {
  let original: any[] | undefined, profile: string | undefined
  const hash = async () => createHash('sha256').update(await readFile(profilePath)).digest('hex')
  const catalog = () => rpc('skills/list', { request: { sessionId } })
  return {
    ...fixture,
    async prepare() {
      original = (await readSession()).records; profile = await hash()
      const view = await catalog(), chosen = view.skills.find((row: any) => row.name === fixture.name)
      expect(chosen).toMatchObject({ name: fixture.name, path: fixture.sourcePath, modelInvocable: false })
      expect(view.skills.some((row: any) => row.name === fixture.hidden)).toBe(false)
      expect(view.skills.find((row: any) => row.name === fixture.collision)?.path).toBe(fixture.collisionPath)
      const commands = await rpc('commands/list', { agentId: sessionId })
      expect(commands.some((row: any) => row.name === fixture.collision)).toBe(true)
      return { catalogMatchesOfficial: true, modelInvocationDisabled: true, hiddenExcluded: true, commandCollision: true }
    },
    async before() { return (await readSession()).snapshot.asOfSeq },
    async noInvocation(initialSeq: number) {
      expect((await readSession()).snapshot.asOfSeq).toBe(initialSeq)
      return { noMessageOrTurnAdded: true }
    },
    async verify(initialSeq: number, prompt: string) {
      const current = await readSession(), rows = current.records.filter((row: any) => row.event.seq > initialSeq)
      const users = rows.filter((row: any) => row.event.type === 'user/message' && row.event.data.source.kind === 'user')
      expect(users).toHaveLength(1)
      const text = (parts: any[]) => parts.filter(part => part.type === 'text').map(part => part.text).join('\n')
      expect(text(users[0].event.data.content)).toBe(prompt)
      expect(prompt).not.toContain(fixture.reply)
      const injections = rows.filter((row: any) => row.event.type === 'user/message'
        && row.event.data.source.kind === 'skill-invocation')
      expect(injections).toHaveLength(1)
      expect(injections[0].event.data.source).toMatchObject({ kind: 'skill-invocation', name: fixture.name, form: 'instructions' })
      expect(text(injections[0].event.data.content)).toContain(fixture.reply)
      expect(rows.filter((row: any) => row.event.type === 'tool/call' || row.event.type === 'command/run')).toHaveLength(0)
      const replies = rows.filter((row: any) => row.event.type === 'assistant/message'
        && text(row.event.data.message.content).trim() === fixture.reply)
      expect(replies).toHaveLength(1); expect(replies[0].event.data.message.source.provider).toBe(provider)
      const ends = rows.filter((row: any) => row.event.type === 'turn/end')
      expect(ends).toHaveLength(1); expect(ends[0].event.data.reason.kind).toBe('completed')
      expect(current.records.slice(0, original!.length)).toEqual(original)
      expect(await hash()).toBe(profile)
      return { skillName: fixture.name, userSeq: users[0].event.seq, injectionSeq: injections[0].event.seq,
        replySeq: replies[0].event.seq, officialBodyInjected: true, modelReplyFromSkillBody: true,
        noToolOrCommandExecuted: true, originalHistoryPrefixUnchanged: true, profileUnchanged: true }
    },
    async removed() {
      if (!original) return { initialized: false }
      await expect.poll(async () => (await catalog()).skills.some((row: any) =>
        [fixture.name, fixture.hidden].includes(row.name)), { timeout: 10000 }).toBe(false)
      expect((await catalog()).skills.some((row: any) => row.name === fixture.collision && row.path === fixture.collisionPath)).toBe(false)
      expect(await hash()).toBe(profile)
      return { initialized: true, ownSkillsRemoved: true, profileUnchanged: true }
    },
  }
}
