import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect } from 'vitest'

/** 独立官方 HTTP 导出与公开历史核对，不替换插件的生产流。 */
export async function officialSessionExportChecks({ run, sessionId, readSession, readChild, childId,
  profilePath, verifyReply, exportZip }: {
  run: string; sessionId: string; readSession: () => Promise<any>; readChild: () => Promise<any>
  childId: () => string; profilePath: string; verifyReply: (token: string) => Promise<unknown>
  exportZip: (includeDescendants: boolean) => Promise<Buffer>
}) {
  const marker = 'DSHM_SESSION_EXPORT_' + run.replaceAll('-', '')
  const name = 'dshm-export-input-' + run.slice(0, 8) + '.txt'
  const text = marker + '\n' + randomBytes(340000).toString('base64') + '\n原始附件：中文 🙂\n'
  const source = Buffer.from(text), sha256 = createHash('sha256').update(source).digest('hex')
  let profile: Buffer | undefined
  let baseline: { root: any; child: any; ref: any } | undefined
  const unchanged = async () => {
    expect(baseline).toBeTruthy()
    expect(profile).toBeTruthy()
    expect(await readSession()).toEqual(baseline!.root)
    expect(await readChild()).toEqual(baseline!.child)
    expect(await readFile(profilePath)).toEqual(profile)
  }
  return {
    marker, name, text, bytes: source.length, sha256, sessionId,
    async prepared(prompt: string) {
      await verifyReply(marker + '_ATTACHED')
      const root = await readSession(), child = await readChild()
      const sent = root.records.filter((row: any) => row.event.type === 'user/message'
        && row.event.data.content.some((part: any) => part.type === 'text' && part.text === prompt))
      expect(sent).toHaveLength(1)
      const refs = sent[0].event.data.content.filter((part: any) => part.type === 'file').map((part: any) => part.attachment)
      expect(refs).toHaveLength(1)
      expect(refs[0]).toMatchObject({ name, bytes: source.length, attachmentId: 'sha256:' + sha256 })
      expect(root.snapshot.values.subagentCatalog.filter((row: any) => row.id === childId())).toHaveLength(1)
      baseline = { root, child, ref: refs[0] }
      // 常规前置步骤会切换模型；只比较正式导出开始后的配置，不能误判该授权动作。
      profile = await readFile(profilePath)
      return { rootId: sessionId, childId: childId(), ref: refs[0],
        rootEvents: root.records.map((row: any) => row.event), childEvents: child.records.map((row: any) => row.event),
        uniqueActualAttachment: true, originalChildVerified: true }
    },
    async original(includeDescendants: boolean) {
      await unchanged()
      const zip = await exportZip(includeDescendants)
      await unchanged()
      return zip
    },
    async verify() {
      await unchanged()
      return { rootHistoryUnchanged: true, childHistoryUnchanged: true, profileUnchanged: true,
        originalAttachmentSha256: sha256, noPromptReplay: true }
    },
  }
}
