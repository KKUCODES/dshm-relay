import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import pg from 'pg'

// Windows 本地验证用临时集群；CI 可直接向 tests/postgres.test.ts 提供专用 TEST_DATABASE_URL。
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Use TEST_DATABASE_URL on this platform')
const binaries = await import('@embedded-postgres/windows-x64')
const root = resolve('.test-data'); await mkdir(root, { recursive: true })
const directory = await mkdtemp(join(root, 'postgres-'))
const password = randomBytes(32).toString('base64url'), passwordFile = join(directory, 'password'), data = join(directory, 'data')
await writeFile(passwordFile, password, { mode: 0o600 })
const run = promisify(execFile)
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
let server
try {
  await run(binaries.initdb, ['-D', data, '-U', 'dsh_test', '--auth=scram-sha-256', '--pwfile=' + passwordFile, '--encoding=UTF8', '--locale=C'], { windowsHide: true })
  await unlink(passwordFile)
  server = spawn(binaries.postgres, ['-D', data, '-h', '127.0.0.1', '-p', String(port)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let diagnostic = ''
  server.stderr.on('data', value => { diagnostic = (diagnostic + value.toString()).slice(-4000) })
  const url = `postgresql://dsh_test:${password}@127.0.0.1:${port}/postgres`
  let ready = false
  for (let retry = 0; retry < 150; retry++) {
    if (server.exitCode !== null) throw new Error('PostgreSQL exited: ' + diagnostic)
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 500 })
    try { await client.connect(); ready = true } catch {} finally { await client.end().catch(() => {}) }
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error('PostgreSQL startup timeout')
  const result = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/postgres.test.ts'], {
    windowsHide: true, stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url },
  })
  process.exitCode = await new Promise((resolve, reject) => { result.on('error', reject); result.on('close', code => resolve(code ?? 1)) })
} finally {
  await unlink(passwordFile).catch(() => {})
  if (server) await run(binaries.pg_ctl, ['-D', data, 'stop', '-m', 'fast', '-w'], { windowsHide: true })
}
