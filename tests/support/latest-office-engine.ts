import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect } from 'vitest'
import { clientFrameSchema, officeMetadataSchema, RESOURCE_CHUNK_BYTES, MAX_OFFICE_PDF_BYTES, type Operation } from '@dsh-mobile/protocol'

export type OfficeEnginePhase = 'office-engine-prepare' | 'office-engine-running' | 'office-engine-stopped' | 'office-engine-reopened'
  | 'office-engine-service-stopped' | 'office-engine-service-reopened'
  | 'office-engine-revoke-prepare' | 'office-engine-revoke-running' | 'office-engine-revoke-stopped'
  | 'office-engine-shared-join' | 'office-engine-shared-remaining' | 'office-engine-shared-finished' | 'office-engine-shared-cached'
  | 'office-engine-shared-cancel-joined' | 'office-engine-shared-phone-finished' | 'office-engine-shared-phone-cached'
  | 'office-engine-shared-service-failed' | 'office-engine-shared-revoke-join'
  | 'office-engine-shared-revoke-remaining' | 'office-engine-shared-revoke-finished'
type Relay = {
  request(operation: Operation): string
  receive(match: (frame: Record<string, any>) => boolean, timeout?: number): Promise<Record<string, any>>
  send(frame: unknown): void
  pending(id: string): Record<string, any>[]
}
type Observation = {
  id: string; hostPid: number; generation: string; serviceAvailable: boolean; expectedSha256: string; errors: string[]; scratchDirectories: string[]
  helpers: { pid: number; inputSha256: string; closed: boolean; code?: number; signal?: string }[]
  queue: { running: number; readers: number; tasks: number; sourceBytes: number; sources: number; digests: number;
    cached: number; cachedBytes: number; busySlots: number }
}

