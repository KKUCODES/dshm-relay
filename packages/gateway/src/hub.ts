import { randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import { z } from 'zod'
import { clientFrameSchema, hostFrameSchema, isStream, MAX_FRAME_BYTES, tokenSchema, remotePermission, remoteRequestAllowed,
  ResponseSequence, RESPONSE_CHUNKS_VERSION, RESPONSE_IDLE_MS, RESPONSE_TOTAL_MS, MAX_RESPONSE_TRANSFERS, MAX_RESPONSE_BUFFER_BYTES } from '@dsh-mobile/protocol'
import type { Device, Store } from './store.js'
import type { Tickets } from './tickets.js'

type Client = { socket: WebSocket; device: Device; connectionId: string; pending: Map<string, string> }
type Pending = { client: Client; originalId: string; hostId: string; stream: boolean; resource: boolean; upload: boolean;
  chunks: boolean; response?: ResponseSequence; timer: NodeJS.Timeout }
const authFrame = z.object({ type: z.literal('authenticate'), ticket: tokenSchema }).strict()

/** 单实例中继；只持有在线路由和短期请求，不持久化聊天正文。 */
export class Hub {
  private hosts = new Map<string, WebSocket>()
  private hostTransports = new Map<string, number>()
  private chunkHosts = new Set<string>()
  private clients = new Set<Client>()
  private authenticating = new Map<string, Set<WebSocket>>()
  private pending = new Map<string, Pending>()
  private sockets = new Map<WebSocket, boolean>()
  private heartbeat: NodeJS.Timeout
  constructor(private store: Store, private tickets: Tickets) {
    this.heartbeat = setInterval(() => {
      for (const [socket, alive] of this.sockets) {
        if (!alive) { socket.terminate(); continue }
        this.sockets.set(socket, false); socket.ping()
      }
      for (const client of this.clients) {
        if (new Date(client.device.expires_at).getTime() <= Date.now()) this.disconnect(client, 'credential_expired')
      }
    }, 20000)
    this.heartbeat.unref()
  }
  private watch(socket: WebSocket) {
    this.sockets.set(socket, true)
    socket.on('pong', () => this.sockets.set(socket, true))
    socket.on('error', () => socket.terminate())
    socket.on('close', () => this.sockets.delete(socket))
  }
  private send(socket: WebSocket | undefined, value: unknown): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    const payload = JSON.stringify(value)
    if (Buffer.byteLength(payload) > MAX_FRAME_BYTES || socket.bufferedAmount > MAX_FRAME_BYTES * 2) {
      socket.close(1009, 'capacity_exceeded'); return false
    }
    socket.send(payload); return true
  }
  attachHost(hostId: string, socket: WebSocket, transport = 1, responseChunks = false) {
    const previous = this.hosts.get(hostId)
    if (previous) { this.hostGone(hostId); previous.close(4001, 'host_replaced') }
    this.hosts.set(hostId, socket); this.watch(socket)
    this.hostTransports.set(hostId, transport)
    if (responseChunks && transport === 2) this.chunkHosts.add(hostId)
    else this.chunkHosts.delete(hostId)
    socket.on('message', (raw, binary) => {
      if (this.hosts.get(hostId) !== socket) return
      const parsed = this.parse(raw, binary, hostFrameSchema)
      if (!parsed) { socket.close(1008, 'invalid_frame'); return }
      const request = this.pending.get(parsed.id)
      // 不信任 Host 自报的关联 id；同时校验当前连接的 Host 归属。
      if (!request || request.hostId !== hostId) return
      if (new Date(request.client.device.expires_at).getTime() <= Date.now()) { this.disconnect(request.client, 'credential_expired'); return }
      // 分块仍属于原请求和原权限；RPC的分块不会被当作额外业务订阅。
      if (parsed.type === 'responseStart' || parsed.type === 'responseChunk' || parsed.type === 'responseEnd') {
        try {
          if (!request.chunks || !this.chunkHosts.has(hostId)) throw Error('unnegotiated_response_chunks')
          if (parsed.type === 'responseStart') {
            if (request.response) throw Error('invalid_response_chunk')
            const active = [...this.pending.values()].filter(item => item.client === request.client && item.response)
            if (active.length >= MAX_RESPONSE_TRANSFERS || active.reduce((sum, item) => sum + item.response!.start.bytes, 0) + parsed.bytes > MAX_RESPONSE_BUFFER_BYTES) throw Error('response_buffer_limit')
            request.response = new ResponseSequence(parsed, request.stream)
          } else if (!request.response) throw Error('invalid_response_chunk')
          else if (parsed.type === 'responseChunk') request.response.chunk(parsed)
          else request.response.end(parsed)
          clearTimeout(request.timer)
          const terminal = parsed.type === 'responseEnd' && request.response!.start.kind === 'result'
          if (parsed.type === 'responseEnd') request.response = undefined
          if (!this.send(request.client.socket, { ...parsed, id: request.originalId })) { this.finish(parsed.id, true); return }
          if (terminal) this.finish(parsed.id, false)
          else if (request.response) {
            request.timer = setTimeout(() => {
              this.send(request.client.socket, { type: 'error', id: request.originalId, code: 'response_chunk_timeout' }); this.finish(parsed.id, true)
            }, Math.max(1, Math.min(RESPONSE_IDLE_MS, RESPONSE_TOTAL_MS - (Date.now() - request.response.startedAt)))); request.timer.unref()
          }
        } catch (error) {
          const code = error instanceof Error && ['response_buffer_limit', 'response_chunk_timeout', 'incomplete_response_chunk'].includes(error.message)
            ? error.message : 'invalid_response_chunk'
          this.send(request.client.socket, { type: 'error', id: request.originalId, code })
          this.finish(parsed.id, true)
        }
        return
      }
      if (request.response && parsed.type !== 'error') {
        this.send(request.client.socket, { type: 'error', id: request.originalId, code: 'incomplete_response_chunk' }); this.finish(parsed.id, true); return
      }
      if ((parsed.type === 'event' || parsed.type === 'end') && !request.stream) { socket.close(1008, 'invalid_response'); return }
      clearTimeout(request.timer)
      this.send(request.client.socket, { ...parsed, id: request.originalId })
      if (parsed.type !== 'event') this.finish(parsed.id, false)
    })
    socket.on('close', () => {
      if (this.hosts.get(hostId) === socket) { this.hosts.delete(hostId); this.hostTransports.delete(hostId); this.chunkHosts.delete(hostId); this.hostGone(hostId) }
    })
  }
  attachDevice(socket: WebSocket) {
    this.watch(socket)
    let client: Client | undefined, authenticating = false, frames = 0, acknowledgements = 0, responseAcknowledgements = 0, windowStart = Date.now()
    const deadline = setTimeout(() => socket.close(1008, 'authentication_required'), 5000)
    deadline.unref()
    socket.on('message', (raw, binary) => {
      if (Date.now() - windowStart > 1000) { frames = 0; acknowledgements = 0; responseAcknowledgements = 0; windowStart = Date.now() }
      if (!client) {
        if (authenticating) { socket.close(1008, 'authentication_in_progress'); return }
        const frame = this.parse(raw, binary, authFrame)
        if (!frame) { socket.close(1008, 'invalid_authentication'); return }
        authenticating = true
        void (async () => {
          const device = this.tickets.consume(frame.ticket)
          const sockets = this.authenticating.get(device.id) ?? new Set<WebSocket>()
          sockets.add(socket); this.authenticating.set(device.id, sockets)
          try {
            const current = await this.store.activeDevice(device.id)
            if (!current || current.host_id !== device.host_id) throw new Error('inactive')
            if (socket.readyState !== WebSocket.OPEN) return
            if ([...this.clients].filter(item => item.device.id === device.id).length >= 4) throw new Error('limit')
            client = { socket, device: current, connectionId: randomUUID(), pending: new Map() }; this.clients.add(client)
            clearTimeout(deadline)
            this.send(socket, { type: 'ready', protocol: 1, hostOnline: this.hosts.has(device.host_id), management: current.management, responseChunksVersion: RESPONSE_CHUNKS_VERSION })
          } finally {
            sockets.delete(socket); if (!sockets.size) this.authenticating.delete(device.id)
          }
        })().catch(() => socket.close(1008, 'invalid_authentication'))
        return
      }
      const frame = this.parse(raw, binary, clientFrameSchema)
      if (!frame) { socket.close(1008, 'invalid_frame'); return }
      // 文件消费确认不应挤占普通 RPC 配额；两者仍独立限速，且只能确认自己的在途资源。
      const rateLimited = frame.type === 'responseAck' ? ++responseAcknowledgements > 4096
        : ['ack', 'uploadChunk', 'uploadEnd'].includes(frame.type) ? ++acknowledgements > 512 : ++frames > 120
      if (rateLimited) { socket.close(1008, 'rate_limited'); return }
      if (!this.clients.has(client)) return
      if (new Date(client.device.expires_at).getTime() <= Date.now()) { this.disconnect(client, 'credential_expired'); return }
      if (frame.type === 'cancel') {
        const id = client.pending.get(frame.id)
        if (id) { this.finish(id, true); this.send(socket, { type: 'end', id: frame.id }) }
        return
      }
      if (frame.type === 'responseAck') {
        const id = client.pending.get(frame.id), pending = id ? this.pending.get(id) : undefined
        if (!pending?.response || !pending.chunks) return
        try {
          pending.response.ack(frame)
          if (!this.send(this.hosts.get(pending.hostId), { ...frame, id })) this.finish(id!, true)
        } catch {
          this.send(socket, { type: 'error', id: frame.id, code: 'invalid_response_ack' }); this.finish(id!, true)
        }
        return
      }
      if (frame.type === 'ack') {
        const id = client.pending.get(frame.id)
        const pending = id ? this.pending.get(id) : undefined
        if (pending?.resource) this.send(this.hosts.get(pending.hostId), { ...frame, id })
        return
      }
      if (frame.type === 'uploadChunk' || frame.type === 'uploadEnd') {
        const id = client.pending.get(frame.id)
        const pending = id ? this.pending.get(id) : undefined
        if (pending?.upload) this.send(this.hosts.get(pending.hostId), { ...frame, id })
        return
      }
      if (client.pending.has(frame.id)) { socket.close(1008, 'duplicate_request_id'); return }
      const host = this.hosts.get(client.device.host_id)
      const error = (code: string) => this.send(socket, { type: 'error', id: frame.id, code })
      if (frame.responseChunks && !this.chunkHosts.has(client.device.host_id)) { error('response_chunks_unavailable'); return }
      if (['remote.providerCardRead', 'remote.modelReadiness', 'remote.modelProbePrepare', 'remote.modelProbeExecute'].includes(frame.operation.method) && !client.device.management) {
        error('management_required'); return
      }
      if (['remote.presetManagementRead', 'remote.presetCopy', 'remote.presetDelete'].includes(frame.operation.method) && !client.device.management) {
        error('management_required'); return
      }
if (['remote.settingsRead', 'remote.settingsWrite', 'remote.providerSettingsList', 'remote.providerSettingsRead', 'remote.providerSettingsWrite', 'remote.providerKeySetup', 'remote.providerRemovalRead', 'remote.providerRemovalWrite', 'remote.providerCreationRead', 'remote.providerCreationWrite', 'remote.providerModelsRead', 'remote.providerModelsWrite', 'remote.deepSeekModelsRead', 'remote.deepSeekModelsWrite', 'remote.providerModelsDiscover', 'remote.keyRead', 'remote.keyWrite', 'remote.endpointRead', 'remote.endpointWrite', 'remote.pluginOperationStart', 'remote.pluginOperationRead', 'remote.pluginOperations'].includes(frame.operation.method) && !client.device.management) {
        error('management_required'); return
      }
      if (frame.operation.method === 'remote.rpc' || frame.operation.method === 'remote.stream') {
        const permission = remotePermission(frame.operation.endpoint, frame.operation.method === 'remote.stream')
        if (!permission || !remoteRequestAllowed(frame.operation.endpoint, frame.operation.payload, 'either')) { error('remote_operation_denied'); return }
        if (permission === 'management' && !client.device.management) { error('management_required'); return }
      }
      if (!host || host.readyState !== WebSocket.OPEN) { error('host_offline'); return }
      if (frame.operation.method.startsWith('remote.') && this.hostTransports.get(client.device.host_id) !== 2) {
        error('host_upgrade_required'); return
      }
      if (client.pending.size >= 32 || this.pending.size >= 4096) { error('too_many_requests'); return }
      const stream = isStream(frame.operation)
      const resource = ['remote.resource', 'remote.office', 'remote.attachment', 'remote.attachmentOffice', 'remote.changes', 'remote.sessionExport'].includes(frame.operation.method)
      const upload = ['remote.upload', 'remote.prompt'].includes(frame.operation.method)
      const transfer = resource || upload
      // 会话、通知与文件观察会长期占用订阅；不能挤掉加载插件所需的短期传输。
      // 多会话旁栏各有独立会话/评价订阅；20条订阅与8路传输满额后仍有4个短请求位置。
      // 仍受每连接32个及全局4096个请求上限约束，不通过额外连接绕过容量。
      if (stream) {
        const used = [...client.pending.values()].filter(id => {
          const pending = this.pending.get(id)
          return pending?.stream && (pending.resource || pending.upload) === transfer
        }).length
        if (used >= (transfer ? 8 : 20)) { error(transfer ? 'too_many_transfers' : 'too_many_streams'); return }
      }
      const id = randomUUID()
      const timer = setTimeout(() => { error('request_timeout_outcome_unknown'); this.finish(id, true) }, 30000)
      timer.unref()
      this.pending.set(id, { client, hostId: client.device.host_id, originalId: frame.id, stream, resource, upload, chunks: frame.responseChunks === 1, timer })
      client.pending.set(frame.id, id)
      const context = frame.operation.method.startsWith('remote.') ? { context: {
        deviceId: client.device.id, hostId: client.device.host_id, connectionId: client.connectionId, management: client.device.management,
      } } : {}
      if (!this.send(host, { ...frame, id, ...context })) { error('host_unavailable'); this.finish(id, false) }
    })
    socket.on('close', () => { clearTimeout(deadline); if (client) this.detach(client) })
  }
  private parse<T>(raw: RawData, binary: boolean, schema: z.ZodType<T>): T | undefined {
    if (binary) return undefined
    try { return schema.parse(JSON.parse(raw.toString())) } catch { return undefined }
  }
  private finish(id: string, cancel: boolean) {
    const request = this.pending.get(id)
    if (!request) return
    clearTimeout(request.timer); this.pending.delete(id); request.client.pending.delete(request.originalId)
    if (cancel) this.send(this.hosts.get(request.hostId), { type: 'cancel', id })
  }
  private hostGone(hostId: string) {
    for (const [id, request] of this.pending) if (request.hostId === hostId) {
      this.send(request.client.socket, { type: 'error', id: request.originalId, code: 'host_disconnected_outcome_unknown' })
      this.finish(id, false)
    }
  }
  private detach(client: Client) {
    this.clients.delete(client)
    for (const id of client.pending.values()) this.finish(id, true)
  }
  private disconnect(client: Client, reason: string) { this.detach(client); client.socket.close(4003, reason) }
  revoke(deviceId: string, reason = 'device_revoked') {
    // 同时关闭正在等待数据库检查的握手，避免撤销与 WS 鉴权交错时漏掉连接。
    for (const socket of this.authenticating.get(deviceId) ?? []) socket.close(4003, reason)
    for (const client of this.clients) if (client.device.id === deviceId) this.disconnect(client, reason)
  }
  close() {
    clearInterval(this.heartbeat)
    for (const client of this.clients) this.detach(client)
    for (const socket of this.sockets.keys()) socket.terminate()
    this.hosts.clear(); this.hostTransports.clear(); this.chunkHosts.clear(); this.sockets.clear()
  }
}
