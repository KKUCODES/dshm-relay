import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, onTestFinished } from 'vitest'
import WebSocket from 'ws'
import { clientFrameSchema } from '@dsh-mobile/protocol'
import { clientKey, proof } from './proof.js'

type Observation = { servicePresent: boolean; serviceGeneration: number; listCalls: number; openCalls: number; moved: boolean;
  hold: { entered: boolean; released: boolean; settled: boolean; aborted: boolean; serviceReleased: boolean;
    phase: 'list' | 'open'; nativeOpenSettled: boolean } | null }

/** 控制器只读回隔离 Host 的现场观察，不代替真实协议响应。 */
export function latestDesktopProbe(home: string, sessionId: string) {
  const control = async (action: string): Promise<Observation> => {
    const id = randomUUID()
    await writeFile(resolve(home, 'desktop-control.json'), JSON.stringify({ id, action, sessionId }))
    let receipt: { id: string; error?: string; observation: Observation } | undefined
    await expect.poll(async () => {
      try { receipt = JSON.parse(await readFile(resolve(home, 'desktop-receipt.json'), 'utf8')); return receipt?.id }
      catch { return undefined }
    }, { timeout: 15000 }).toBe(id)
    expect(receipt?.error).toBeUndefined()
    return receipt!.observation
  }
  const wait = async (predicate: (value: Observation) => boolean) => {
    let value: Observation | undefined
    await expect.poll(async () => { value = await control('status'); return predicate(value) }, { timeout: 15000 }).toBe(true)
    return value!
  }
  return { control, wait }
}

