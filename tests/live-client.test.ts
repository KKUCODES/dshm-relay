import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { buildGateway } from '../packages/gateway/src/app.js'
import { Store, secret } from '../packages/gateway/src/store.js'
import { pgliteDatabase } from './support/database.js'

test('CLI pairs through real HTTP, rejects pending access and authenticates an approved socket without leaking credentials', async () => {
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('missing port')
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const origin = `http://127.0.0.1:${address.port}`
  const db = new PGlite(), store = new Store(pgliteDatabase(db))
  await store.migrate()
  const app = await buildGateway({ store, publicOrigin: origin, registrationMode: 'open' })
  await app.listen({ host: '127.0.0.1', port: address.port })
  const host = await store.enrollHost('CLI fixture'), key = secret()
  await store.createPairing(host.id, key, 300)
  const child = spawn(process.execPath, ['scripts/live-client.mjs', '--summary'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const lines = createInterface({ input: child.stdout })
  const frames: Record<string, unknown>[] = []
  let output = '', stderr = ''
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  lines.on('line', line => frames.push(JSON.parse(line)))
  const send = (input: unknown) => child.stdin.write(JSON.stringify(input) + '\n')
  const receive = async (type: string) => {
    await expect.poll(() => frames.some(frame => frame.type === type), { timeout: 10000 }).toBe(true)
    return frames.splice(frames.findIndex(frame => frame.type === type), 1)[0]!
  }
  try {
    await receive('client_started')
    send({ command: 'pair', link: origin + '/pair#key=' + key, name: 'CLI fixture device' })
    const paired = await receive('paired')
    expect(paired.status).toBe('pending')
    expect(paired.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/)
    send({ command: 'connect' })
    expect((await receive('command_error')).code).toBe('http_403')
    if (typeof paired.deviceId !== 'string') throw new Error('missing device ID')
    await store.changeDevice(host.id, paired.deviceId, 'active')
    send({ command: 'connect' })
    expect(await receive('ready')).toMatchObject({ protocol: 1, hostOnline: false })
    send({ command: 'disconnect' })
    await receive('closed')
    send({ command: 'connect' })
    expect(await receive('ready')).toMatchObject({ protocol: 1, hostOnline: false })
    expect(output).not.toContain(key)
    expect(output).not.toContain(host.token)
    expect(output).not.toContain('"token":')
    expect(output).not.toContain('"privateKey":')
    expect(stderr).toBe('')
  } finally {
    child.kill(); lines.close()
    await app.close(); await db.close()
  }
}, 30000)