/** 手机 UI 驱动真正的转换；本机只读原进程/队列并核对原件。 */
export function latestOfficeEngine(home: string, sessionId: string, workspace: string, source: Uint8Array,
  rpc: (method: string, args: unknown) => Promise<any>, relay?: Relay, revocationSource?: Uint8Array) {
  const fileName = 'latest-mobile-engine.docx', path = resolve(workspace, fileName)
  const id = randomUUID(), sha256 = createHash('sha256').update(source).digest('hex')
  let baseline: Observation, started: Observation, metadata: any, revokeBaseline: Observation, revokeStarted: Observation
  const revokeFileName = 'latest-mobile-engine-revoke.docx', revokePath = resolve(workspace, revokeFileName)
  const revokeSha256 = revocationSource && createHash('sha256').update(revocationSource).digest('hex')
  let revokeMetadata: any
  let sharedRead: { id: string; chunks: number; bytes: number; settled: boolean; error?: string;
    cancelled: boolean; revocation?: boolean;
    metadata?: ReturnType<typeof officeMetadataSchema.parse>; sha256?: string }
  let sharedTask: Promise<void> | undefined
  const receiveShared = async () => {
    const chunks: Buffer[] = []
    for (;;) {
      const frame = await relay!.receive(frame => frame.id === sharedRead.id, 120000)
      if (frame.type === 'end') break
      expect(frame, JSON.stringify(frame)).toMatchObject({ type: 'event' })
      if (frame.value.type === 'converting') continue
      if (frame.value.type === 'metadata') {
        expect(sharedRead.metadata).toBeUndefined()
        const { type: _type, ...value } = frame.value
        sharedRead.metadata = officeMetadataSchema.parse(value)
        const expected = sharedRead.revocation ? revokeMetadata : metadata
        expect(sharedRead.metadata).toMatchObject({ absolutePath: expected.absolutePath, version: expected.version })
        continue
      }
      expect(sharedRead.metadata).toBeDefined()
      expect(frame.value).toMatchObject({ type: 'chunk', offset: sharedRead.bytes })
      const bytes = Buffer.from(frame.value.data, 'base64')
      expect(bytes.toString('base64')).toBe(frame.value.data)
      expect(bytes.length).toBeGreaterThan(0); expect(bytes.length).toBeLessThanOrEqual(RESOURCE_CHUNK_BYTES)
      sharedRead.bytes += bytes.length; sharedRead.chunks++
      expect(sharedRead.bytes).toBeLessThanOrEqual(MAX_OFFICE_PDF_BYTES)
      chunks.push(bytes)
      relay!.send(clientFrameSchema.parse({ type: 'ack', id: sharedRead.id, count: 1 }))
    }
    if (sharedRead.cancelled) {
      expect(sharedRead.metadata).toBeUndefined(); expect(sharedRead.bytes).toBe(0); expect(sharedRead.chunks).toBe(0)
      return
    }
    expect(sharedRead.metadata).toBeDefined()
    expect(sharedRead.bytes).toBe(sharedRead.metadata!.bytes)
    const pdf = Buffer.concat(chunks)
    expect(pdf.subarray(0, 8).toString('ascii')).toMatch(/^%PDF-\d\.\d/u)
    sharedRead.sha256 = createHash('sha256').update(pdf).digest('hex')
  }
  const observe = async () => {
    const directory = resolve(home, 'office-engine-observations')
    const latest = (await readdir(directory)).filter(name => name.startsWith(id + '-') && name.endsWith('.json')).sort().at(-1)
    if (!latest) return undefined
    const value: Observation = JSON.parse(await readFile(resolve(directory, latest), 'utf8'))
    expect(value.id).toBe(id); expect(value.errors).toEqual([])
    return value
  }
  const wait = async (predicate: (value: Observation) => boolean) => {
    let value: Observation | undefined
    await expect.poll(async () => {
      try { value = await observe(); return value !== undefined && predicate(value) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    }, { timeout: 30000, interval: 50 }).toBe(true)
    return value!
  }
  const sourceUnchanged = async () => {
    expect(await readFile(path)).toEqual(Buffer.from(source))
    expect(await rpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path: fileName })).toEqual(metadata)
  }
  const revocationSourceUnchanged = async (readMetadata = true) => {
    await readFile(path).then(bytes => expect(bytes).toEqual(Buffer.from(source)))
    expect(await readFile(revokePath)).toEqual(Buffer.from(revocationSource!))
    if (readMetadata) {
      expect(await rpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path: fileName })).toEqual(metadata)
      expect(await rpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path: revokeFileName })).toEqual(revokeMetadata)
    }
  }
  return { async cleanup() {
    if (!sharedRead || sharedRead.settled) return
    relay!.send(clientFrameSchema.parse({ type: 'cancel', id: sharedRead.id }))
    await Promise.race([sharedTask, new Promise(done => setTimeout(done, 5000))])
  }, async verify(phase: OfficeEnginePhase) {
    if (phase === 'office-engine-revoke-prepare') {
      expect(started).toBeDefined()
      // 原 DSH 按内容摘要缓存；使用独立有效原件，不能只改原文件版本冒充再次转换。
      expect(revocationSource).toBeDefined(); expect(revokeSha256).not.toBe(sha256)
      await writeFile(revokePath, revocationSource!)
      revokeMetadata = await rpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path: revokeFileName })
      await writeFile(resolve(home, 'office-engine-control.json'), JSON.stringify({ id, sha256: revokeSha256 }))
      revokeBaseline = await wait(value => value.expectedSha256 === revokeSha256 && value.serviceAvailable
        && value.helpers.length === 2 && value.helpers.every(h => h.closed)
        && value.queue.running === 0 && value.queue.readers === 0 && value.queue.tasks === 0)
      await revocationSourceUnchanged()
      return { fileName: revokeFileName, sessionId, metadata: revokeMetadata, sha256: revokeSha256, baseline: revokeBaseline }
    }
    if (phase === 'office-engine-revoke-running') {
      expect(revokeBaseline).toBeDefined()
      revokeStarted = await wait(value => value.serviceAvailable && value.helpers.length === 3
        && !value.helpers[2]!.closed && value.helpers[2]!.inputSha256 === revokeSha256 && value.queue.running === 1
        && value.queue.readers === (sharedRead?.revocation && !sharedRead.settled ? 2 : 1)
        && value.queue.tasks === 1 && value.queue.busySlots === 1)
      expect(revokeStarted.generation).toBe(revokeBaseline.generation)
      expect(revokeStarted.queue.cached).toBe(revokeBaseline.queue.cached)
      // 元数据在 prepare/finished 原接口逐项核对；在途窗口只核对实际字节和存活进程。
      process.kill(revokeStarted.helpers[2]!.pid, 0); await revocationSourceUnchanged(!relay)
      return revokeStarted
    }
    if (phase === 'office-engine-revoke-stopped') {
      expect(revokeStarted).toBeDefined()
      const value = await wait(value => value.serviceAvailable && value.helpers.length === 3 && value.helpers[2]!.closed
        && value.queue.running === 0 && value.queue.readers === 0 && value.queue.tasks === 0 && value.queue.sourceBytes === 0
        && value.queue.busySlots === 0 && value.scratchDirectories.length === 0)
      expect(value.helpers[2]!.pid).toBe(revokeStarted.helpers[2]!.pid)
      expect(value.helpers[2]!.code).not.toBe(0)
      expect(() => process.kill(value.helpers[2]!.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      expect(value.generation).toBe(revokeBaseline.generation)
      expect(value.queue.cached).toBe(revokeBaseline.queue.cached)
      expect(value.queue.cachedBytes).toBe(revokeBaseline.queue.cachedBytes)
      expect(value.queue.sources).toBe(0); expect(value.queue.digests).toBe(0)
      await revocationSourceUnchanged()
      return { ...value, revokedHelperExited: true, revokedResultNotCached: true, sourcePreserved: true }
    }
    if (phase === 'office-engine-prepare') {
      await writeFile(path, source)
      metadata = await rpc('workspaceFiles/stat', { workspaceFileScopeId: sessionId, path: fileName })
      await writeFile(resolve(home, 'office-engine-control.json'), JSON.stringify({ id, sha256 }))
      baseline = await wait(value => value.queue.running === 0 && value.queue.tasks === 0 && value.queue.readers === 0)
      expect(baseline.helpers).toEqual([]); expect(baseline.scratchDirectories).toEqual([])
      return { fileName, sessionId, metadata, sha256, baseline }
    }
    expect(baseline).toBeDefined()
    if (phase === 'office-engine-running') {
      started = await wait(value => value.helpers.length === 1 && value.helpers[0]!.inputSha256 === sha256
        && !value.helpers[0]!.closed && value.queue.running === 1 && value.queue.tasks === 1
        && value.queue.readers === (sharedRead && !sharedRead.settled ? 2 : 1) && value.queue.busySlots === 1)
      process.kill(started.helpers[0]!.pid, 0)
      expect(started.queue.cached).toBe(baseline.queue.cached)
      expect(started.scratchDirectories.length).toBeGreaterThan(0)
      await sourceUnchanged()
      return started
    }
    expect(started).toBeDefined()
    if (phase === 'office-engine-service-stopped') {
      const value = await wait(value => !value.serviceAvailable && value.helpers.length === 1 && value.helpers[0]!.closed
        && value.queue.running === 0 && value.queue.readers === 0 && value.queue.tasks === 0
        && value.queue.sourceBytes === 0 && value.queue.busySlots === 0 && value.scratchDirectories.length === 0)
      expect(value.helpers[0]!.pid).toBe(started.helpers[0]!.pid); expect(value.helpers[0]!.code).not.toBe(0)
      expect(() => process.kill(value.helpers[0]!.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      expect(value.generation).toBe(started.generation)
      expect(value.queue.cached).toBe(0); expect(value.queue.cachedBytes).toBe(0)
      expect(value.queue.sources).toBe(0); expect(value.queue.digests).toBe(0)
      await sourceUnchanged()
      return { ...value, unloadedHelperExited: true, oldCacheCleared: true, sourcePreserved: true }
    }
    if (phase === 'office-engine-service-reopened') {
      const value = await wait(value => value.serviceAvailable && value.helpers.length === 2 && value.helpers.every(h => h.closed)
        && value.queue.running === 0 && value.queue.readers === 0 && value.queue.tasks === 0
        && value.queue.sourceBytes === 0 && value.queue.busySlots === 0 && value.scratchDirectories.length === 0)
      expect(value.generation).not.toBe(started.generation)
      expect(value.helpers[1]!.pid).not.toBe(started.helpers[0]!.pid)
      expect(value.helpers[1]!.inputSha256).toBe(sha256); expect(value.helpers[1]!.code).toBe(0)
      expect(value.queue.cached).toBe(1); expect(value.queue.cachedBytes).toBeGreaterThan(0)
      expect(value.queue.sources).toBe(0); expect(value.queue.digests).toBe(0)
      await sourceUnchanged()
      return { ...value, newServiceConvertedFreshPdf: true, sourcePreserved: true }
    }
    if (phase.startsWith('office-engine-shared-')) {
      expect(relay).toBeDefined()
      if (phase === 'office-engine-shared-service-failed') {
        expect(sharedRead).toBeDefined()
        await expect.poll(() => sharedRead.settled, { timeout: 10000 }).toBe(true)
        expect(sharedRead.error).toContain('gateway/cancelled')
        expect(sharedRead.cancelled).toBe(false); expect(sharedRead.metadata).toBeUndefined()
        expect(sharedRead.bytes).toBe(0); expect(sharedRead.chunks).toBe(0)
        expect(relay!.pending(sharedRead.id)).toEqual([])
        return { reader: { ...sharedRead }, otherReaderFailedWithoutPdfAtOriginalServiceUnload: true }
      }
      if (phase === 'office-engine-shared-revoke-join') {
        expect(sharedRead.settled).toBe(true); expect(revokeBaseline).toBeDefined()
        revokeStarted = await wait(value => value.serviceAvailable && value.helpers.length === 3
          && !value.helpers[2]!.closed && value.helpers[2]!.inputSha256 === revokeSha256
          && value.queue.running === 1 && value.queue.tasks === 1 && value.queue.readers === 1 && value.queue.busySlots === 1)
        expect(revokeStarted.generation).toBe(revokeBaseline.generation)
        process.kill(revokeStarted.helpers[2]!.pid, 0)
        sharedRead = { id: relay!.request({ method: 'remote.office', sessionId, path: revokeFileName, priority: 'foreground' }),
          chunks: 0, bytes: 0, settled: false, cancelled: false, revocation: true }
        sharedTask = receiveShared().catch(error => { sharedRead.error = String(error) }).finally(() => { sharedRead.settled = true })
        const value = await wait(value => value.helpers.length === 3 && !value.helpers[2]!.closed
          && value.queue.running === 1 && value.queue.tasks === 1 && value.queue.readers === 2 && value.queue.busySlots === 1)
        expect(value.helpers[2]!.pid).toBe(revokeStarted.helpers[2]!.pid)
        process.kill(value.helpers[2]!.pid, 0)
        expect(sharedRead.settled).toBe(false); expect(sharedRead.metadata).toBeUndefined(); expect(sharedRead.chunks).toBe(0)
        await revocationSourceUnchanged(false)
        return { observation: value, reader: { ...sharedRead }, singleConversionSharedByTwoReaders: true }
      }
      if (phase === 'office-engine-shared-revoke-remaining') {
        const value = await wait(value => value.helpers.length === 3 && !value.helpers[2]!.closed
          && value.queue.running === 1 && value.queue.tasks === 1 && value.queue.readers === 1 && value.queue.busySlots === 1)
        expect(value.helpers[2]!.pid).toBe(revokeStarted.helpers[2]!.pid)
        process.kill(value.helpers[2]!.pid, 0)
        expect(sharedRead.revocation).toBe(true); expect(sharedRead.settled).toBe(false)
        expect(sharedRead.error).toBeUndefined(); expect(sharedRead.metadata).toBeUndefined(); expect(sharedRead.bytes).toBe(0)
        expect(value.queue.cached).toBe(revokeBaseline.queue.cached)
        await revocationSourceUnchanged(false)
        return { observation: value, reader: { ...sharedRead }, unaffectedApprovedReaderKeptOriginalHelperAlive: true }
      }
      if (phase === 'office-engine-shared-revoke-finished') {
        await expect.poll(() => sharedRead.settled, { timeout: 120000 }).toBe(true)
        expect(sharedRead.revocation).toBe(true); expect(sharedRead.error).toBeUndefined(); expect(sharedRead.cancelled).toBe(false)
        expect(sharedRead.sha256).toMatch(/^[0-9a-f]{64}$/)
        const value = await wait(value => value.helpers.length === 3 && value.helpers.every(h => h.closed)
          && value.queue.running === 0 && value.queue.readers === 0 && value.queue.tasks === 0
          && value.queue.sourceBytes === 0 && value.queue.busySlots === 0 && value.scratchDirectories.length === 0)
        expect(value.generation).toBe(revokeStarted.generation)
        expect(value.helpers[2]!.pid).toBe(revokeStarted.helpers[2]!.pid); expect(value.helpers[2]!.code).toBe(0)
        expect(() => process.kill(value.helpers[2]!.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        expect(value.queue.cached).toBe(revokeBaseline.queue.cached + 1)
        expect(value.queue.cachedBytes - revokeBaseline.queue.cachedBytes).toBe(sharedRead.bytes)
        expect(value.queue.sources).toBe(0); expect(value.queue.digests).toBe(0)
        expect(relay!.pending(sharedRead.id)).toEqual([])
        await revocationSourceUnchanged()
        return { ...value, reader: { ...sharedRead }, unaffectedApprovedReaderReceivedCompleteActualPdf: true,
          completedHelperAndQueueReleased: true, sourcePreserved: true }
      }
      if (phase === 'office-engine-shared-join') {
        expect(sharedRead).toBeUndefined()
        sharedRead = { id: relay!.request({ method: 'remote.office', sessionId, path: fileName, priority: 'foreground' }),
          chunks: 0, bytes: 0, settled: false, cancelled: false }
        // 原已批准的中转连接立即消费并确认分片，不暂停或替换转换结果。
        sharedTask = receiveShared().catch(error => { sharedRead.error = String(error) }).finally(() => { sharedRead.settled = true })
        const value = await wait(value => value.helpers.length === 1 && !value.helpers[0]!.closed
          && value.queue.running === 1 && value.queue.tasks === 1 && value.queue.readers === 2 && value.queue.busySlots === 1)
        expect(value.helpers[0]!.pid).toBe(started.helpers[0]!.pid)
        process.kill(value.helpers[0]!.pid, 0)
        expect(sharedRead.settled).toBe(false); expect(sharedRead.metadata).toBeUndefined(); expect(sharedRead.chunks).toBe(0)
        expect(value.queue.sourceBytes).toBe(started.queue.sourceBytes)
        await sourceUnchanged()
        return { observation: value, reader: { ...sharedRead }, singleConversionSharedByTwoReaders: true }
      }
      expect(sharedRead).toBeDefined()
      if (phase === 'office-engine-shared-cancel-joined') {
        expect(sharedRead.settled).toBe(false); expect(sharedRead.cancelled).toBe(false)
        sharedRead.cancelled = true
        relay!.send(clientFrameSchema.parse({ type: 'cancel', id: sharedRead.id }))
        await expect.poll(() => sharedRead.settled, { timeout: 10000 }).toBe(true)
        expect(sharedRead.error).toBeUndefined(); expect(sharedRead.metadata).toBeUndefined()
        expect(sharedRead.bytes).toBe(0); expect(sharedRead.chunks).toBe(0)
        const value = await wait(value => value.helpers.length === 1 && !value.helpers[0]!.closed
          && value.queue.running === 1 && value.queue.tasks === 1 && value.queue.readers === 1 && value.queue.busySlots === 1)
        expect(value.helpers[0]!.pid).toBe(started.helpers[0]!.pid)
        process.kill(value.helpers[0]!.pid, 0)
        expect(value.queue.cached).toBe(baseline.queue.cached)
        expect(value.queue.sourceBytes).toBe(started.queue.sourceBytes)
        expect(relay!.pending(sharedRead.id)).toEqual([])
        await sourceUnchanged()
        return { observation: value, reader: { ...sharedRead }, joinedReaderCancelledOnlyOwnRequest: true,
          remainingPhoneReaderKeptOriginalEngineAlive: true }
      }
      if (phase === 'office-engine-shared-remaining') {
        const value = await wait(value => value.helpers.length === 1 && !value.helpers[0]!.closed
          && value.queue.running === 1 && value.queue.tasks === 1 && value.queue.readers === 1 && value.queue.busySlots === 1)
        expect(value.helpers[0]!.pid).toBe(started.helpers[0]!.pid)
        process.kill(value.helpers[0]!.pid, 0)
        expect(sharedRead.settled).toBe(false); expect(sharedRead.error).toBeUndefined()
        expect(value.queue.cached).toBe(baseline.queue.cached)
        await sourceUnchanged()
        return { observation: value, reader: { ...sharedRead }, remainingReaderKeptOriginalEngineAlive: true }
      }
      const phoneRemaining = phase === 'office-engine-shared-phone-finished' || phase === 'office-engine-shared-phone-cached'
      expect(['office-engine-shared-finished', 'office-engine-shared-cached',
        'office-engine-shared-phone-finished', 'office-engine-shared-phone-cached']).toContain(phase)
      await expect.poll(() => sharedRead.settled, { timeout: 120000 }).toBe(true)
      expect(sharedRead.error).toBeUndefined(); expect(sharedRead.cancelled).toBe(phoneRemaining)
      if (phoneRemaining) {
        expect(sharedRead.metadata).toBeUndefined(); expect(sharedRead.bytes).toBe(0); expect(sharedRead.chunks).toBe(0)
        expect(sharedRead.sha256).toBeUndefined(); expect(relay!.pending(sharedRead.id)).toEqual([])
      } else expect(sharedRead.sha256).toMatch(/^[0-9a-f]{64}$/)
      const value = await wait(value => value.helpers.length === 1 && value.helpers[0]!.closed
        && value.queue.running === 0 && value.queue.tasks === 0 && value.queue.readers === 0
        && value.queue.sourceBytes === 0 && value.queue.busySlots === 0 && value.scratchDirectories.length === 0)
      expect(value.helpers[0]!.pid).toBe(started.helpers[0]!.pid); expect(value.helpers[0]!.code).toBe(0)
      expect(() => process.kill(value.helpers[0]!.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      expect(value.generation).toBe(started.generation)
      expect(value.queue.cached).toBe(baseline.queue.cached + 1)
      const pdfBytes = value.queue.cachedBytes - baseline.queue.cachedBytes
      expect(pdfBytes).toBeGreaterThan(0); expect(pdfBytes).toBeLessThanOrEqual(MAX_OFFICE_PDF_BYTES)
      if (!phoneRemaining) expect(pdfBytes).toBe(sharedRead.bytes)
      expect(value.queue.sources).toBe(0); expect(value.queue.digests).toBe(0)
      await sourceUnchanged()
      return { observation: value, reader: { ...sharedRead }, pdfBytes, originalEngineCompletedForRemainingReader: true,
        oneNativeHelperOnly: true, sourcePreserved: true }
    }
    if (phase === 'office-engine-stopped') {
      const value = await wait(value => value.helpers.length === 1 && value.helpers[0]!.closed
        && value.queue.running === 0 && value.queue.tasks === 0 && value.queue.readers === 0
        && value.queue.sourceBytes === 0 && value.queue.busySlots === 0 && value.scratchDirectories.length === 0)
      expect(() => process.kill(started.helpers[0]!.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      expect(value.queue.cached).toBe(baseline.queue.cached)
      expect(value.queue.cachedBytes).toBe(baseline.queue.cachedBytes)
      expect(value.queue.sources).toBe(0); expect(value.queue.digests).toBe(0)
      await sourceUnchanged()
      return { ...value, originalHelperExited: true, scratchRemoved: true, cancelledResultNotCached: true, sourcePreserved: true }
    }
    expect(phase).toBe('office-engine-reopened')
    const value = await wait(value => value.helpers.length === 2 && value.helpers.every(helper => helper.closed)
      && value.queue.running === 0 && value.queue.tasks === 0 && value.queue.readers === 0
      && value.queue.sourceBytes === 0 && value.queue.busySlots === 0 && value.scratchDirectories.length === 0)
    expect(value.helpers[1]!.pid).not.toBe(started.helpers[0]!.pid)
    expect(value.helpers[1]!.inputSha256).toBe(sha256); expect(value.helpers[1]!.code).toBe(0)
    expect(value.queue.cached).toBe(baseline.queue.cached + 1)
    await sourceUnchanged()
    return { ...value, freshNativeConversion: true, sourcePreserved: true }
  } }
}
