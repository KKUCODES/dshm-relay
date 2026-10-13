import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { expect } from 'vitest'

/** 只控制真实命令自己的等待；电脑退出与正常重开由现有官方生命周期驱动完成。 */
export async function officialBackgroundHost({ run, sessionId, readSession, result, profilePath, generation: initial,
  stopHost, startHost, jobs }: {
  run: string; sessionId: string; readSession: () => Promise<any>; result: (operation: unknown) => Promise<any>
  profilePath: string; generation: string; stopHost: () => Promise<any>; startHost: () => Promise<any>
  jobs: Map<string, string>
}) {
  let generation = initial, profile: Buffer | undefined
  const sockets = new Set<Socket>(), targets = new Map<string, any>(), checkpoints = new Map<string, any>()
  const requests: Array<{ mode: string; closed: boolean; released: boolean }> = []
  const responses = new Map<string, ServerResponse>()
  const server = createServer((request, response) => {
    const mode = ['running', 'settled'].find(value => request.url === `/${run}/${value}`)
    if (request.method !== 'GET' || !mode || responses.has(mode)) { response.writeHead(404).end(); return }
    const row = { mode, closed: false, released: false }
    requests.push(row); responses.set(mode, response); response.once('close', () => { row.closed = true })
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('official_background_host_address_missing')
  const marker = `DSHM_BG_HOST_${run.slice(0, 8)}`
  const commands = Object.fromEntries(['running', 'settled'].map(mode => [mode,
    `Write-Output '${marker}_${mode}_BEGIN'; [void](Invoke-RestMethod 'http://127.0.0.1:${address.port}/${run}/${mode}' -TimeoutSec 180); Write-Output '${marker}_${mode}_END'`]))
  const snapshot = () => ({ port: address.port, marker, requests: requests.map(row => ({ ...row })) })
  const operation = (target: any, id = generation) => ({ method: 'remote.jobOutput', sessionId,
    jobId: target.jobId, startedAt: target.startedAt, generation: id, stream: 'stdout', fromByte: 0, maxBytes: 65536 })
  const read = async (target: any) => {
    const frame = await result(operation(target))
    expect(frame.type, JSON.stringify(frame)).toBe('result')
    expect(frame.value).toMatchObject({ state: 'available', coordinate: 'ring', lossy: false })
    return { ...frame.value, text: Buffer.from(frame.value.data, 'base64').toString('utf8') }
  }
  const noReplay = async () => {
    const current = await readSession()
    const calls = current.records.filter((row: any) => row.event.type === 'tool/call' && row.event.data.name === 'pwsh')
    expect(calls).toHaveLength(targets.size)
    for (const target of targets.values()) expect(calls.filter((row: any) => row.event.data.callId === target.callId)).toHaveLength(1)
    expect(current.snapshot.values.permissions.currentValue).toBe('read-only')
    expect(await readFile(profilePath)).toEqual(profile)
    return current
  }
  return {
    marker, commands, snapshot, read,
    async prepare() {
      expect(profile).toBeUndefined(); profile = await readFile(profilePath)
      return { profileSha256: createHash('sha256').update(profile).digest('hex') }
    },
    async started(mode: string, target: any) {
      expect(['running', 'settled']).toContain(mode); expect(targets.has(mode)).toBe(false)
      jobs.set(target.jobId, sessionId)
      await expect.poll(() => requests.some(row => row.mode === mode && !row.closed), { timeout: 30000 }).toBe(true)
      expect(requests.filter(row => row.mode === mode)).toHaveLength(1)
      const current = await readSession()
      const calls = current.records.filter((row: any) => row.event.type === 'tool/call'
        && row.event.seq > target.initialSeq && row.event.data.name === 'pwsh')
      expect(calls).toHaveLength(1)
      const call = calls[0].event.data
      expect(JSON.parse(call.arguments)).toMatchObject({ command: commands[mode], run_in_background: true, timeoutMs: 180000 })
      const results = current.records.filter((row: any) => row.event.type === 'tool/result'
        && row.event.data.message.toolCallId === call.callId)
      expect(results).toHaveLength(1); expect(results[0].event.data.message.isError).toBe(false)
      expect(JSON.stringify(results[0])).toContain(target.jobId)
      targets.set(mode, { ...target, callId: call.callId, retired: false })
      expect((await read(target)).status).toBe('running'); await noReplay()
      return { callId: call.callId, originalJobAndModelToolMatched: true, ...snapshot() }
    },
    release(mode: string) {
      expect(mode).toBe('settled')
      const row = requests.find(value => value.mode === mode), response = responses.get(mode)
      expect(row?.closed).toBe(false); expect(row?.released).toBe(false)
      row!.released = true; response!.writeHead(200, { 'content-type': 'application/json' }).end('null')
      return snapshot()
    },
    async completed(target: any) {
      await expect.poll(async () => (await read(target)).status, { timeout: 30000 }).toBe('completed')
      const value = await read(target)
      expect(value.text).toContain(`${marker}_settled_END`); await noReplay()
      return { originalCompleted: true, text: value.text, bytes: Buffer.byteLength(value.text),
        sha256: createHash('sha256').update(value.text).digest('hex') }
    },
    async stop(mode: string) {
      const target = targets.get(mode), current = await noReplay()
      const output = await read(target)
      expect(output.status).toBe(mode === 'running' ? 'running' : 'completed')
      const checkpoint = { records: current.records, generation, target }
      checkpoints.set(mode, checkpoint)
      const stopped = await stopHost()
      await expect.poll(() => requests.find(row => row.mode === mode)?.closed, { timeout: 15000 }).toBe(true)
      expect(requests.find(row => row.mode === mode)?.released).toBe(mode === 'settled')
      // 已确认旧Host进程树与原生产连接结束；其内存任务不能用新Host复用的id清理。
      jobs.delete(target.jobId)
      return { ...stopped, mode, originalStatus: output.status, originalGeneration: generation,
        sourceConnectionClosed: true, beforeOutputSha256: createHash('sha256').update(output.text).digest('hex'),
        prefixSha256: createHash('sha256').update(JSON.stringify(checkpoint.records)).digest('hex'), ...snapshot() }
    },
    async start() {
      const receipt = await startHost(), old = generation
      generation = receipt.jobControlGeneration
      expect(generation).toBeTypeOf('string'); expect(generation).not.toBe(old)
      return { ...receipt, previousGeneration: old }
    },
    async recovered(mode: string) {
      const checkpoint = checkpoints.get(mode), current = await noReplay(), target = checkpoint.target
      expect(current.records.slice(0, checkpoint.records.length)).toEqual(checkpoint.records)
      const staleRead = await result(operation(target, checkpoint.generation))
      const staleStop = await result({ method: 'remote.jobStop', sessionId, jobId: target.jobId,
        startedAt: target.startedAt, generation: checkpoint.generation })
      const missingRead = await result(operation(target))
      expect(staleRead).toMatchObject({ type: 'error', code: 'remote_job_stale' })
      expect(staleStop).toMatchObject({ type: 'error', code: 'remote_job_stale' })
      expect(missingRead).toMatchObject({ type: 'error', code: 'remote_job_missing' })
      target.retired = true
      expect(requests.filter(row => row.mode === mode)).toHaveLength(1)
      expect(requests.find(row => row.mode === mode)?.closed).toBe(true)
      return { generationChanged: true, oldReadRejected: staleRead.code, oldStopRejected: staleStop.code,
        outputNoLongerRetained: missingRead.code, historyPrefixUnchanged: true, profileUnchanged: true,
        readOnlyPreserved: true, noCommandReplay: true, ...snapshot() }
    },
    async close() {
      // 正式驱动先经公开HTTP清理当前任务再关闭本服务；其生产中转socket此时已关闭。
      for (const response of responses.values()) response.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
      await expect.poll(() => requests.every(row => row.closed), { timeout: 15000 }).toBe(true)
      return snapshot()
    },
  }
}
