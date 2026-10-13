import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { expect, onTestFinished } from 'vitest'
import WebSocket from 'ws'
import { clientFrameSchema } from '@dsh-mobile/protocol'

/** Same approved device, real additional sockets; never submit a valid launch confirmation. */
export async function verifyLatestDesktopConnection(origin: string, sessionId: string,
  ticket: () => Promise<string>, mainRequest: (operation: unknown) => Promise<Record<string, any>>) {
  const sockets = new Set<WebSocket>()
  const cleanup = () => { for (const socket of sockets) socket.terminate(); sockets.clear() }
  onTestFinished(cleanup)
  const connect = async () => {
    const credential = await ticket()
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/v1/device/socket')
    sockets.add(socket)
    const frames: Record<string, any>[] = []
    socket.on('message', raw => frames.push(JSON.parse(raw.toString())))
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'authenticate', ticket: credential }))
    await expect.poll(() => frames.some(frame => frame.type === 'ready'), { timeout: 10000 }).toBe(true)
    const request = async (operation: unknown) => {
      const id = randomUUID()
      socket.send(JSON.stringify(clientFrameSchema.parse({ type: 'request', id, operation })))
      await expect.poll(() => frames.some(frame => frame.id === id), { timeout: 15000 }).toBe(true)
      return frames.splice(frames.findIndex(frame => frame.id === id), 1)[0]!
    }
    const close = async () => {
      const closed = once(socket, 'close')
      socket.close(1000, 'fixture_complete'); await closed; sockets.delete(socket)
    }
    return { request, close }
  }
  const prepare = { method: 'remote.prepareDesktopApp', sessionId, appId: 'explorer' }
  const open = (snapshot: string) => ({ method: 'remote.openDesktopApp', sessionId, snapshot, confirmed: true })
  try {
    const first = await connect()
    const prepared = await first.request(prepare)
    expect(prepared).toMatchObject({ type: 'result', value: { snapshot: expect.any(String) } })
    // The same device identity is insufficient: confirmation belongs to its precise connection.
    expect(await mainRequest(open(prepared.value.snapshot))).toMatchObject({ type: 'error', code: 'remote_desktop_stale' })
    await first.close()
    const reconnected = await connect()
    expect(await reconnected.request(open(prepared.value.snapshot))).toMatchObject({ type: 'error', code: 'remote_desktop_stale' })
    const current = await reconnected.request(prepare)
    expect(current).toMatchObject({ type: 'result', value: { snapshot: expect.any(String) } })
    expect(current.value.snapshot).not.toBe(prepared.value.snapshot)
    const replacement = await reconnected.request(prepare)
    expect(replacement.value.snapshot).not.toBe(current.value.snapshot)
    expect(await reconnected.request(open(current.value.snapshot))).toMatchObject({ type: 'error', code: 'remote_desktop_stale' })
    await reconnected.close()
    return { passed: true, sameDeviceOtherConnectionDenied: true, reconnectReplayDenied: true,
      freshPrepareAfterReconnect: true, supersededAfterReconnectDenied: true, validLaunchSubmitted: false }
  } finally { cleanup() }
}
