import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { expect } from 'vitest'
import { clientFrameSchema } from '@dsh-mobile/protocol'

type Target = { sessionId: string; text: string; fileCount?: number }
type Write = { id: string; bridgeId: number; request: any; forwarded: boolean }

/** 外部截断真实消息或附件上传；电脑退出的真实错误仍交给手机处理。 */
export async function officialPromptTransport(frontPort: number, backendPort: number) {
  assert.equal(frontPort, 16956); assert.equal(backendPort, 16957)
  const bridges = new Set<{ front: WebSocket; back: WebSocket }>(), writes: Write[] = [], cuts: any[] = []
  const uploads: any[] = [], uploadCuts: any[] = []
  let uploadTarget: { sessionId: string; name: string; waitForProcessExit: boolean; waitForHostExit: boolean } | undefined, uploadCutIndex = 0
  let target: (Target & { mode: 'before-forward' | 'after-receipt'; waitForProcessExit: boolean; waitForHostExit: boolean }) | undefined
  let releaseHostGate: (() => void) | undefined
  let releaseUploadHostGate: (() => void) | undefined
  let paused = false, closed = false, nextId = 0, cutIndex = 0
  const matches = (request: any, item: Target) => request.sessionId === item.sessionId
    && request.content.length === 1 + (item.fileCount ?? 0) && request.content[0].type === 'text'
    && request.content[0].text === item.text && request.content.slice(1).every((part: any) =>
      part.type === 'file' && typeof part.receiptId === 'string')
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
      const uploadRows = new Map<string, { row: any; hash: ReturnType<typeof createHash> }>()
      let partialUpload: any, uploadCutTaken = false, partialHostCut: any
      let queuedBytes = 0, closing = false, held: Write | undefined, heldBytes = 0
      const heldTypes: string[] = []
      let hostDisconnectFrames: any[] = []
      let hostHeld = false
      const terminate = () => { if (closing) return; closing = true; front.terminate(); back.terminate(); bridges.delete(bridge) }
      const parse = (raw: RawData, binary: boolean) => { if (!binary) try { return JSON.parse(raw.toString()) } catch {} }
      const cut = (write: Write, receipt?: unknown) => {
        assert.ok(target)
        const naturalExit = target.waitForProcessExit || target.waitForHostExit
        const value = { ...structuredClone(write), mode: target.mode, receipt, withheldTypes: [...heldTypes],
          socketClosed: false, ...(target.waitForHostExit ? { awaitingHostExit: true, hostDisconnectFrames }
            : naturalExit ? { awaitingProcessExit: true } : {}) }
        if (target.waitForHostExit) releaseHostGate = () => { held = undefined }
        cuts.push(value); target = undefined; paused = true
        const ended = Promise.all([once(front, 'close'), once(back, 'close')])
        if (!naturalExit) terminate()
        void ended.then(() => { value.socketClosed = true }).catch(() => {})
      }
      front.on('message', (raw, binary) => {
        const parsed = clientFrameSchema.safeParse(parse(raw, binary))
        const frame = parsed.success && parsed.data.type === 'request' ? parsed.data : undefined
        if (req.url === '/v1/device/socket' && frame?.operation.method === 'remote.upload') {
          assert.ok(uploads.length < 16)
          const row = { id: frame.id, bridgeId, operation: structuredClone(frame.operation),
            chunks: [] as any[], forwardedBytes: 0, endForwarded: false }
          uploads.push(row); uploadRows.set(frame.id, { row, hash: createHash('sha256') })
          if (uploadTarget && frame.operation.sessionId === uploadTarget.sessionId && frame.operation.name === uploadTarget.name) {
            assert.equal(back.readyState, WebSocket.OPEN); partialUpload = row
          }
        }
        const uploadFrame = parsed.success && ['uploadChunk', 'uploadEnd'].includes(parsed.data.type) ? parsed.data : undefined
        const upload = uploadFrame ? uploadRows.get(uploadFrame.id) : undefined
        if (upload && uploadFrame) {
          const held = upload.row === partialUpload && upload.row.forwardedBytes > 0
          if (uploadFrame.type === 'uploadChunk') {
            const bytes = Buffer.from(uploadFrame.data, 'base64')
            assert.equal(bytes.toString('base64'), uploadFrame.data)
            upload.row.chunks.push({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), forwarded: !held })
            if (!held) { upload.row.forwardedBytes += bytes.length; upload.hash.update(bytes) }
          } else if (!held) {
            upload.row.endForwarded = true; upload.row.sha256 = upload.hash.digest('hex')
          }
          if (held) return
        }
        if (req.url === '/v1/device/socket' && frame?.operation.method === 'remote.rpc'
          && frame.operation.endpoint === 'session/prompt') {
          const request = (frame.operation.payload as any).args.request
          assert.ok(writes.length < 32)
          const write = { id: frame.id, bridgeId, request: structuredClone(request), forwarded: false }
          writes.push(write)
          if (target && matches(request, target)) {
            assert.equal(back.readyState, WebSocket.OPEN)
            heldBytes = 0; heldTypes.length = 0; hostDisconnectFrames = []
            hostHeld = target.waitForHostExit
            if (target.mode === 'before-forward') { held = write; cut(write); return }
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
        const upload = frame?.id ? uploadRows.get(frame.id) : undefined
        if (upload && ['result', 'error'].includes(frame.type)) upload.row.receipt = structuredClone(frame)
        // 首块已经由原Host消费后才切断，后续块和结束帧被扣住，不能把完整上传误当成中断。
        if (partialUpload && !uploadCutTaken && upload?.row === partialUpload && partialUpload.forwardedBytes > 0
          && frame?.type === 'event' && frame.value?.type === 'credit' && frame.value.count === 1) {
          const waitForProcessExit = uploadTarget?.waitForProcessExit === true
          const waitForHostExit = uploadTarget?.waitForHostExit === true
          const value = { ...structuredClone(partialUpload), consumedCredit: structuredClone(frame), socketClosed: false,
            ...(waitForHostExit ? { awaitingHostExit: true, hostDisconnectFrames: [] }
              : waitForProcessExit ? { awaitingProcessExit: true } : {}) }
          uploadCuts.push(value); uploadTarget = undefined; uploadCutTaken = true; paused = true
          if (waitForHostExit) {
            partialHostCut = value; releaseUploadHostGate = () => { partialUpload = undefined }
          }
          const ended = Promise.all([once(front, 'close'), once(back, 'close')])
          if (!waitForProcessExit && !waitForHostExit) terminate()
          void ended.then(() => { value.socketClosed = true }).catch(() => {}); return
        }
        if (partialHostCut && frame?.type === 'error' && frame.code === 'host_disconnected_outcome_unknown')
          partialHostCut.hostDisconnectFrames.push(structuredClone(frame))
        if (held) {
          // 只放行生产Hub因真实Host退出而发送的原错误，不能伪造断线或吞掉恢复触发。
          if (hostHeld && frame?.type === 'error' && frame.code === 'host_disconnected_outcome_unknown') {
            hostDisconnectFrames.push(structuredClone(frame))
            if (front.readyState === WebSocket.OPEN) front.send(raw, { binary })
            return
          }
          // 回执之前的原历史/投影也必须扣住，才能构成手机尚不知电脑已接收的情况。
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
    arm(item: Target, mode: 'before-forward' | 'after-receipt', waitForProcessExit = false, waitForHostExit = false) {
      assert.ok(!target && !uploadTarget && !paused && !closed && !(waitForProcessExit && waitForHostExit))
      target = { ...item, mode, waitForProcessExit, waitForHostExit }; cutIndex = cuts.length
    },
    armUpload(item: { sessionId: string; name: string }, waitForProcessExit = false, waitForHostExit = false) {
      assert.ok(!target && !uploadTarget && !paused && !closed && !(waitForProcessExit && waitForHostExit))
      uploadTarget = { ...item, waitForProcessExit, waitForHostExit }; uploadCutIndex = uploadCuts.length
    },
    async uploadHeld() {
      await expect.poll(() => uploadCuts[uploadCutIndex]?.awaitingProcessExit || uploadCuts[uploadCutIndex]?.awaitingHostExit,
        { timeout: 30000 }).toBe(true)
      expect(uploadCuts[uploadCutIndex].socketClosed).toBe(false)
      return structuredClone(uploadCuts[uploadCutIndex])
    },
    async uploadCut() {
      await expect.poll(() => uploadCuts[uploadCutIndex]?.socketClosed, { timeout: 30000 }).toBe(true)
      return structuredClone(uploadCuts[uploadCutIndex])
    },
    async uploadHostExited() {
      await expect.poll(() => uploadCuts[uploadCutIndex]?.hostDisconnectFrames?.some((frame: any) =>
        frame.id === uploadCuts[uploadCutIndex]?.id), { timeout: 30000 }).toBe(true)
      return structuredClone(uploadCuts[uploadCutIndex])
    },
    resumeUploadHost() {
      assert.ok(paused && releaseUploadHostGate && uploadCuts[uploadCutIndex]?.hostDisconnectFrames?.length)
      releaseUploadHostGate(); releaseUploadHostGate = undefined; paused = false
    },
    async held() {
      await expect.poll(() => cuts[cutIndex]?.awaitingProcessExit || cuts[cutIndex]?.awaitingHostExit, { timeout: 30000 }).toBe(true)
      expect(cuts[cutIndex].socketClosed).toBe(false)
      return structuredClone(cuts[cutIndex])
    },
    async cut() { await expect.poll(() => cuts[cutIndex]?.socketClosed, { timeout: 30000 }).toBe(true); return structuredClone(cuts[cutIndex]) },
    async hostExited() {
      await expect.poll(() => cuts[cutIndex]?.hostDisconnectFrames?.length ?? 0, { timeout: 30000 }).toBeGreaterThan(0)
      return structuredClone(cuts[cutIndex])
    },
    resumeHost() {
      assert.ok(paused && releaseHostGate && cuts[cutIndex]?.hostDisconnectFrames?.length)
      releaseHostGate(); releaseHostGate = undefined; paused = false
    },
    resume() { assert.ok(paused && !closed); paused = false },
    writes(item: Target) { return structuredClone(writes.filter(write => matches(write.request, item))) },
    uploads(item: { sessionId: string; name: string }) {
      return structuredClone(uploads.filter(row => row.operation.sessionId === item.sessionId && row.operation.name === item.name))
    },
    snapshot() { return { externalProxy: true, frontPort, backendPort, writes: structuredClone(writes), cuts: structuredClone(cuts),
      uploads: structuredClone(uploads), uploadCuts: structuredClone(uploadCuts) } },
    async close() {
      if (closed) return; closed = true
      for (const bridge of bridges) { bridge.front.terminate(); bridge.back.terminate() }
      bridges.clear(); const ended = once(server, 'close'); server.close(); server.closeAllConnections(); await ended; websocket.close()
    },
  }
}
