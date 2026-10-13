import { createHash } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { expect } from 'vitest'

/** 用真实 pwsh 的本机 HTTP 等待控制生产时机；不替换工具、任务状态或输出接口。 */
export async function officialBackgroundControl({ run, sessionId, readSession, result, generation, jobs, profilePath, processLifecycle = false }: {
  run: string
  sessionId: string
  readSession: () => Promise<any>
  result: (operation: unknown) => Promise<any>
  generation: string
  jobs: Map<string, string>
  profilePath: string
  processLifecycle?: boolean
}) {
  const baseline = await readSession()
  let profile: Buffer | undefined
  const sockets = new Set<Socket>()
  const requests: Array<{ gate: string; closed: boolean; released: boolean }> = []
  const responses = new Map<string, ServerResponse>()
  const gates = ['stop', 'large-start', 'large-finish']
  const server = createServer((request, response) => {
    const gate = gates.find(name => request.url === `/${run}/${name}`)
    if (request.method !== 'GET' || !gate || responses.has(gate)) { response.writeHead(404).end(); return }
    const row = { gate, closed: false, released: false }
    requests.push(row); responses.set(gate, response)
    response.once('close', () => { row.closed = true })
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('official_background_control_address_missing')
  const origin = `http://127.0.0.1:${address.port}/${run}`
  const marker = `DSHM_BG_CONTROL_${run.slice(0, 8)}`
  const wait = (gate: string) => `[void](Invoke-RestMethod '${origin}/${gate}' -TimeoutSec 180)`
  // 本机受限 PowerShell 禁止官方 UTF-8 前导及 .NET 流方法；正常执行现有 Node 来生成 UTF-8，不更改安全策略。
  const producer = `(async()=>{for(let i=0;i<1000;i++){process.stdout.write("${marker}_LINE_"+String(i).padStart(4,"0")+":"+"中文🙂".repeat(40)+"\\n");if(i%40===39)await new Promise(done=>setTimeout(done,250));}})().catch(error=>{console.error(error);process.exitCode=1;});`
  const utf8Producer = `& '${process.execPath.replaceAll("'", "''")}' -e '${producer.replaceAll("'", "''")}'`
  const commands = {
    stop: `Write-Output '${marker}_STOP_BEGIN'; ${wait('stop')}; Write-Output '${marker}_STOP_BAD_END'`,
    large: `Write-Output '${marker}_LARGE_BEGIN'; Write-Error '${marker}_STDERR_BEGIN'; ${wait('large-start')}; ${utf8Producer}; Write-Error '${marker}_STDERR_END'; ${wait('large-finish')}; Write-Output '${marker}_LARGE_END'`,
  }
  const snapshot = () => ({ port: address.port, marker, requests: requests.map(row => ({ ...row })) })
  const startedGate = async (gate: string) => {
    await expect.poll(() => requests.some(row => row.gate === gate && !row.closed), { timeout: 30000 }).toBe(true)
    expect(requests.filter(row => row.gate === gate)).toHaveLength(1)
    return snapshot()
  }
  const release = (gate: string) => {
    const row = requests.find(row => row.gate === gate), response = responses.get(gate)
    expect(row?.closed).toBe(false); expect(row?.released).toBe(false); expect(response).toBeTruthy()
    row!.released = true; response!.writeHead(200, { 'content-type': 'application/json' }).end('null')
    return snapshot()
  }
  const read = async (target: any, stream: string, fromByte = 0) => {
    expect(jobs.get(target.jobId)).toBe(sessionId)
    const frame = await result({ method: 'remote.jobOutput', sessionId, jobId: target.jobId,
      startedAt: target.startedAt, generation, stream, fromByte, maxBytes: 65536 })
    expect(frame.type, frame.type === 'error' ? frame.code : undefined).toBe('result')
    expect(frame.value).toMatchObject({ state: 'available', coordinate: 'ring' })
    return frame.value
  }
  const retained = async (target: any, stream: string) => {
    const parts: Buffer[] = [], frames: any[] = []
    let offset = 0, status: string | undefined
    do {
      const value = await read(target, stream, offset)
      // 保留上限可能连同首个 chunk 裁剪；真实缺口由原接口如实报告。
      if (frames.length) { expect(value.lossy).toBe(false); expect(value.producerGap).toBe(false) }
      expect(value.startOffset).toBeGreaterThanOrEqual(offset)
      expect(value.nextOffset).toBeGreaterThanOrEqual(value.startOffset)
      expect(value.nextOffset - value.startOffset).toBeLessThanOrEqual(65536)
      const data = Buffer.from(value.data, 'base64')
      expect(data.length + value.skippedBytes).toBe(value.nextOffset - value.startOffset)
      parts.push(data); frames.push({ ...value, data: undefined, dataBytes: data.length })
      offset = value.nextOffset; status = value.status
      if (offset === value.totalBytes) break
      expect(frames.length).toBeLessThan(20)
    } while (true)
    const raw = Buffer.concat(parts), text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    return { stream, text, bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex'),
      frames, status, offset, total: frames.at(-1).totalBytes, earliest: frames[0].startOffset }
  }
  return {
    controlOnly: true, processLifecycle, marker, commands, snapshot, startedGate, release, read, retained,
    async prepare() {
      // 通用真实手机验收先切换模型；后台专项只保护该操作完成后的配置。
      expect(profile).toBeUndefined(); profile = await readFile(profilePath)
      return { profileSha256: createHash('sha256').update(profile).digest('hex') }
    },
    async started({ stop, large, initialSeq }: any) {
      for (const target of [stop, large]) {
        expect(target.startedAt).toBeTypeOf('number'); jobs.set(target.jobId, sessionId)
      }
      const current = await readSession()
      expect(current.records.slice(0, baseline.records.length)).toEqual(baseline.records)
      const calls = current.records.filter((row: any) => row.event.type === 'tool/call' && row.event.seq > initialSeq)
      expect(calls).toHaveLength(2)
      const callIds: string[] = []
      for (const [mode, target] of Object.entries({ stop, large }) as Array<[keyof typeof commands, any]>) {
        const matched = calls.filter((row: any) => row.event.data.name === 'pwsh'
          && JSON.parse(row.event.data.arguments).command === commands[mode])
        expect(matched).toHaveLength(1)
        expect(JSON.parse(matched[0].event.data.arguments)).toMatchObject({ run_in_background: true, timeoutMs: 180000 })
        const settled = current.records.filter((row: any) => row.event.type === 'tool/result'
          && row.event.data.message.toolCallId === matched[0].event.data.callId)
        expect(settled).toHaveLength(1); expect(settled[0].event.data.message.isError).toBe(false)
        expect(JSON.stringify(settled[0])).toContain(target.jobId); callIds.push(matched[0].event.data.callId)
        expect((await read(target, 'stdout')).status).toBe('running')
      }
      await startedGate('stop'); await startedGate('large-start')
      expect(current.snapshot.values.permissions.currentValue).toBe('read-only')
      expect(profile).toBeTruthy()
      expect(await readFile(profilePath)).toEqual(profile)
      return { actualModelToolsVerified: true, callIds, historyPrefixUnchanged: true, ...snapshot() }
    },
    async stopped({ stop, large }: any) {
      await expect.poll(async () => (await read(stop, 'stdout')).status, { timeout: 30000 }).toBe('killed')
      await expect.poll(() => requests.find(row => row.gate === 'stop')?.closed, { timeout: 15000 }).toBe(true)
      expect(requests.find(row => row.gate === 'stop')?.released).toBe(false)
      const killed = await retained(stop, 'stdout'), sibling = await read(large, 'stdout')
      expect(killed.text).toContain(`${marker}_STOP_BEGIN`)
      expect(killed.text).not.toContain(`${marker}_STOP_BAD_END`)
      expect(sibling.status).toBe('running')
      return { actualTerminalStatus: 'killed', actualProducerConnectionClosed: true,
        noPostStopEnd: true, otherJobStillRunning: true, stoppedOutputSha256: killed.sha256 }
    },
    async final({ stop, large }: any) {
      await expect.poll(async () => (await read(large, 'stdout')).status, { timeout: 30000 }).toBe('completed')
      const stdout = await retained(large, 'stdout'), stderr = await retained(large, 'stderr')
      expect(stdout.total).toBeGreaterThan(400000); expect(stdout.earliest).toBeGreaterThan(0)
      // 模型消费已完成任务后，官方可收缩缓存；完整保留尾部及 UTF-8 在运行中门控阶段另验。
      expect(stdout.text).toContain(`${marker}_LARGE_END`)
      expect(stdout.text).not.toContain(`${marker}_STDERR_END`)
      expect(stderr.text).toContain(`${marker}_STDERR_END`)
      expect(stderr.text).not.toContain(`${marker}_LINE_0999:`)
      expect((await read(stop, 'stdout')).status).toBe('killed')
      const current = await readSession()
      expect(current.records.slice(0, baseline.records.length)).toEqual(baseline.records)
      expect(current.snapshot.values.permissions.currentValue).toBe('read-only')
      expect(await readFile(profilePath)).toEqual(profile)
      const calls = current.records.filter((row: any) => row.event.type === 'tool/call'
        && row.event.seq > baseline.snapshot.asOfSeq)
      const commandsCalled = calls.filter((row: any) => row.event.data.name === 'pwsh')
      expect(commandsCalled).toHaveLength(2)
      expect(commandsCalled.every((row: any) => row.event.data.name === 'pwsh'
        && Object.values(commands).includes(JSON.parse(row.event.data.arguments).command))).toBe(true)
      const reads = calls.filter((row: any) => row.event.data.name !== 'pwsh')
      expect(reads.every((row: any) => row.event.data.name === 'job_output'
        && [stop.jobId, large.jobId].includes(JSON.parse(row.event.data.arguments).job_id))).toBe(true)
      for (const gate of gates) {
        expect(requests.filter(row => row.gate === gate)).toHaveLength(1)
        expect(requests.find(row => row.gate === gate)?.closed).toBe(true)
      }
      return { stdout, stderr, actualTerminalStatus: 'completed', cancelledJobStillKilled: true,
        originalHistoryPrefixUnchanged: true, profileUnchanged: true, readOnlyPreserved: true,
        noCommandReplay: true, originalJobOutputCalls: reads.map((row: any) => ({ seq: row.event.seq,
          callId: row.event.data.callId, jobId: JSON.parse(row.event.data.arguments).job_id })), ...snapshot() }
    },
    async close() {
      for (const response of responses.values()) response.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
      await expect.poll(() => requests.every(row => row.closed), { timeout: 15000 }).toBe(true)
      return snapshot()
    },
  }
}
