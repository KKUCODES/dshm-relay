import { createHash } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { expect } from 'vitest'

/** 用生产配对路径和真实数据库时间；不缩短有效期或修改时钟。 */
export async function officialPairingChecks({ manage, db, devices }: {
  manage: (action?: unknown) => Promise<any>; db: PGlite; devices: Set<string>
}) {
  const baseline = (await manage()).devices
  const unchanged = async () => {
    const current = (await manage()).devices
    for (const device of current) if (!baseline.some((old: any) => old.id === device.id)) devices.add(device.id)
    expect(current).toEqual(baseline)
    return { noNewDeviceOrAuthorization: true }
  }
  const create = async () => {
    const pair = await manage({ action: 'pair' })
    const key = new URLSearchParams(new URL(pair.link).hash.slice(1)).get('key')!
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const hash = createHash('sha256').update(key).digest('hex')
    const query = async () => {
      const row = (await db.query<{ expires_at: Date; used_at: Date | null; expired: boolean; remaining: number }>(
        'SELECT expires_at, used_at, expires_at<=now() AS expired, EXTRACT(EPOCH FROM expires_at-now())::float8 AS remaining FROM pairings WHERE key_hash=$1', [hash])).rows[0]
      expect(row).toBeDefined()
      return row!
    }
    const initial = await query()
    expect(initial.used_at).toBeNull(); expect(initial.expired).toBe(false)
    expect(initial.remaining).toBeGreaterThan(298); expect(initial.remaining).toBeLessThanOrEqual(300)
    expect(Math.abs(Date.parse(pair.expiresAt) - initial.expires_at.getTime())).toBeLessThan(1000)
    return { ...pair, query, createdAt: Date.now(), expiresAt: initial.expires_at.toISOString() }
  }
  const expired = await create()
  let fresh: Awaited<ReturnType<typeof create>> | undefined
  return {
    expired: { link: expired.link, expiresAt: expired.expiresAt },
    unchanged,
    async waitUntilExpired() {
      let current = await expired.query()
      while (!current.expired) {
        console.log(JSON.stringify({ stage: 'pairing-natural-expiry-wait', remainingSeconds: Math.ceil(current.remaining) }))
        await new Promise(done => setTimeout(done, Math.min(30000, Math.max(100, current.remaining * 1000 + 50))))
        current = await expired.query()
      }
      expect(current.used_at).toBeNull()
      expect(current.expires_at.toISOString()).toBe(expired.expiresAt)
      await unchanged()
      return { naturallyExpired: true, databaseExpiryUnchanged: true, expiresAt: expired.expiresAt,
        observedAt: new Date().toISOString(), elapsedMs: Date.now() - expired.createdAt }
    },
    async rejected() {
      const current = await expired.query()
      expect(current.expired).toBe(true); expect(current.used_at).toBeNull()
      return { ...await unchanged(), expiredKeyUnconsumed: true }
    },
    async fresh() {
      fresh = await create(); expect(fresh.link).not.toBe(expired.link)
      await unchanged()
      return { link: fresh.link, expiresAt: fresh.expiresAt }
    },
    async claimed(fingerprint: string) {
      expect(fresh).toBeDefined()
      const current = (await manage()).devices
      const added = current.filter((device: any) => !baseline.some((old: any) => old.id === device.id))
      for (const device of added) devices.add(device.id)
      expect(added).toHaveLength(1)
      expect(added[0]).toMatchObject({ fingerprint, status: 'pending', management: false })
      expect((await fresh!.query()).used_at).not.toBeNull()
      expect((await expired.query()).used_at).toBeNull()
      return { onlyOnePendingDevice: true, freshKeyConsumed: true, expiredKeyUnconsumed: true, managementNotGranted: true }
    },
  }
}
