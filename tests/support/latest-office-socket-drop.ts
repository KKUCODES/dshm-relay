import { once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import WebSocket, { type WebSocketServer, type RawData } from 'ws'
import { expect } from 'vitest'
import { clientFrameSchema } from '@dsh-mobile/protocol'

/** 仅切断实际发送指定 Office 请求的设备 socket；不触碰 Host 或通知连接。 */
export function latestOfficeSocketDrop(server: WebSocketServer, sessionId: string, path: string) {
  const requests = new Map<string, WebSocket>()
  const listeners = new Map<WebSocket, (data: RawData, binary: boolean) => void>()
  const observe = (socket: WebSocket, request: IncomingMessage) => {
    if (request.url !== '/v1/device/socket') return
    const message = (data: RawData, binary: boolean) => {
      if (binary) return
      let value: unknown
      try { value = JSON.parse(data.toString()) } catch { return }
      const parsed = clientFrameSchema.safeParse(value)
      if (!parsed.success || parsed.data.type !== 'request') return
      const frame = parsed.data
      if (frame.operation.method !== 'remote.office' || frame.operation.sessionId !== sessionId
        || frame.operation.path !== path) return
      if (requests.size >= 100) throw Error('office_socket_observation_overflow')
      requests.set(frame.id, socket)
    }
    listeners.set(socket, message)
    socket.on('message', message)
  }
  server.on('connection', observe)
  return {
    async drop(requestId: string) {
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      await expect.poll(() => requests.has(requestId), { timeout: 10000 }).toBe(true)
      const socket = requests.get(requestId)!
      expect(socket.readyState).toBe(WebSocket.OPEN)
      const closed = once(socket, 'close')
      socket.terminate()
      await closed
      expect(socket.readyState).toBe(WebSocket.CLOSED)
      return { originalRequestSocketDropped: true, onlyMatchedDeviceSocket: true, gracefulReasonSent: false }
    },
    close() {
      server.off('connection', observe)
      for (const [socket, message] of listeners) socket.off('message', message)
      listeners.clear(); requests.clear()
    },
  }
}
