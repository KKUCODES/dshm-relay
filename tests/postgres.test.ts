import { expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { postgresDatabase } from '../packages/gateway/src/database.js'
import { Store, secret } from '../packages/gateway/src/store.js'

test.skipIf(!process.env.TEST_DATABASE_URL)('production pg driver arbitrates concurrent claims and preserves bindings across pool restart', async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!)
  const admin = new pg.Client({ connectionString: url.toString() }); await admin.connect()
  const schema = 'dsh_test_' + randomUUID().replaceAll('-', '')
  await admin.query(`CREATE SCHEMA ${schema}`)
  url.searchParams.set('options', `-c search_path=${schema}`)
  let db = postgresDatabase(url.toString())
  try {
    const store = new Store(db); await store.migrate()
    const host = await store.enrollHost('Production-driver test'), key = secret()
    await store.createPairing(host.id, key, 300)
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => store.claimPairing(key, 'Device ' + i, 'thumb-' + i)))
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    const [device] = await store.listDevices(host.id); expect(device).toBeDefined()
    await store.changeDevice(host.id, device!.id, 'active')
    await db.close(); db = postgresDatabase(url.toString())
    const restarted = new Store(db); await restarted.migrate()
    expect(await restarted.authenticateHost(host.token)).toBe(host.id)
    expect(await restarted.isDeviceActive(device!.id)).toBe(true)
    await expect(restarted.claimPairing(key, 'New app', 'new-thumb')).rejects.toThrow('pairing_unavailable')
    await restarted.changeDevice(host.id, device!.id, 'revoked')
    expect(await restarted.isDeviceActive(device!.id)).toBe(false)
    const expired = secret(); await restarted.createPairing(host.id, expired, -1)
    await expect(restarted.claimPairing(expired, 'Late app', 'late-thumb')).rejects.toThrow('pairing_unavailable')
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const address = probe.address(); if (!address || typeof address === 'string') throw new Error('missing_port')
    const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve()))
    const origin = `http://127.0.0.1:${port}`, enrollment = secret()
    for (const registrationMode of ['private', 'open']) {
    const processHandle = spawn(process.execPath, ['packages/gateway/dist/main.js'], { windowsHide: true, stdio: 'ignore', env: {
      ...process.env, DATABASE_URL: url.toString(), PUBLIC_ORIGIN: origin, REGISTRATION_MODE: registrationMode, ENROLLMENT_TOKEN: registrationMode === 'private' ? enrollment : '',
      PORT: String(port), HOST: '127.0.0.1',
    } })
    try {
      await expect.poll(async () => {
        if (processHandle.exitCode !== null) throw new Error('gateway_exited')
        return fetch(origin + '/health').then(response => response.json()).catch(() => null)
      }, { timeout: 10000 }).toMatchObject({ ok: true, protocol: 1 })
      expect(await fetch(origin + '/v1/server-info').then(response => response.json())).toEqual({ registrationMode, remoteTransport: 2 })
      // 同一数据库切换模式后，已注册电脑的独立凭据继续有效。
      expect((await fetch(origin + '/v1/host/devices', { headers: { authorization: 'Bearer ' + host.token } })).status).toBe(200)
      const enrolled = await fetch(origin + '/v1/hosts', { method: 'POST', headers: { ...(registrationMode === 'private' ? { authorization: 'Bearer ' + enrollment } : {}),
        'content-type': 'application/json' }, body: JSON.stringify({ name: 'Actual entrypoint' }) })
      expect(enrolled.status).toBe(201)
      const registration = await enrolled.json(); expect(await restarted.authenticateHost(registration.token)).toBe(registration.id)
    } finally {
      if (processHandle.exitCode === null) { const closed = once(processHandle, 'close'); processHandle.kill(); await closed }
    }
    }
  } finally {
    await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
