import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { expect } from 'vitest'
import { clientFrameSchema } from '@dsh-mobile/protocol'

type Target = { target?: 'web-search-deepseek' | { provider: string }; destination: string; mode: 'before-forward' | 'after-receipt'; holdUntilClientCloses?: boolean }
type Write = { id: string; bridgeId: number; operation: any; forwarded: boolean }
type Bridge = { front: WebSocket; back: WebSocket; write?: Write; heldTypes: string[]; heldBytes: number }
type Race = { target: Target['target']; destinations: string[]; held: { write: Write; send: () => void }[]; receipts: any[]; released: boolean }

/** 外部传输故障只丢弃真实请求/回执；不替换生产服务或生成成功响应。 */
export async function officialEndpointTransport(frontPort: number, backendPort: number) {
  assert.equal(frontPort, 16956); assert.equal(backendPort, 16957)
  const bridges = new Set<Bridge>(), writes: Write[] = [], cuts: any[] = []
  let target: Target | undefined, paused = false, closed = false, nextId = 0, cutIndex = 0
  const races: Race[] = []
  let race: Race | undefined
  const server = createServer((req, res) => {
    const forwarded = httpRequest({ hostname: '127.0.0.1', port: backendPort,
      path: req.url, method: req.method, headers: req.headers }, reply => {
      res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res)
    })
    forwarded.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.on('aborted', () => forwarded.destroy()); req.pipe(forwarded)
  })
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    if (closed || (paused && req.url === '/v1/device/socket') || !req.url?.startsWith('/v1/')) { socket.destroy(); return }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) =>
      !['connection', 'upgrade'].includes(key) && !key.startsWith('sec-websocket-')))
    websocket.handleUpgrade(req, socket, head, front => {
      const back = new WebSocket(`ws://127.0.0.1:${backendPort}${req.url}`, { headers, perMessageDeflate: false })
      const bridge: Bridge = { front, back, heldTypes: [], heldBytes: 0 }, bridgeId = ++nextId
      bridges.add(bridge)
      const queue: { raw: RawData; binary: boolean }[] = []
      let queuedBytes = 0, closing = false
      const terminate = () => { if (closing) return; closing = true; front.terminate(); back.terminate(); bridges.delete(bridge) }
      const parse = (raw: RawData, binary: boolean) => {
        if (binary) return undefined
        try { return JSON.parse(raw.toString()) } catch { return undefined }
      }
      const cut = (write: Write, receipt?: unknown) => {
        const value = { ...structuredClone(write), mode: target!.mode, receipt,
          holdUntilClientCloses: target!.holdUntilClientCloses === true, withheldTypes: [...bridge.heldTypes], socketClosed: false }
        cuts.push(value); target = undefined; paused = true
        const done = Promise.all([once(front, 'close'), once(back, 'close')])
        if (!value.holdUntilClientCloses) terminate()
        void done.then(() => { value.socketClosed = true }).catch(() => {})
      }
      front.on('message', (raw, binary) => {
        const parsed = clientFrameSchema.safeParse(parse(raw, binary))
        const frame = parsed.success && parsed.data.type === 'request' ? parsed.data : undefined
        if (req.url === '/v1/device/socket' && frame?.operation.method === 'remote.endpointWrite') {
          assert.ok(writes.length < 64)
          const write = { id: frame.id, bridgeId, operation: structuredClone(frame.operation), forwarded: false }
          writes.push(write)
          if (race && !race.released) {
            assert.deepEqual(frame.operation.target, race.target)
            assert.equal(frame.operation.change.op, 'set')
            assert.ok(race.destinations.includes(frame.operation.change.value))
            assert.ok(race.held.length < 2); assert.equal(back.readyState, WebSocket.OPEN)
            race.held.push({ write, send: () => { write.forwarded = true; back.send(raw, { binary }) } })
            return
          }
          if (target) {
            assert.deepEqual(frame.operation.target, target.target)
            assert.deepEqual(frame.operation.change, { op: 'set', value: target.destination })
            assert.equal(back.readyState, WebSocket.OPEN)
            if (target.mode === 'before-forward') { cut(write); return }
            bridge.write = write
          }
          write.forwarded = true
        }
        if (back.readyState === WebSocket.OPEN) back.send(raw, { binary })
        else if (back.readyState === WebSocket.CONNECTING) {
          queuedBytes += Buffer.byteLength(raw.toString())
          if (queue.length >= 256 || queuedBytes > 8 * 1024 * 1024) { terminate(); return }
          queue.push({ raw, binary })
        }
      })
      back.on('open', () => { for (const item of queue.splice(0)) back.send(item.raw, { binary: item.binary }); queuedBytes = 0 })
      back.on('message', (raw, binary) => {
        const observed = parse(raw, binary)
        if (race?.released && race.held.some(item => item.write.id === observed?.id) && ['result', 'error'].includes(observed.type)) {
          assert.ok(!race.receipts.some(item => item.id === observed.id)); race.receipts.push(observed)
        }
        if (bridge.write) {
          const frame = parse(raw, binary)
          bridge.heldBytes += Buffer.byteLength(raw.toString()); bridge.heldTypes.push(frame?.type ?? 'binary')
          assert.ok(bridge.heldTypes.length <= 256 && bridge.heldBytes <= 8 * 1024 * 1024)
          if (frame?.id === bridge.write.id && ['result', 'error'].includes(frame.type)) cut(bridge.write, frame)
          return
        }
        if (front.readyState === WebSocket.OPEN) front.send(raw, { binary })
      })
      const relayClose = (peer: WebSocket, code: number, reason: Buffer) => {
        if (closing) return; closing = true; bridges.delete(bridge)
        if (peer.readyState === WebSocket.OPEN && code >= 1000 && ![1005, 1006, 1015].includes(code)) peer.close(code, reason)
        else peer.terminate()
      }
      front.on('close', (code, reason) => relayClose(back, code, reason))
      back.on('close', (code, reason) => relayClose(front, code, reason))
      front.on('error', terminate); back.on('error', terminate)
    })
  })
  server.listen(frontPort, '127.0.0.1'); await once(server, 'listening')
  return {
    arm(value: Target) { assert.ok(!target && !paused && !closed); target = value; cutIndex = cuts.length },
    async held() { await expect.poll(() => !!cuts[cutIndex], { timeout: 30000 }).toBe(true); return structuredClone(cuts[cutIndex]) },
    async cut() { await expect.poll(() => cuts[cutIndex]?.socketClosed, { timeout: 30000 }).toBe(true); return structuredClone(cuts[cutIndex]) },
    resume() { assert.ok(paused && !closed); paused = false },
    writes() { return structuredClone(writes) },
    raceArm(value: { target: Target['target']; destinations: string[] }) {
      assert.ok(!target && !paused && !closed && (!race || race.receipts.length === 2))
      assert.equal(new Set(value.destinations).size, 2)
      race = { ...value, held: [], receipts: [], released: false }; races.push(race)
    },
    async raceRelease(first: string) {
      await expect.poll(() => race?.held.length, { timeout: 15000 }).toBe(2)
      const active = race!; assert.equal(active.released, false)
      assert.equal(new Set(active.held.map(item => item.write.bridgeId)).size, 2)
      assert.equal(new Set(active.held.map(item => item.write.operation.expectedRevision)).size, 1)
      assert.equal(new Set(active.held.map(item => item.write.operation.snapshot)).size, 2)
      assert.ok(active.destinations.includes(first)); active.released = true
      // 两个真实写入均已在途，同步释放原始报文；不生成结果、不串行等第一个完成。
      const ordered = [...active.held].sort((a, b) => Number(b.write.operation.change.value === first) - Number(a.write.operation.change.value === first))
      for (const item of ordered) item.send()
      await expect.poll(() => active.receipts.length, { timeout: 15000 }).toBe(2)
      return { first, writes: structuredClone(ordered.map(item => item.write)), receipts: structuredClone(active.receipts) }
    },
    snapshot() { return { externalProxy: true, frontPort, backendPort, writes: structuredClone(writes), cuts: structuredClone(cuts),
      races: races.map(item => ({ target: item.target, destinations: item.destinations, released: item.released,
        writes: structuredClone(item.held.map(held => held.write)), receipts: structuredClone(item.receipts) })) } },
    async close() {
      if (closed) return; closed = true
      for (const bridge of bridges) { bridge.front.terminate(); bridge.back.terminate() }
      bridges.clear(); const ended = once(server, 'close'); server.close(); server.closeAllConnections(); await ended; websocket.close()
    },
  }
}
