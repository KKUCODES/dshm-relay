import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { resolve } from 'node:path'
import { expect, onTestFinished } from 'vitest'
import WebSocket, { type RawData, type WebSocketServer } from 'ws'
import { clientFrameSchema } from '@dsh-mobile/protocol'

export type FileTransferPhase = 'file-transfer-prepare' | 'file-transfer-drop' | 'file-transfer-finish'

/** 原文件与原上传附件的摘要；只终止读取本测试文件的实际设备连接。 */
export async function latestFileTransfer(server: WebSocketServer, sessionId: string, workspacePath: string,
  officeSource: Uint8Array, attachment: { attachmentId: string; name: string; bytes: number },
  formats?: { sources: readonly { extension: string; bytes: Uint8Array }[];
    attachments: readonly { attachmentId: string; name: string; bytes: number }[] }) {
  const workspaceName = 'latest-native-office.docx', networkName = 'dshm-latest-export-network.bin'
  expect(attachment.name).toBe('latest-history-office.docx')
  expect(attachment.bytes).toBe(officeSource.byteLength)
  const networkSource = Buffer.alloc(3 * 1024 * 1024 + 19)
  for (let index = 0; index < networkSource.length; index++) networkSource[index] = index % 251
  await writeFile(resolve(workspacePath, networkName), networkSource, { flag: 'wx' })
  const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
  const originals = formats?.sources.map(source => {
    const file = formats.attachments.find(item => item.name === 'latest-history-office.' + source.extension)
    expect(file).toBeDefined(); expect(file!.bytes).toBe(source.bytes.byteLength)
    return { extension: source.extension,
      workspace: { name: 'latest-native-office.' + source.extension, bytes: source.bytes.byteLength, sha256: digest(source.bytes) },
      attachment: { ...file!, sha256: digest(source.bytes) } }
  })
  if (formats) {
    expect(formats.sources.map(item => item.extension)).toEqual(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt'])
    expect(formats.attachments).toHaveLength(6)
  }
  const requests = new Map<string, WebSocket>(), listeners = new Map<WebSocket, (data: RawData) => void>()
  const attach = (socket: WebSocket) => {
    if (listeners.has(socket)) return
    const message = (data: RawData) => {
      let value: unknown
      try { value = JSON.parse(data.toString()) } catch { return }
      const parsed = clientFrameSchema.safeParse(value)
      if (!parsed.success || parsed.data.type !== 'request') return
      const frame = parsed.data, operation = frame.operation
      if (operation.method !== 'remote.rpc' || operation.endpoint !== 'workspaceFiles/readBytes') return
      const args = (operation.payload as { args?: { workspaceFileScopeId?: string; path?: string } }).args
      if (args?.workspaceFileScopeId !== sessionId || args.path !== networkName) return
      expect(requests.size).toBeLessThan(256)
      requests.set(frame.id, socket)
    }
    listeners.set(socket, message); socket.on('message', message)
  }
  const observe = (socket: WebSocket, request: IncomingMessage) => {
    if (request.url === '/v1/device/socket') attach(socket)
  }
  // 此准备入口由已经配对的手机调用；原连接不会再次触发connection。
  // 现存连接仍须匹配原clientFrame和精确会话/文件，再按手机原请求ID关联。
  for (const socket of server.clients) attach(socket)
  server.on('connection', observe)
  onTestFinished(() => {
    server.off('connection', observe)
    for (const [socket, message] of listeners) socket.off('message', message)
    listeners.clear(); requests.clear()
  })
  const verifySources = async () => {
    expect(await readFile(resolve(workspacePath, workspaceName))).toEqual(Buffer.from(officeSource))
    expect(await readFile(resolve(workspacePath, networkName))).toEqual(networkSource)
    for (const source of formats?.sources ?? []) {
      expect(await readFile(resolve(workspacePath, 'latest-native-office.' + source.extension))).toEqual(Buffer.from(source.bytes))
      expect(await readFile(resolve(workspacePath, 'latest-history-office.' + source.extension), 'utf8'))
        .toBe('Different workspace bytes; never the historical attachment.')
    }
  }
  await verifySources()
  const prepared = { sessionId,
    workspace: { name: workspaceName, bytes: officeSource.byteLength, sha256: digest(officeSource) },
    attachment: { ...attachment, sha256: digest(officeSource) },
    network: { name: networkName, bytes: networkSource.length, sha256: digest(networkSource) },
    ...(originals ? { formats: originals } : {}) }
  return { async verify(phase: FileTransferPhase, details?: { requestId: string }) {
    if (phase === 'file-transfer-prepare') return prepared
    if (phase === 'file-transfer-finish') { await verifySources(); return { sourceBytesPreserved: true } }
    expect(details?.requestId).toMatch(/^[0-9a-f-]{36}$/i)
    await expect.poll(() => requests.has(details!.requestId), { timeout: 10000 }).toBe(true)
    const socket = requests.get(details!.requestId)!
    expect(socket.readyState).toBe(WebSocket.OPEN)
    const closed = once(socket, 'close'); socket.terminate(); await closed
    expect(socket.readyState).toBe(WebSocket.CLOSED)
    return { originalReadSocketDropped: true, onlyMatchedDeviceSocket: true, gracefulReasonSent: false }
  } }
}
