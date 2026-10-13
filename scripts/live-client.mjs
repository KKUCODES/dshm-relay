// 真实网关联调客户端：stdin 每行一条 JSON 命令，凭据只存内存，不读取 Host 凭据。
import { createHash, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose'
import WebSocket from 'ws'
import { clientFrameSchema, hostFrameSchema, MAX_FRAME_BYTES } from '../packages/protocol/dist/index.js'

let identity, binding, origin, socket, connected = false
const requests = new Map()
const summary = process.argv.includes('--summary')
const compact = value => {
  if (typeof value === 'string') return value.length > 240 ? value.slice(0, 240) + '…' : value
  if (Array.isArray(value)) return value.map(compact)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['projections', 'stream', 'replayState', 'tools', 'system'].includes(key) ? '[omitted]' : compact(item)]))
}
const output = value => process.stdout.write(JSON.stringify(summary ? compact(value) : value) + '\n')

async function proof(path, method, token) {
  return new SignJWT({ htu: origin + path, htm: method,
    ...(token ? { ath: createHash('sha256').update(token).digest('base64url') } : {}) })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: identity.jwk })
    .setIssuedAt().setJti(randomUUID()).sign(identity.privateKey)
}

async function api(path, method = 'GET', body, authenticated = true) {
  const token = authenticated ? binding?.token : undefined
  if (!identity || !origin || (authenticated && !token)) throw new Error('not_paired')
  const response = await fetch(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), dpop: await proof(path, method, token),
      ...(token ? { authorization: 'DPoP ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) })
  if (!response.ok) throw new Error('http_' + response.status)
  return response.json()
}

async function connect() {
  if (socket && socket.readyState !== WebSocket.CLOSED) throw new Error('already_connected')
  const { ticket } = await api('/v1/device/ticket', 'POST')
  const current = new WebSocket(origin.replace(/^http/, 'ws') + '/v1/device/socket', { maxPayload: MAX_FRAME_BYTES })
  socket = current
  connected = false
  let ready = false
  const timer = setTimeout(() => { output({ type: 'connection_error', code: 'ready_timeout' }); current.terminate() }, 10000)
  current.on('open', () => current.send(JSON.stringify({ type: 'authenticate', ticket })))
  current.on('error', () => output({ type: 'connection_error', code: 'socket_error' }))
  current.on('close', code => {
    connected = false
    clearTimeout(timer)
    for (const request of requests.values()) clearTimeout(request.timer)
    requests.clear()
    output({ type: 'closed', code })
  })
  current.on('message', raw => {
    try {
      const frame = JSON.parse(raw.toString())
      if (!ready) {
        if (frame.type !== 'ready' || frame.protocol !== 1) throw new Error('invalid_ready')
        ready = true; connected = true; clearTimeout(timer)
        output({ type: 'ready', protocol: frame.protocol, hostOnline: frame.hostOnline }); return
      }
      const parsed = hostFrameSchema.parse(frame)
      const request = requests.get(parsed.id)
      if (!request) return
      clearTimeout(request.timer)
      // 仅输出调用者明确请求的业务内容；HTTP 凭据和 socket ticket 从不输出。
      output({ ...parsed, method: request.method })
      if (parsed.type !== 'event') requests.delete(parsed.id)
    } catch { output({ type: 'protocol_error', code: 'invalid_server_frame' }); current.close() }
  })
}

async function command(input) {
  if (input.command === 'pair') {
    if (binding) throw new Error('already_paired')
    const link = new URL(input.link)
    if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password || link.pathname !== '/pair' || link.search) throw new Error('invalid_pair_link')
    const key = new URLSearchParams(link.hash.slice(1)).get('key')
    if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('invalid_pair_key')
    origin = link.origin
    const pair = await generateKeyPair('ES256')
    identity = { ...pair, jwk: await exportJWK(pair.publicKey) }
    binding = await api('/v1/pairings/claim', 'POST', { key, name: input.name ?? 'DSH Mobile 协议联调' }, false)
    output({ type: 'paired', deviceId: binding.deviceId, hostId: binding.hostId, status: binding.status,
      fingerprint: await calculateJwkThumbprint(identity.jwk) })
  } else if (input.command === 'status') {
    output({ type: 'device', ...await api('/v1/device') })
  } else if (input.command === 'connect') {
    await connect()
  } else if (input.command === 'disconnect') {
    // 保留设备身份，只断开传输；重连必须重新申请 ticket 并建立新订阅。
    socket?.terminate()
  } else if (input.command === 'request') {
    if (!connected || socket?.readyState !== WebSocket.OPEN) throw new Error('not_connected')
    const frame = clientFrameSchema.parse({ type: 'request', id: input.id ?? randomUUID(), operation: input.operation })
    if (requests.has(frame.id)) throw new Error('duplicate_request_id')
    const timer = setTimeout(() => {
      output({ type: 'request_timeout', id: frame.id, method: frame.operation.method, outcome: 'unknown_do_not_replay' })
      requests.delete(frame.id)
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', id: frame.id }))
    }, 35000)
    requests.set(frame.id, { method: frame.operation.method, timer })
    socket.send(JSON.stringify(frame))
    output({ type: 'sent', id: frame.id, method: frame.operation.method })
  } else if (input.command === 'cancel') {
    const frame = clientFrameSchema.parse({ type: 'cancel', id: input.id })
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('not_connected')
    clearTimeout(requests.get(frame.id)?.timer); requests.delete(frame.id)
    socket.send(JSON.stringify(frame)); output({ type: 'subscription_cancelled', id: frame.id })
  } else if (input.command === 'exit') {
    shutdown()
  } else throw new Error('invalid_command')
}

function shutdown() {
  for (const request of requests.values()) clearTimeout(request.timer)
  socket?.terminate(); binding = undefined; identity = undefined
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  process.exit(0)
}

// 终端模式关闭回显，避免一次性链接出现在终端记录中。
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
  process.stdin.on('data', data => { if (data.includes(3)) shutdown() })
}
const lines = createInterface({ input: process.stdin, terminal: false })
process.on('SIGINT', shutdown)
output({ type: 'client_started', commands: ['pair', 'status', 'connect', 'disconnect', 'request', 'cancel', 'exit'], credentialStorage: 'memory_only' })
for await (const line of lines) {
  try { await command(JSON.parse(line)) }
  catch (error) {
    const code = error instanceof Error && /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : 'client_operation_failed'
    output({ type: 'command_error', code })
  }
}
shutdown()
