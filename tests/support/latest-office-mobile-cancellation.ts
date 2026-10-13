import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect } from 'vitest'
import { latestOfficeFilePermission } from './latest-office-file-permission.js'
import { clientFrameSchema, officeMetadataSchema, RESOURCE_CHUNK_BYTES, RESOURCE_WINDOW, type Operation } from '@dsh-mobile/protocol'

type Frame = Record<string, any>
type Relay = {
  request(operation: Operation): string
  receive(match: (frame: Frame) => boolean, timeout?: number): Promise<Frame>
  send(frame: unknown): void
  pending(id: string): Frame[]
  desktopRpc(method: string, args: unknown): Promise<any>
}
export type OfficeCancellationPhase = 'office-cancel-prepare' | 'office-cancel-refresh' | 'office-cancel-hold-other'
  | 'office-cancel-busy' | 'office-cancel-released' | 'office-cancel-cleanup'
  | 'office-cancel-file-prepare' | 'office-cancel-file-deny' | 'office-cancel-file-restore'

/** 一个真实读者由手机持有，另一个由此 socket 持有；关闭手机预览必须释放 Host 名额。 */
export function latestOfficeMobileCancellation(relay: Relay, sessionId: string, workspacePath: string, source: Uint8Array) {
  const path = 'latest-mobile-inflight.docx', absolutePath = resolve(workspacePath, path)
  const active = new Set<string>()
  let filePermission: Awaited<ReturnType<typeof latestOfficeFilePermission>> | undefined
  let filePermissionRestored = false
  const send = (frame: unknown) => relay.send(clientFrameSchema.parse(frame))
  const start = async () => {
    let id = ''
    await expect.poll(async () => {
      id = relay.request({ method: 'remote.office', sessionId, path, priority: 'foreground' })
      const first = await relay.receive(frame => frame.id === id)
      if (first.type === 'error' && first.code === 'remote_office_busy') return false
      expect(first).toMatchObject({ type: 'event', value: { type: 'converting' } })
      return true
    }, { timeout: 10000 }).toBe(true)
    active.add(id)
    const meta = await relay.receive(frame => frame.id === id, 120000)
    expect(meta).toMatchObject({ type: 'event', value: { type: 'metadata' } })
    const { type: _type, ...value } = meta.value
    const metadata = officeMetadataSchema.parse(value)
    expect(metadata.absolutePath).toBe(absolutePath)
    expect(metadata.bytes).toBeGreaterThan(RESOURCE_WINDOW * RESOURCE_CHUNK_BYTES)
    let offset = 0
    for (let n = 0; n < RESOURCE_WINDOW; n++) {
      const frame = await relay.receive(frame => frame.id === id)
      expect(frame).toMatchObject({ type: 'event', value: { type: 'chunk', offset } })
      const bytes = Buffer.from(frame.value.data, 'base64')
      expect(bytes.length).toBe(RESOURCE_CHUNK_BYTES)
      expect(bytes.toString('base64')).toBe(frame.value.data)
      offset += bytes.length
    }
    await relay.desktopRpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path })
    expect(relay.pending(id)).toEqual([])
    return { metadata, offset }
  }
  const cancel = async (id: string) => {
    send({ type: 'cancel', id })
    expect(await relay.receive(frame => frame.id === id)).toEqual({ type: 'end', id })
    active.delete(id)
  }
  const cleanup = async () => {
    if (filePermission && !filePermissionRestored) {
      await filePermission.restore(); filePermissionRestored = true
    }
    for (const id of [...active]) await cancel(id)
    if (prepared) expect(await readFile(absolutePath)).toEqual(Buffer.from(source))
  }
  let prepared = false
  return { cleanup, async verify(phase: OfficeCancellationPhase) {
    if (phase === 'office-cancel-prepare') {
      expect(prepared).toBe(false)
      await writeFile(absolutePath, source); prepared = true
      const metadata = await relay.desktopRpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path })
      expect(metadata.bytes).toBe(source.byteLength)
      return { fileName: path, sessionId, metadata, chunkBytes: RESOURCE_CHUNK_BYTES, window: RESOURCE_WINDOW }
    }
    expect(prepared).toBe(true)
    if (phase.startsWith('office-cancel-file-')) {
      expect(process.env.DSHM_LATEST_OFFICE_FILE_PERMISSION_UI_CHECK).toBe('1')
      if (phase === 'office-cancel-file-prepare') {
        expect(filePermission).toBeUndefined()
        filePermission = await latestOfficeFilePermission(absolutePath)
        return { fileName: path, sessionId,
          metadata: await relay.desktopRpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path }),
          generation: await relay.desktopRpc('officeToPdf/generation', {}) }
      }
      expect(filePermission).toBeDefined()
      if (phase === 'office-cancel-file-deny') return filePermission!.deny()
      expect(phase).toBe('office-cancel-file-restore')
      const restored = await filePermission!.restore(); filePermissionRestored = true
      return { ...restored, metadata: await relay.desktopRpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path }),
        generation: await relay.desktopRpc('officeToPdf/generation', {}) }
    }
    if (phase === 'office-cancel-refresh') {
      expect(active.size).toBe(0)
      expect(await readFile(absolutePath)).toEqual(Buffer.from(source))
      const previous = await relay.desktopRpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path })
      // 同字节真实重写使源版本改变，避免上一次成功预览的手机缓存跳过传输阶段。
      await writeFile(absolutePath, source)
      const metadata = await relay.desktopRpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path })
      expect(metadata.version).not.toBe(previous.version)
      expect(metadata.bytes).toBe(source.byteLength)
      return { fileName: path, sessionId, metadata, chunkBytes: RESOURCE_CHUNK_BYTES, window: RESOURCE_WINDOW }
    }
    if (phase === 'office-cancel-hold-other') {
      expect(active.size).toBe(0)
      return start()
    }
    if (phase === 'office-cancel-busy') {
      expect(active.size).toBe(1)
      const id = relay.request({ method: 'remote.office', sessionId, path, priority: 'foreground' })
      expect(await relay.receive(frame => frame.id === id)).toMatchObject({ type: 'error', code: 'remote_office_busy' })
      return { bothReadersOccupied: true }
    }
    if (phase === 'office-cancel-released') {
      expect(active.size).toBe(1)
      const replacement = await start()
      expect(active.size).toBe(2)
      await cleanup()
      return { replacement, phoneReaderReleased: true, sourcePreserved: true }
    }
    expect(phase).toBe('office-cancel-cleanup')
    await cleanup()
    return { sourcePreserved: true, heldReadersReleased: true }
  } }
}
