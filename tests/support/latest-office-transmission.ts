import { readFile, writeFile, unlink } from 'node:fs/promises'
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

/** 真实转换器和信用窗口；原网关取消回执不代表完整PDF读取成功。 */
export async function verifyLatestOfficeTransmission(relay: Relay, sessionId: string, workspacePath: string,
  source: Uint8Array, replacement: Uint8Array) {
  const path = 'latest-office-transmission.docx', absolutePath = resolve(workspacePath, path)
  const send = (frame: unknown) => relay.send(clientFrameSchema.parse(frame))
  const active = new Set<string>()
  let officeServiceId: string | undefined, officeDisabled = false
  const setOfficeEnabled = async (enabled: boolean) => {
    expect(officeServiceId).toBeTruthy()
    expect(await relay.desktopRpc('pluginManager/setPluginEnabled', { id: officeServiceId, enabled }))
      .toMatchObject({ application: 'applied', enabled })
    officeDisabled = !enabled
  }
  const start = async () => {
    let id = '', first: Frame | undefined
    await expect.poll(async () => {
      id = relay.request({ method: 'remote.office', sessionId, path })
      first = await relay.receive(frame => frame.id === id)
      // 被取消读者的finally可能尚在清理；只对原容量拒绝做有界等待。
      if (first.type === 'error' && first.code === 'remote_office_busy') return false
      expect(first).toMatchObject({ type: 'event', value: { type: 'converting' } })
      return true
    }, { timeout: 10000 }).toBe(true)
    active.add(id)
    const meta = await relay.receive(frame => frame.id === id, 120000)
    expect(meta).toMatchObject({ type: 'event', value: { type: 'metadata' } })
    const { type: _type, ...value } = meta.value
    const metadata = officeMetadataSchema.parse(value)
    expect(metadata.bytes).toBeGreaterThan(RESOURCE_CHUNK_BYTES * RESOURCE_WINDOW)
    expect(metadata.absolutePath).toBe(absolutePath)
    let offset = 0
    for (let n = 0; n < RESOURCE_WINDOW; n++) {
      const frame = await relay.receive(frame => frame.id === id)
      expect(frame).toMatchObject({ type: 'event', value: { type: 'chunk', offset } })
      const bytes = Buffer.from(frame.value.data, 'base64')
      expect(bytes.length).toBe(RESOURCE_CHUNK_BYTES)
      expect(bytes.toString('base64')).toBe(frame.value.data)
      offset += bytes.length
    }
    // 原Host往返作为已运行的观察屏障；无ack时不能继续发送第五个块或成功终态。
    await relay.desktopRpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path })
    expect(relay.pending(id)).toEqual([])
    return { id, metadata, offset }
  }
  const cancel = async (id: string) => {
    send({ type: 'cancel', id })
    expect(await relay.receive(frame => frame.id === id)).toEqual({ type: 'end', id })
    active.delete(id)
  }
  const finish = async (held: Awaited<ReturnType<typeof start>>) => {
    send({ type: 'ack', id: held.id, count: RESOURCE_WINDOW })
    let offset = held.offset
    for (;;) {
      const frame = await relay.receive(frame => frame.id === held.id)
      if (frame.type !== 'event') { active.delete(held.id); return { frame, offset } }
      expect(frame).toMatchObject({ value: { type: 'chunk', offset } })
      const bytes = Buffer.from(frame.value.data, 'base64')
      expect(bytes.length).toBeGreaterThan(0); expect(bytes.length).toBeLessThanOrEqual(RESOURCE_CHUNK_BYTES)
      expect(bytes.toString('base64')).toBe(frame.value.data)
      offset += bytes.length; expect(offset).toBeLessThanOrEqual(held.metadata.bytes)
      send({ type: 'ack', id: held.id, count: 1 })
    }
  }
  await writeFile(absolutePath, source)
  let filePermission: Awaited<ReturnType<typeof latestOfficeFilePermission>> | undefined
  let permissionReport: Record<string, unknown> | undefined
  try {
    const first = await start(), second = await start()
    const extra = relay.request({ method: 'remote.office', sessionId, path })
    expect(await relay.receive(frame => frame.id === extra)).toMatchObject({ type: 'error', code: 'remote_office_busy' })
    expect(first.offset).toBeLessThan(first.metadata.bytes); expect(second.offset).toBeLessThan(second.metadata.bytes)
    await cancel(first.id); await cancel(second.id)
    const resumed = await start(), other = await start()
    await cancel(other.id)
    const completed = await finish(resumed)
    expect(completed.frame).toMatchObject({ type: 'end' })
    expect(completed.offset).toBe(resumed.metadata.bytes)
    expect(relay.pending(first.id)).toEqual([]); expect(relay.pending(second.id)).toEqual([])
    const changed = await start()
    await writeFile(absolutePath, replacement)
    const newMetadata = await relay.desktopRpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path })
    expect(newMetadata.version).not.toBe(changed.metadata.version)
    const stale = await finish(changed)
    expect(stale.offset).toBe(changed.metadata.bytes)
    expect(stale.frame).toMatchObject({ type: 'error', code: 'remote_file_changed' })
    await writeFile(absolutePath, source)
    const removed = await start()
    await unlink(absolutePath)
    const absent = await finish(removed)
    expect(absent.offset).toBe(removed.metadata.bytes)
    expect(absent.frame).toMatchObject({ type: 'result', value: { ok: false, error: { code: 'workspace-file/not-found' } } })
    await writeFile(absolutePath, source)
    const restored = await start(), recovered = await finish(restored)
    expect(recovered.frame).toMatchObject({ type: 'end' }); expect(recovered.offset).toBe(restored.metadata.bytes)
    expect(restored.metadata.version).not.toBe(removed.metadata.version)

    if (process.env.DSHM_LATEST_OFFICE_FILE_PERMISSION_CHECK === '1') {
      filePermission = await latestOfficeFilePermission(absolutePath)
      const generation = await relay.desktopRpc('officeToPdf/generation', {})
      const held = await start(), otherReader = await start()
      const extra = relay.request({ method: 'remote.office', sessionId, path })
      expect(await relay.receive(frame => frame.id === extra)).toMatchObject({ type: 'error', code: 'remote_office_busy' })
      const denied = await filePermission.deny()
      // 使用原 Host 的真实拒绝终态，不把传完 PDF 字节记为读取成功。
      const failed = await finish(held)
      expect(failed.offset).toBe(held.metadata.bytes)
      expect(failed.frame).toMatchObject({ type: 'result', value: { ok: false, error: { code: 'gateway/internal', details: {} } } })
      expect(failed.frame.value.error.message).toMatch(/^(EPERM|EACCES):/)
      expect(failed.frame.value.error.message).toContain(absolutePath)
      expect(relay.pending(held.id)).toEqual([])
      const restoredAcl = await filePermission.restore()
      const afterPermission = await start(), reread = await finish(afterPermission)
      expect(reread.frame).toMatchObject({ type: 'end' })
      expect(reread.offset).toBe(afterPermission.metadata.bytes)
      expect(afterPermission.metadata.generation).toBe(generation)
      await cancel(otherReader.id)
      permissionReport = { denied, failure: failed.frame, receivedBytesBeforeRejection: failed.offset,
        restored: restoredAcl, realFileReadDeniedDuringTransmission: true,
        fullyTransferredPdfRejectedBeforeSuccess: true, readerReleasedAndRereadSucceeded: true,
        readerCapacityReleasedWhileOtherReaderHeld: true, originalPermissionFailureContractVerified: true,
        converterGenerationPreserved: true, scope: 'Windows ReadData DACL on owned workspace source; not attachment reference or Android UI' }
    }

    // 保持真实PDF停在信用窗口；卸载原服务后，完整结果不能使用旧的转换代次。
    const services = (await relay.desktopRpc('pluginManager/listPlugins', {}))
      .filter((row: { moduleName: string }) => row.moduleName === '@deepseek-ai/dsh-office-to-pdf')
    expect(services).toHaveLength(1); expect(services[0].readOnlyReason).toBeUndefined()
    officeServiceId = services[0].entryId
    const unloading = await start()
    await setOfficeEnabled(false)
    const unavailable = await finish(unloading)
    expect(unavailable.offset).toBe(unloading.metadata.bytes)
    expect(unavailable.frame).toMatchObject({ type: 'result', value: { ok: false, error: {
      code: 'gateway/definition-unavailable', details: { endpoint: 'officeToPdf/generation' },
    } } })
    await setOfficeEnabled(true)
    const afterUnload = await start(), reread = await finish(afterUnload)
    expect(afterUnload.metadata.generation).not.toBe(unloading.metadata.generation)
    expect(reread.frame).toMatchObject({ type: 'end' }); expect(reread.offset).toBe(afterUnload.metadata.bytes)

    const replaced = await start()
    await setOfficeEnabled(false); await setOfficeEnabled(true)
    const currentGeneration = await relay.desktopRpc('officeToPdf/generation', {})
    expect(currentGeneration).not.toBe(replaced.metadata.generation)
    const staleGeneration = await finish(replaced)
    expect(staleGeneration.offset).toBe(replaced.metadata.bytes)
    expect(staleGeneration.frame).toMatchObject({ type: 'error', code: 'remote_file_changed' })
    const latest = await start(), current = await finish(latest)
    expect(latest.metadata.generation).toBe(currentGeneration)
    expect(current.frame).toMatchObject({ type: 'end' }); expect(current.offset).toBe(latest.metadata.bytes)
    expect(await readFile(absolutePath)).toEqual(Buffer.from(source))
    return { pdfBytes: restored.metadata.bytes, windowBytes: RESOURCE_CHUNK_BYTES * RESOURCE_WINDOW,
      realBackpressure: true, cancellationReleasedBothReaders: true, changedSourceRejectedAtEnd: true,
      deletedSourceRejectedAtEnd: true, originalSourceRestored: true,
      serviceUnloadDuringTransmissionRejected: true, serviceReloadGenerationRejected: true,
      reloadRereadSucceeded: true, ...(permissionReport ? { filePermission: permissionReport } : {}),
      scope: 'real PDF transmission after conversion; not engine-in-flight cancellation or Android cache validation' }
  } finally {
    for (const id of active) send({ type: 'cancel', id })
    if (filePermission) await filePermission.restore()
    if (officeDisabled) await setOfficeEnabled(true)
    await writeFile(absolutePath, source)
  }
}
