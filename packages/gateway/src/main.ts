import { z } from 'zod'
import { registrationConfigSchema } from './registration-config.js'
import { buildGateway } from './app.js'
import { postgresDatabase } from './database.js'
import { Store } from './store.js'

const env = z.object({
  DATABASE_URL: z.string().url(), PUBLIC_ORIGIN: z.string().url(),
  HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  TRUST_PROXY_HOPS: z.enum(['0', '1']).default('0'),
}).safeParse(process.env)
if (!env.success) {
  console.error('Invalid gateway environment:', env.error.issues.map(issue => issue.path.join('.')).join(', '))
  process.exit(1)
}
const config = env.data
const registration = registrationConfigSchema.safeParse({ registrationMode: process.env.REGISTRATION_MODE, enrollmentToken: process.env.ENROLLMENT_TOKEN })
if (!registration.success) {
  console.error('Invalid registration configuration: set REGISTRATION_MODE to open or private; private requires a valid ENROLLMENT_TOKEN.')
  process.exit(1)
}
const db = postgresDatabase(config.DATABASE_URL)
const store = new Store(db)
try {
  await store.migrate()
  const app = await buildGateway({ store, publicOrigin: config.PUBLIC_ORIGIN, ...registration.data,
    trustProxyHops: config.TRUST_PROXY_HOPS === '1' ? 1 : 0, logger: true })
  if (new URL(config.PUBLIC_ORIGIN).protocol === 'http:') {
    app.log.warn('HTTP connection is not encrypted. Credentials and chat content may be intercepted or modified; HTTPS is recommended.')
  }
  let closing = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (closing) return
    closing = true
    void app.close().then(() => db.close()).catch(() => { console.error('Gateway shutdown failed'); process.exitCode = 1 })
  })
  await app.listen({ host: config.HOST, port: config.PORT })
} catch {
  // 数据库 URL 含凭据，避免直接打印 driver 错误对象。
  console.error('Gateway startup failed. Check PostgreSQL, PUBLIC_ORIGIN and listening port.')
  await db.close(); process.exitCode = 1
}
