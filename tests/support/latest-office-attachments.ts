import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect } from 'vitest'
import { attachmentRefSchema, attachmentOfficeMetadataSchema, clientFrameSchema,
  MAX_OFFICE_PDF_BYTES, RESOURCE_CHUNK_BYTES, type Operation } from '@dsh-mobile/protocol'

type Frame = Record<string, any>
type Relay = {
  request(operation: Operation): string
  receive(match: (frame: Frame) => boolean, timeout?: number): Promise<Frame>
  send(frame: unknown): void
  desktopRpc(method: string, args: unknown): Promise<any>
}

/** 使用真实上传回执与原持久消息，不直接伪造附件引用或存储对象。 */
export async function verifyLatestOfficeAttachments(relay: Relay, sessionId: string, workspaceId: string,
  workspacePath: string, sources: readonly { extension: string; bytes: Uint8Array }[]) {
  const uploaded: { receiptId: string; file: { attachmentId: string; name: string; bytes: number }; source: Uint8Array }[] = []
  const send = (frame: unknown) => relay.send(clientFrameSchema.parse(frame))
  const reply = async (operation: Operation) => {
    const id = relay.request(operation)
    for (;;) {
      const frame = await relay.receive(frame => frame.id === id)
      if (frame.type !== 'event') return frame
      // 原适配器先发转换状态；拒绝路径不得发出元数据或任何内容块。
      expect(frame.value).toEqual({ type: 'converting' })
    }
  }
  for (const source of sources) {
    const name = 'latest-history-office.' + source.extension
    const id = relay.request({ method: 'remote.upload', sessionId, name })
    let credits = 0
    for (let offset = 0; offset < source.bytes.length; offset += RESOURCE_CHUNK_BYTES) {
      if (!credits) {
        const credit = await relay.receive(frame => frame.id === id)
        expect(credit).toMatchObject({ type: 'event', value: { type: 'credit' } })
        expect(credit.value.count).toBeGreaterThan(0); expect(credit.value.count).toBeLessThanOrEqual(4)
        credits += credit.value.count
      }
      credits--
      send({ type: 'uploadChunk', id, data: Buffer.from(source.bytes.subarray(offset, offset + RESOURCE_CHUNK_BYTES)).toString('base64') })
    }
    send({ type: 'uploadEnd', id })
    const response = await relay.receive(frame => frame.id === id && frame.type !== 'event')
    expect(response, JSON.stringify(response)).toMatchObject({ type: 'result', value: { ok: true } })
    const { receiptId } = response.value.value
    expect(receiptId).toEqual(expect.any(String))
    const file = attachmentRefSchema.parse(response.value.value.file)
    expect(file).toMatchObject({ name, bytes: source.bytes.length })
    expect(file.mediaType).toBeUndefined()
    uploaded.push({ receiptId, file: { attachmentId: file.attachmentId, name, bytes: file.bytes }, source: source.bytes })
    expect(await reply({ method: 'remote.attachmentOffice', sessionId, attachmentId: file.attachmentId, name }))
      .toMatchObject({ type: 'error', code: 'remote_attachment_not_referenced' })
    // 同名电脑文件故意不是Office：历史预览必须读取原附件，而不是按显示名读取磁盘。
    await writeFile(resolve(workspacePath, name), 'Different workspace bytes; never the historical attachment.')
  }
  const marker = 'LATEST_OFFICE_HISTORY_' + randomUUID()
  expect(await reply({ method: 'remote.rpc', endpoint: 'session/prompt', payload: { args: { request: {
    sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: marker },
      ...uploaded.map(item => ({ type: 'file', receiptId: item.receiptId }))],
  } } } })).toMatchObject({ type: 'result', value: { ok: true, value: { accepted: true } } })
  await expect.poll(async () => (await relay.desktopRpc('session/list', { _request: {} })).items
    .find((item: { sessionId: string }) => item.sessionId === sessionId)?.running).toBe(false)
  const otherSessionId = 'latest-office-other-' + randomUUID()
  await relay.desktopRpc('session/create', { request: { workspaceId, sessionId: otherSessionId } })
  const first = uploaded[0]!.file
  for (const invalid of [{ sessionId: otherSessionId, ...first }, { sessionId, ...first, name: 'wrong.docx' },
    { sessionId, ...first, attachmentId: 'not-the-original-attachment' }]) {
    const { bytes: _bytes, ...identity } = invalid
    expect(await reply({ method: 'remote.attachmentOffice', ...identity }))
      .toMatchObject({ type: 'error', code: 'remote_attachment_not_referenced' })
  }
  const formats: Record<string, unknown> = {}
  for (const item of uploaded) {
    const identity = { sessionId, attachmentId: item.file.attachmentId, name: item.file.name }
    const readOriginal = async () => {
      const id = relay.request({ method: 'remote.attachment', kind: 'file', ...identity })
      let offset = 0, metadata = false
      const chunks: Buffer[] = []
      for (;;) {
        const frame = await relay.receive(frame => frame.id === id)
        if (frame.type === 'end') break
        expect(frame).toMatchObject({ type: 'event' })
        if (frame.value.type === 'metadata') {
          expect(metadata).toBe(false)
          expect(attachmentRefSchema.parse(frame.value.attachment)).toEqual(item.file)
          metadata = true; continue
        }
        expect(metadata).toBe(true); expect(frame.value).toMatchObject({ type: 'chunk', offset })
        const chunk = Buffer.from(frame.value.data, 'base64')
        expect(chunk.toString('base64')).toBe(frame.value.data)
        expect(chunk.length).toBeGreaterThan(0); expect(chunk.length).toBeLessThanOrEqual(RESOURCE_CHUNK_BYTES)
        offset += chunk.length; expect(offset).toBeLessThanOrEqual(item.file.bytes)
        chunks.push(chunk); send({ type: 'ack', id, count: 1 })
      }
      expect(metadata).toBe(true); expect(offset).toBe(item.file.bytes)
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(item.source))
    }
    await readOriginal()
    const id = relay.request({ method: 'remote.attachmentOffice', ...identity, priority: 'foreground' })
    let metadata: ReturnType<typeof attachmentOfficeMetadataSchema.parse> | undefined, offset = 0
    const chunks: Buffer[] = []
    for (;;) {
      const frame = await relay.receive(frame => frame.id === id, 120000)
      if (frame.type === 'end') break
      expect(frame, JSON.stringify(frame)).toMatchObject({ type: 'event' })
      if (frame.value.type === 'converting' && !metadata) continue
      if (frame.value.type === 'metadata') {
        const { type: _type, ...value } = frame.value
        expect(metadata).toBeUndefined(); metadata = attachmentOfficeMetadataSchema.parse(value)
        expect(metadata).toMatchObject({ attachmentId: item.file.attachmentId, name: item.file.name })
        continue
      }
      expect(metadata).toBeDefined(); expect(frame.value).toMatchObject({ type: 'chunk', offset })
      const chunk = Buffer.from(frame.value.data, 'base64')
      expect(chunk.toString('base64')).toBe(frame.value.data)
      expect(chunk.length).toBeGreaterThan(0); expect(chunk.length).toBeLessThanOrEqual(RESOURCE_CHUNK_BYTES)
      offset += chunk.length; expect(offset).toBeLessThanOrEqual(MAX_OFFICE_PDF_BYTES)
      chunks.push(chunk); send({ type: 'ack', id, count: 1 })
    }
    expect(metadata).toBeDefined(); expect(offset).toBe(metadata?.bytes)
    expect(Buffer.concat(chunks).subarray(0, 8).toString('ascii')).toMatch(/^%PDF-\d\.\d/u)
    await readOriginal()
    formats[item.file.name.split('.').at(-1)!] = { bytes: offset, missingFonts: metadata?.missingFonts }
  }
  return { marker, files: uploaded.map(item => item.file), formats, unreferencedDenied: true,
    wrongSessionNameAndIdDenied: true, sameNameWorkspaceIgnored: true, originalBytesPreserved: true }
}
