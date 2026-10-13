import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { expect } from 'vitest'
import type { officialJobStopTransport } from './official-job-stop-transport.js'

/** ASCII等待源只用于证明原命令活着/已退出，任务状态始终来自官方接口。 */
export async function officialBackgroundStop({ run, sessionId, readSession, result, profilePath, generation, jobs, transport }: {
  run: string; sessionId: string; readSession: () => Promise<any>; result: (operation: unknown) => Promise<any>
  profilePath: string; generation: string; jobs: Map<string, string>
  transport: Awaited<ReturnType<typeof officialJobStopTransport>>
}) {
  let profile: Buffer | undefined, peerResult: Promise<any> | undefined
  const modes = ['before-forward', 'after-receipt', 'race'] as const
  const targets = new Map<string, any>(), sockets = new Set<Socket>()
  const requests: Array<{ mode: string; closed: boolean }> = []
  const server = createServer((request, response) => {
    const mode = modes.find(mode => request.url === `/${run}/${mode}`)
    if (request.method !== 'GET' || !mode || requests.some(row => row.mode === mode)) { response.writeHead(404).end(); return }
    const row = { mode, closed: false }; requests.push(row); response.once('close', () => { row.closed = true })
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('official_background_stop_address_missing')
  const marker = `DSHM_BG_STOP_${run.slice(0, 8)}`
  const commands = Object.fromEntries(modes.map(mode => [mode,
    `Write-Output '${marker}_${mode}_BEGIN'; [void](Invoke-RestMethod 'http://127.0.0.1:${address.port}/${run}/${mode}' -TimeoutSec 180); Write-Output '${marker}_${mode}_END'`]))
  const identity = (mode: string) => ({ sessionId, jobId: targets.get(mode).jobId, startedAt: targets.get(mode).startedAt, generation })
  const read = async (mode: string) => {
    const frame = await result({ method: 'remote.jobOutput', ...identity(mode), stream: 'stdout', fromByte: 0, maxBytes: 65536 })
    expect(frame).toMatchObject({ type: 'result', value: { state: 'available', coordinate: 'ring', lossy: false } })
    return { ...frame.value, text: Buffer.from(frame.value.data, 'base64').toString('utf8') }
  }
  const unchanged = async () => {
    const current = await readSession()
    const calls = current.records.filter((row: any) => row.event.type === 'tool/call' && row.event.data.name === 'pwsh')
    expect(calls).toHaveLength(targets.size)
    for (const target of targets.values()) {
      expect(calls.filter((row: any) => row.event.data.callId === target.callId)).toHaveLength(1)
      expect(current.records.slice(0, target.prefix.length)).toEqual(target.prefix)
    }
    expect(current.snapshot.values.permissions.currentValue).toBe('read-only')
    expect(await readFile(profilePath)).toEqual(profile)
    return current
  }
  const snapshot = () => ({ port: address.port, marker, requests: requests.map(row => ({ ...row })) })
  return {
    marker, commands, snapshot,
    async prepare() { profile = await readFile(profilePath); return { profileSha256: createHash('sha256').update(profile).digest('hex') } },
    async started(mode: string, target: any) {
      expect(modes).toContain(mode); expect(targets.has(mode)).toBe(false); jobs.set(target.jobId, sessionId)
      await expect.poll(() => requests.some(row => row.mode === mode && !row.closed), { timeout: 30000 }).toBe(true)
      const current = await readSession(), calls = current.records.filter((row: any) => row.event.type === 'tool/call'
        && row.event.seq > target.initialSeq && row.event.data.name === 'pwsh')
      expect(calls).toHaveLength(1)
      const call = calls[0].event.data
      expect(JSON.parse(call.arguments)).toMatchObject({ command: commands[mode], run_in_background: true, timeoutMs: 180000 })
      const results = current.records.filter((row: any) => row.event.type === 'tool/result' && row.event.data.message.toolCallId === call.callId)
      expect(results).toHaveLength(1); expect(results[0].event.data.message.isError).toBe(false)
      expect(JSON.stringify(results[0])).toContain(target.jobId)
      targets.set(mode, { ...target, callId: call.callId, prefix: current.records })
      expect((await read(mode)).status).toBe('running'); await unchanged()
      return { originalJobAndModelToolMatched: true, callId: call.callId, ...snapshot() }
    },
    arm(mode: 'before-forward' | 'after-receipt') { transport.arm(identity(mode), mode) },
    async cut(mode: 'before-forward' | 'after-receipt') {
      const cut = await transport.cut(); expect(cut.mode).toBe(mode)
      expect(cut.forwarded).toBe(mode === 'after-receipt')
      if (mode === 'after-receipt') expect(cut.receipt).toMatchObject({ type: 'result', value: { status: 'requested' } })
      if (mode === 'before-forward') {
        expect((await read(mode)).status).toBe('running'); expect(requests.find(row => row.mode === mode)?.closed).toBe(false)
      } else await expect.poll(async () => (await read(mode)).status, { timeout: 30000 }).toBe('killed')
      await unchanged(); return cut
    },
    resume: () => transport.resume(),
    async afterReconnect(mode: string) {
      const writes = transport.writes(identity(mode)); expect(writes).toHaveLength(1)
      const output = await read(mode); expect(output.status).toBe(mode === 'before-forward' ? 'running' : 'killed')
      await unchanged(); return { originalStatus: output.status, stopRequests: writes.length, noAutomaticReplay: true }
    },
    raceArm() { transport.raceArm(identity('race')) },
    raceHeld: (count: number) => transport.raceHeld(count),
    startPeer() {
      expect(peerResult).toBeUndefined()
      peerResult = result({ method: 'remote.jobStop', ...identity('race') })
      // 及时观察拒绝，最终仍要求真实第二条连接的正式回执。
      void peerResult.catch(() => {}); return { started: true }
    },
    raceRelease: () => transport.raceRelease(),
    async settled(mode: string) {
      await expect.poll(async () => (await read(mode)).status, { timeout: 30000 }).toBe('killed')
      await expect.poll(() => requests.find(row => row.mode === mode)?.closed, { timeout: 15000 }).toBe(true)
      const output = await read(mode), writes = transport.writes(identity(mode))
      expect(output.text).toContain(`${marker}_${mode}_BEGIN`); expect(output.text).not.toContain(`${marker}_${mode}_END`)
      expect(writes).toHaveLength(mode === 'after-receipt' ? 1 : 2)
      expect(writes.filter(write => write.forwarded)).toHaveLength(mode === 'race' ? 2 : 1)
      if (mode === 'race') {
        expect(new Set(writes.map(write => write.bridgeId)).size).toBe(2)
        const peer = await peerResult; expect(peer.type).toBe('result')
        expect(['requested', 'already-stopping', 'already-finished']).toContain(peer.value.status)
        const race = transport.snapshot().races[0]
        expect(race).toBeTruthy()
        const receipts = race!.receipts
        expect(receipts.filter((frame: any) => frame.type === 'result' && frame.value.status === 'requested')).toHaveLength(1)
        expect(receipts.every((frame: any) => frame.type === 'result' && ['requested', 'already-stopping', 'already-finished'].includes(frame.value.status))).toBe(true)
      }
      await unchanged()
      return { originalStatus: output.status, sourceClosed: true, noEndMarker: true, originalHistoryPrefixUnchanged: true,
        profileUnchanged: true, readOnlyPreserved: true, noCommandReplay: true, writes,
        text: output.text, bytes: Buffer.byteLength(output.text), sha256: createHash('sha256').update(output.text).digest('hex'), ...snapshot() }
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
      await expect.poll(() => requests.every(row => row.closed), { timeout: 15000 }).toBe(true); return snapshot()
    },
  }
}
