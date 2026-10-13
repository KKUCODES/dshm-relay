import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { expect } from 'vitest'
import { clientFrameSchema } from '@dsh-mobile/protocol'

type Target = { sessionId: string; beforeSeq: number }
type Read = { id: string; bridgeId: number; request: any; forwarded: boolean;
  receipt?: any; cancelled: boolean; released: boolean; lateReceiptDelivered?: boolean }

/** 只延迟指定历史请求的真实回执，其他原报文照常中转；不替换服务或伪造分页。 */
export async function officialHistoryTransport(frontPort: number, backendPort: number) {
  assert.equal(frontPort, 16956); assert.equal(backendPort, 16957)
  const bridges = new Set<{ front: WebSocket; back: WebSocket }>(), reads: Read[] = []
  let target: Target | undefined, active: { read: Read; release: () => void } | undefined
  let closed = false, nextId = 0, armedIndex = 0
  const parse = (raw: RawData, binary: boolean) => {
    if (!binary) try { return JSON.parse(raw.toString()) } catch {}
  }
  const server = createServer((req, res) => {
    const forwarded = httpRequest({ hostname: '127.0.0.1', port: backendPort, path: req.url,
      method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res) })
    forwarded.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.on('aborted', () => forwarded.destroy()); req.pipe(forwarded)
  })
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    if (closed || !req.url?.startsWith('/v1/')) { socket.destroy(); return }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) =>
      !['connection', 'upgrade'].includes(key) && !key.startsWith('sec-websocket-')))
    websocket.handleUpgrade(req, socket, head, front => {
      const back = new WebSocket(`ws://127.0.0.1:${backendPort}${req.url}`, { headers, perMessageDeflate: false })
      const bridge = { front, back }, bridgeId = ++nextId
      bridges.add(bridge)
      const queue: { raw: RawData; binary: boolean }[] = []
      let closing = false, queuedBytes = 0
      const terminate = () => { if (closing) return; closing = true; front.terminate(); back.terminate(); bridges.delete(bridge) }
      front.on('message', (raw, binary) => {
        const observed = parse(raw, binary), parsed = clientFrameSchema.safeParse(observed)
        const frame = parsed.success && parsed.data.type === 'request' ? parsed.data : undefined
        if (observed?.type === 'cancel') {
          const read = reads.find(item => item.bridgeId === bridgeId && item.id === observed.id)
          if (read) read.cancelled = true
        }
        if (req.url === '/v1/device/socket' && frame?.operation.method === 'remote.rpc'
          && frame.operation.endpoint === 'session/page') {
          const request = (frame.operation.payload as any)?.args?.request
          if (request?.beforeSeq !== undefined) {
            const read: Read = { id: frame.id, bridgeId, request: structuredClone(request),
              forwarded: true, cancelled: false, released: false }
            reads.push(read); assert.ok(reads.length <= 16)
            if (target) {
              assert.equal(request.address.sessionId, target.sessionId)
              assert.equal(request.beforeSeq, target.beforeSeq)
              assert.equal(back.readyState, WebSocket.OPEN)
              active = { read, release: () => {} }; target = undefined
            }
          }
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
        if (active && active.read.bridgeId === bridgeId && active.read.id === frame?.id
          && ['result', 'error'].includes(frame.type)) {
          assert.equal(active.read.receipt, undefined)
          active.read.receipt = structuredClone(frame)
          const read = active.read
          active.release = () => {
            read.released = true; read.lateReceiptDelivered = front.readyState === WebSocket.OPEN
            if (read.lateReceiptDelivered) front.send(raw, { binary })
          }
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
    arm(value: Target) { assert.ok(!target && !active && !closed); target = value; armedIndex = reads.length },
    async held() {
      await expect.poll(() => !!reads[armedIndex]?.receipt, { timeout: 20000 }).toBe(true)
      const read = reads[armedIndex]
      assert.ok(read)
      expect(read.receipt).toMatchObject({ type: 'result', value: { ok: true } })
      expect(read.receipt.value.value.records.length).toBeGreaterThan(0)
      return structuredClone(read)
    },
    release() { assert.ok(active?.read.receipt); const held = active; active = undefined; held.release(); return structuredClone(held.read) },
    snapshot() { return { externalProxy: true, frontPort, backendPort, reads: structuredClone(reads), closed } },
    async close() {
      if (closed) return; closed = true
      for (const bridge of bridges) { bridge.front.terminate(); bridge.back.terminate() }
      bridges.clear(); const done = once(server, 'close'); server.close(); server.closeAllConnections(); await done; websocket.close()
    },
  }
}
