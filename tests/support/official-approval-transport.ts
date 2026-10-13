import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { expect } from 'vitest'
import { clientFrameSchema } from '@dsh-mobile/protocol'

type Target = { eventId: string; callId: string; sessionId: string; mode: 'before-forward' | 'after-receipt';
  event?: 'approval/request' | 'user-questions/request'; outcome?: unknown;
  question?: { id: string; question: string }; plan?: string }
type Bridge = { id: number; front: WebSocket; back: WebSocket; clientId?: string;
  events: Map<string, { callId?: string; sessionId: string; event: string; request: any }>;
  holding: boolean; heldBytes: number; heldTypes: string[] }

/** 外部测试转发口只切断真实连接，不替换网关/DSH函数、伪造鉴权或生成审批回执。 */
export async function officialApprovalTransport(frontPort: number, backendPort: number) {
  assert.equal(frontPort, 16956); assert.equal(backendPort, 16957)
  const bridges = new Set<Bridge>(), answers: Record<string, any>[] = [], cuts: Record<string, any>[] = []
  const trace: Record<string, any>[] = []
  const record = (value: Record<string, any>) => { if (trace.length < 256) trace.push({ at: Date.now(), ...value }) }
  let target: Target | undefined, paused = false, closed = false, nextId = 0, armedCutIndex = 0
  const server = createServer((req, res) => {
    const forwarded = httpRequest({ hostname: '127.0.0.1', port: backendPort,
      path: req.url, method: req.method, headers: req.headers }, reply => {
      if (req.url === '/v1/device' || req.url === '/v1/device/ticket') record({ http: req.url, status: reply.statusCode })
      res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res)
    })
    forwarded.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.on('aborted', () => forwarded.destroy()); req.pipe(forwarded)
  })
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    record({ upgrade: req.url?.split('?')[0], paused })
    if (closed || (paused && req.url === '/v1/device/socket')) { socket.destroy(); return }
    if (!req.url?.startsWith('/v1/')) { socket.destroy(); return }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) =>
      !['connection', 'upgrade'].includes(key) && !key.startsWith('sec-websocket-')))
    websocket.handleUpgrade(req, socket, head, front => {
      const back = new WebSocket(`ws://127.0.0.1:${backendPort}${req.url}`, { headers, perMessageDeflate: false })
      const bridge: Bridge = { id: ++nextId, front, back, events: new Map(), holding: false, heldBytes: 0, heldTypes: [] }
      bridges.add(bridge)
      const queue: { raw: RawData; binary: boolean }[] = []
      let queuedBytes = 0, closing = false
      const terminate = () => {
        if (closing) return; closing = true
        front.terminate(); back.terminate(); bridges.delete(bridge)
      }
      const parse = (raw: RawData, binary: boolean) => {
        if (binary) return undefined
        try { return JSON.parse(raw.toString()) } catch { return undefined }
      }
      const cut = (answer: Record<string, any>, receipt?: unknown) => {
        const proof = { ...answer, mode: target!.mode, receipt, withheldTypes: [...bridge.heldTypes],
          requestForwarded: bridge.holding, socketClosed: false }
        cuts.push(proof); target = undefined; paused = true
        const ending = Promise.all([once(front, 'close'), once(back, 'close')])
        terminate()
        void ending.then(() => { proof.socketClosed = true })
      }
      front.on('message', (raw, binary) => {
        const parsed = clientFrameSchema.safeParse(parse(raw, binary))
        const frame = parsed.success && parsed.data.type === 'request' ? parsed.data : undefined
        const operation = frame?.operation
        if (req.url === '/v1/device/socket' && operation?.method === 'remote.rpc' && operation.endpoint === '$events/result') {
          const args = (operation.payload as any)?.args
          const event = bridge.events.get(args?.eventId)
          if (event) {
            assert.ok(answers.length < 128)
            const answer = { id: frame!.id, bridgeId: bridge.id, clientId: args.clientId,
              eventId: args.eventId, callId: event.callId, sessionId: event.sessionId,
              decision: args.outcome?.value, outcome: args.outcome, forwarded: false }
            answers.push(answer)
            if (target && target.eventId === args.eventId) {
              assert.equal(args.clientId, bridge.clientId)
              assert.equal(event.callId, target.callId); assert.equal(event.sessionId, target.sessionId)
              assert.deepEqual(args.outcome, target.outcome ?? { kind: 'result', value: 'allowed-once' })
              assert.equal(back.readyState, WebSocket.OPEN)
              if (target.mode === 'before-forward') { cut(answer); return }
              bridge.holding = true
            }
            answer.forwarded = true
          }
        }
        if (back.readyState === WebSocket.OPEN) back.send(raw, { binary })
        else if (back.readyState === WebSocket.CONNECTING) {
          queuedBytes += Buffer.byteLength(raw.toString())
          if (queue.length >= 256 || queuedBytes > 8 * 1024 * 1024) { terminate(); return }
          queue.push({ raw, binary })
        }
      })
      back.on('open', () => { record({ bridgeId: bridge.id, opened: true }); for (const item of queue.splice(0)) back.send(item.raw, { binary: item.binary }); queuedBytes = 0 })
      back.on('message', (raw, binary) => {
        const frame = parse(raw, binary)
        if (frame?.type === 'ready') record({ bridgeId: bridge.id, ready: true, hostOnline: frame.hostOnline })
        if (req.url === '/v1/device/socket' && frame?.type === 'event') {
          if (frame.value?.type === 'ready' && typeof frame.value.clientId === 'string') bridge.clientId = frame.value.clientId
          if (frame.value?.type === 'waterfall' && ['approval/request', 'user-questions/request'].includes(frame.value.event)) {
            assert.ok(bridge.events.size < 128)
            const request = frame.value.request
            bridge.events.set(frame.value.eventId, { callId: request.callId ?? request.questions?.[0]?.intent?.callId,
              sessionId: frame.value.agentId, event: frame.value.event, request })
          }
        }
        if (bridge.holding) {
          bridge.heldBytes += Buffer.byteLength(raw.toString())
          assert.ok(bridge.heldTypes.length < 256 && bridge.heldBytes <= 8 * 1024 * 1024)
          bridge.heldTypes.push(frame?.type ?? 'binary')
          const answer = answers.find(item => item.bridgeId === bridge.id && item.id === frame?.id)
          if (answer && ['result', 'error'].includes(frame.type)) { cut(answer, frame); return }
          return
        }
        if (front.readyState === WebSocket.OPEN) front.send(raw, { binary })
      })
      // 普通关闭保留真实协议原因；只有命中的故障点采用无关闭握手的断线。
      const relayClose = (peer: WebSocket, code: number, reason: Buffer) => {
        record({ bridgeId: bridge.id, closed: code })
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
    arm(value: Target) {
      assert.ok(!target && !paused && !closed)
      const events = [...bridges].map(bridge => bridge.events.get(value.eventId)).filter(event => !!event)
      assert.ok(events.length > 0)
      for (const event of events) {
        assert.equal(event.sessionId, value.sessionId); assert.equal(event.event, value.event ?? 'approval/request')
        if (value.event === 'user-questions/request') {
          assert.equal(event.request.questions.length, 1)
          const question = event.request.questions[0]
          if (value.plan !== undefined) {
            assert.equal(question.id, 'plan-review'); assert.equal(question.detail, value.plan)
            assert.equal(question.intent.callId, value.callId)
          } else {
            // legacy原waterfall没有callId；使用公开日志及同一事件的精确问题身份关联。
            assert.ok(value.question); assert.equal(question.id, value.question.id)
            assert.equal(question.question, value.question.question); assert.equal(event.callId, undefined)
            event.callId = value.callId
          }
        }
        assert.equal(event.callId, value.callId)
      }
      armedCutIndex = cuts.length; target = value
    },
    async cut() {
      await expect.poll(() => cuts[armedCutIndex]?.socketClosed, { timeout: 30000 }).toBe(true)
      assert.equal(paused, true)
      return structuredClone(cuts[armedCutIndex])
    },
    resume() { assert.ok(paused && !closed); paused = false; record({ resumed: true }) },
    answers(eventId: string) { return structuredClone(answers.filter(item => item.eventId === eventId)) },
    snapshot() { return { externalProxy: true, frontPort, backendPort, cuts: structuredClone(cuts), answers: structuredClone(answers), trace: structuredClone(trace) } },
    async close() {
      if (closed) return; closed = true
      for (const bridge of bridges) { bridge.front.terminate(); bridge.back.terminate() }
      bridges.clear()
      const ended = once(server, 'close'); server.close(); server.closeAllConnections(); await ended
      websocket.close()
    },
  }
}