/** 原Host原应用列表的迟到结果；真实鉴权/取消/卸载及文件系统故障，不替换协议响应或启动器。 */
export async function verifyLatestDesktopInFlight(origin: string, home: string, sessionId: string,
  manage: (action?: unknown) => Promise<any>, desktopRpc: (method: string, args: unknown) => Promise<any>) {
  const { control, wait } = latestDesktopProbe(home, sessionId)
  const identity = await clientKey(), sockets = new Set<WebSocket>()
  onTestFinished(() => { for (const socket of sockets) socket.terminate() })
  const api = async (path: string, token?: string, body?: unknown) => fetch(origin + path, {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { dpop: await proof(identity, origin + path, 'POST', token),
      ...token ? { authorization: 'DPoP ' + token } : {}, ...body === undefined ? {} : { 'content-type': 'application/json' } },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const pairing = await manage({ action: 'pair' })
  const key = new URLSearchParams(new URL(pairing.link).hash.slice(1)).get('key')
  const claimed = await api('/v1/pairings/claim', undefined, { key, name: 'Latest desktop in-flight protocol' })
  expect(claimed.status).toBe(201)
  const claim = await claimed.json()
  expect((await api('/v1/device/ticket', claim.token)).status).toBe(403)
  await manage({ action: 'approve', deviceId: claim.deviceId })
  let revoked = false, serviceId: string | undefined, disabled = false
  const connect = async () => {
    const response = await api('/v1/device/ticket', claim.token)
    expect(response.status).toBe(200)
    const { ticket } = await response.json()
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/v1/device/socket')
    sockets.add(socket)
    const frames: Record<string, any>[] = [], closed = once(socket, 'close')
    socket.on('message', raw => frames.push(JSON.parse(raw.toString())))
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'authenticate', ticket }))
    const receive = async (id?: string) => {
      await expect.poll(() => frames.some(frame => id ? frame.id === id : frame.type === 'ready'), { timeout: 15000 }).toBe(true)
      return frames.splice(frames.findIndex(frame => id ? frame.id === id : frame.type === 'ready'), 1)[0]!
    }
    await receive()
    const request = (operation: unknown) => {
      const id = randomUUID()
      socket.send(JSON.stringify(clientFrameSchema.parse({ type: 'request', id, operation })))
      return id
    }
    return { socket, frames, closed, request, receive,
      result: async (operation: unknown) => receive(request(operation)),
      close: async () => { socket.close(1000, 'fixture_complete'); await closed; sockets.delete(socket) } }
  }
  const prepare = { method: 'remote.prepareDesktopApp', sessionId, appId: 'explorer' }
  const open = (snapshot: string) => ({ method: 'remote.openDesktopApp', sessionId, snapshot, confirmed: true })
  let client: Awaited<ReturnType<typeof connect>> | undefined
  const begin = async () => {
    const prepared = await client!.result(prepare)
    expect(prepared).toMatchObject({ type: 'result', value: { snapshot: expect.any(String) } })
    const baseline = await control('arm')
    const id = client!.request(open(prepared.value.snapshot))
    await wait(value => value.hold?.entered === true)
    return { id, snapshot: prepared.value.snapshot as string, openCalls: baseline.openCalls }
  }
  const released = async (openCalls: number) => {
    await control('release')
    const observed = await wait(value => value.hold?.settled === true)
    expect(observed.openCalls).toBe(openCalls)
    return observed
  }
  try {
    client = await connect()
    const cancel = await begin()
    client.socket.send(JSON.stringify({ type: 'cancel', id: cancel.id }))
    expect(await client.receive(cancel.id)).toMatchObject({ type: 'end' })
    await wait(value => value.hold?.aborted === true)
    await released(cancel.openCalls)
    // 新的真实往返作结算屏障，确认迟到结果不会再次变为成功。
    expect(await client.result({ method: 'remote.negotiate', version: 2 })).toMatchObject({ type: 'result' })
    expect(client.frames.some(frame => frame.id === cancel.id)).toBe(false)
    expect(await client.result(open(cancel.snapshot))).toMatchObject({ type: 'error', code: 'remote_desktop_stale' })

    const disconnected = await begin()
    await client.close()
    await wait(value => value.hold?.aborted === true)
    await released(disconnected.openCalls)
    client = await connect()
    expect(await client.result(open(disconnected.snapshot))).toMatchObject({ type: 'error', code: 'remote_desktop_stale' })

    const missing = await begin()
    await control('move')
    await released(missing.openCalls)
    expect(await client.receive(missing.id)).toMatchObject({ type: 'error', code: 'remote_desktop_workspace_missing' })
    await control('restore')
    expect(await client.result(open(missing.snapshot))).toMatchObject({ type: 'error', code: 'remote_desktop_stale' })

    const rows = await desktopRpc('pluginManager/listPlugins', {})
    const services = rows.filter((row: { moduleName: string }) => row.moduleName === '@deepseek-ai/dsh-host-open-in-app')
    expect(services).toHaveLength(1); expect(services[0].readOnlyReason).toBeUndefined()
    serviceId = services[0].entryId
    const unloading = await begin()
    expect(await desktopRpc('pluginManager/setPluginEnabled', { id: serviceId, enabled: false }))
      .toMatchObject({ application: 'applied', enabled: false })
    disabled = true
    await wait(value => !value.servicePresent && value.hold?.serviceReleased === true)
    await released(unloading.openCalls)
    expect(await client.receive(unloading.id)).toMatchObject({ type: 'error', code: 'remote_desktop_stale' })
    expect(await client.result({ method: 'remote.negotiate', version: 2 })).toMatchObject({ type: 'result', value: { desktopApps: false } })
    expect(await desktopRpc('pluginManager/setPluginEnabled', { id: serviceId, enabled: true }))
      .toMatchObject({ application: 'applied', enabled: true })
    disabled = false
    await wait(value => value.servicePresent)
    expect(await client.result(open(unloading.snapshot))).toMatchObject({ type: 'error', code: 'remote_desktop_stale' })

    const revocation = await begin()
    await manage({ action: 'revoke', deviceId: claim.deviceId }); revoked = true
    const [code, reason] = await client.closed
    expect(code).toBe(4003); expect(reason.toString()).toBe('device_revoked')
    await wait(value => value.hold?.aborted === true)
    await released(revocation.openCalls)
    expect(client.frames.some(frame => frame.id === revocation.id && frame.type === 'result')).toBe(false)
    expect((await api('/v1/device/ticket', claim.token)).status).toBe(401)
    expect((await control('status')).openCalls).toBe(0)
    return { passed: true, source: 'original application query result held locally; real DPoP/gateway/Host/services/filesystem',
      cancelLateResultDenied: true, disconnectLateResultDenied: true, reconnectReplayDenied: true,
      workspaceMissingDeniedAndRestored: true, originalServiceUnloadedAndReenabled: true,
      unloadLateResultDenied: true, revocationLateResultDenied: true, revokedTicketDenied: true,
      validLauncherInvoked: false, authorityRevoked: true }
  } finally {
    const state = await control('status')
    if (state.hold?.entered && !state.hold.released) await control('release')
    if (state.moved) await control('restore')
    if (disabled && serviceId) await desktopRpc('pluginManager/setPluginEnabled', { id: serviceId, enabled: true })
    if (!revoked) await manage({ action: 'revoke', deviceId: claim.deviceId })
    for (const socket of sockets) socket.terminate()
    sockets.clear()
  }
}
