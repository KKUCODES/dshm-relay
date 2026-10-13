import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
import { expect, test } from 'vitest'

// 验证测试门的真实网络文本/二进制类型；不替代生产鉴权或 Android 集成验收。
test.each([false, true])('代码响应延迟保持原帧类型 binary=%s 与回调', async binary => {
  const { createLatestNativeGate } = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/support/latest-cordis-native-gate.mjs')).href)
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const gate = createLatestNativeGate(server), address = server.address()
  if (typeof address === 'string' || !address) throw Error('gate_missing_port')
  const connected = once(server, 'connection')
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/v1/device/socket`)
  try {
    const [socket] = await connected
    await once(client, 'open')
    const id = randomUUID(), request = once(socket, 'message')
    client.send(JSON.stringify({ type: 'request', id, operation: { method: 'remote.rpc',
      endpoint: 'dynamicCordisRunner/getClientCode', payload: { args: { agentId: 'test', pluginId: 'test', pluginRunId: 'test' } } } }))
    await request
    gate.hold({ code: true })
    const frame = JSON.stringify({ type: 'result', id, value: { text: '中文🙂' } })
    let called = false, callbackError: unknown
    socket.send(binary ? Buffer.from(frame) : frame, (error?: Error | null) => { callbackError = error; called = true })
    expect(gate.report.held).toHaveLength(1); expect(called).toBe(false)
    const received = once(client, 'message')
    gate.release()
    const [bytes, actualBinary] = await received
    expect(bytes.toString()).toBe(frame); expect(actualBinary).toBe(binary)
    await expect.poll(() => called).toBe(true)
    expect(callbackError == null).toBe(true)
  } finally {
    gate.close(); client.terminate()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
  }
})

test('两个独立原生测试门只延迟各自连接，显式重连不接管另一设备', async () => {
  const { createLatestNativeGate } = await import(/* @vite-ignore */ pathToFileURL(resolve('tests/support/latest-cordis-native-gate.mjs')).href)
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (typeof address === 'string' || !address) throw Error('gate_missing_port')
  const gates: any[] = [], clients: WebSocket[] = []
  const connect = async () => {
    const connected = once(server, 'connection')
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/v1/device/socket`)
    clients.push(client)
    const [socket] = await connected; await once(client, 'open')
    return { client, socket }
  }
  const subscribe = async ({ client, socket }: any) => {
    const id = randomUUID(), received = once(socket, 'message')
    client.send(JSON.stringify({ type: 'request', id, operation: { method: 'remote.stream',
      endpoint: 'session/follow', payload: { args: { request: { sessionId: 'test' } } } } }))
    await received; return id
  }
  try {
    const firstGate = createLatestNativeGate(server, { singleConnection: true }); gates.push(firstGate)
    const first = await connect(), firstId = await subscribe(first)
    const secondGate = createLatestNativeGate(server, { singleConnection: true }); gates.push(secondGate)
    const second = await connect(), secondId = await subscribe(second)
    firstGate.hold({ streams: true })
    const firstFrame = JSON.stringify({ type: 'event', id: firstId, value: '原第一设备🙂' })
    const secondFrame = JSON.stringify({ type: 'event', id: secondId, value: '原第二设备🙂' })
    first.socket.send(firstFrame)
    const secondReceived = once(second.client, 'message'); second.socket.send(secondFrame)
    expect((await secondReceived)[0].toString()).toBe(secondFrame)
    expect(firstGate.report.held).toHaveLength(1); expect(secondGate.report.held).toHaveLength(0)
    const firstReceived = once(first.client, 'message'); firstGate.release()
    expect((await firstReceived)[0].toString()).toBe(firstFrame)
    firstGate.acceptNextConnection(); await firstGate.disconnectPage()
    const reconnected = await connect(); await subscribe(reconnected)
    expect(firstGate.report.pageConnections).toBe(2)
    expect(secondGate.report.pageConnections).toBe(1)
    expect(firstGate.report.operations.some((row: any) => row.id === secondId)).toBe(false)
    expect(secondGate.report.operations.some((row: any) => row.id === firstId)).toBe(false)
  } finally {
    for (const gate of gates) gate.close()
    for (const client of clients) client.terminate()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
  }
})
