import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { expect } from 'vitest'
import { clientFrameSchema } from '@dsh-mobile/protocol'

type Identity = { sessionId: string; jobId: string; startedAt: number; generation: string }
type Write = { id: string; bridgeId: number; operation: any; forwarded: boolean }
type Race = { identity: Identity; held: Array<{ write: Write; send: () => void }>; receipts: any[]; released: boolean }

/** 只在外部截断真实停止请求/回执或同时释放原报文，不改鉴权、任务服务或终态。 */
export async function officialJobStopTransport(frontPort: number, backendPort: number) {
  assert.equal(frontPort, 16956); assert.equal(backendPort, 16957)
  const bridges = new Set<{ front: WebSocket; back: WebSocket }>(), writes: Write[] = [], cuts: any[] = [], races: Race[] = []
  let target: (Identity & { mode: 'before-forward' | 'after-receipt' }) | undefined
  let race: Race | undefined, paused = false, closed = false, nextId = 0, cutIndex = 0
  const matches = (operation: any, identity: Identity) => Object.entries(identity).every(([key, value]) => operation[key] === value)
  const server = createServer((req, res) => {
    const forwarded = httpRequest({ hostname: '127.0.0.1', port: backendPort, path: req.url,
      method: req.method, headers: req.headers }, reply => {
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
      const bridge = { front, back }, bridgeId = ++nextId
      bridges.add(bridge)
      const queue: Array<{ raw: RawData; binary: boolean }> = []
      let queuedBytes = 0, closing = false, held: Write | undefined, heldBytes = 0
      const heldTypes: string[] = []
      const terminate = () => { if (closing) return; closing = true; front.terminate(); back.terminate(); bridges.delete(bridge) }
      const parse = (raw: RawData, binary: boolean) => { if (!binary) try { return JSON.parse(raw.toString()) } catch {} }
      const cut = (write: Write, receipt?: unknown) => {
        assert.ok(target)
        const value = { ...structuredClone(write), mode: target.mode, receipt, withheldTypes: [...heldTypes], socketClosed: false }
        cuts.push(value); target = undefined; paused = true
        const ended = Promise.all([once(front, 'close'), once(back, 'close')])
        terminate(); void ended.then(() => { value.socketClosed = true }).catch(() => {})
      }
      front.on('message', (raw, binary) => {
        const parsed = clientFrameSchema.safeParse(parse(raw, binary))
        const frame = parsed.success && parsed.data.type === 'request' ? parsed.data : undefined
        if (req.url === '/v1/device/socket' && frame?.operation.method === 'remote.jobStop') {
          assert.ok(writes.length < 32)
          const write = { id: frame.id, bridgeId, operation: structuredClone(frame.operation), forwarded: false }
          writes.push(write)
          if (race && !race.released) {
            assert.ok(matches(frame.operation, race.identity)); assert.ok(race.held.length < 2)
            assert.equal(back.readyState, WebSocket.OPEN)
            race.held.push({ write, send: () => { write.forwarded = true; back.send(raw, { binary }) } }); return
          }
          if (target) {
            const { mode, ...identity } = target
            assert.ok(matches(frame.operation, identity)); assert.equal(back.readyState, WebSocket.OPEN)
            if (mode === 'before-forward') { cut(write); return }
            held = write
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
        const frame = parse(raw, binary)
        if (race?.released && race.held.some(item => item.write.bridgeId === bridgeId && item.write.id === frame?.id)
          && ['result', 'error'].includes(frame.type)) {
          assert.ok(!race.receipts.some(item => item.id === frame.id)); race.receipts.push(frame)
        }
        if (held) {
          heldBytes += Buffer.byteLength(raw.toString()); heldTypes.push(frame?.type ?? 'binary')
          assert.ok(heldTypes.length <= 256 && heldBytes <= 8 * 1024 * 1024)
          if (frame?.id === held.id && ['result', 'error'].includes(frame.type)) cut(held, frame)
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
    arm(identity: Identity, mode: 'before-forward' | 'after-receipt') {
      assert.ok(!target && !paused && !closed); target = { ...identity, mode }; cutIndex = cuts.length
    },
    async cut() { await expect.poll(() => cuts[cutIndex]?.socketClosed, { timeout: 30000 }).toBe(true); return structuredClone(cuts[cutIndex]) },
    resume() { assert.ok(paused && !closed); paused = false },
    writes(identity: Identity) { return structuredClone(writes.filter(write => matches(write.operation, identity))) },
    raceArm(identity: Identity) {
      assert.ok(!target && !paused && !closed && !race)
      race = { identity, held: [], receipts: [], released: false }; races.push(race)
    },
    async raceHeld(count: number) { await expect.poll(() => race?.held.length, { timeout: 15000 }).toBe(count) },
    async raceRelease() {
      await expect.poll(() => race?.held.length, { timeout: 15000 }).toBe(2)
      const current = race!; assert.equal(current.released, false)
      assert.equal(new Set(current.held.map(item => item.write.bridgeId)).size, 2)
      current.released = true
      for (const item of current.held) item.send()
      await expect.poll(() => current.receipts.length, { timeout: 15000 }).toBe(2)
      return { writes: structuredClone(current.held.map(item => item.write)), receipts: structuredClone(current.receipts) }
    },
    snapshot() { return { externalProxy: true, frontPort, backendPort, writes: structuredClone(writes), cuts: structuredClone(cuts),
      races: races.map(item => ({ identity: item.identity, released: item.released,
        writes: structuredClone(item.held.map(held => held.write)), receipts: structuredClone(item.receipts) })) } },
    async close() {
      if (closed) return; closed = true
      for (const bridge of bridges) { bridge.front.terminate(); bridge.back.terminate() }
      bridges.clear(); const ended = once(server, 'close'); server.close(); server.closeAllConnections(); await ended; websocket.close()
    },
  }
}
