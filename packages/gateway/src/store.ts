import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Database } from './database.js'

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const secret = (): string => randomBytes(32).toString('base64url')

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

const migration = [
  `CREATE TABLE IF NOT EXISTS hosts (
    id uuid PRIMARY KEY, name text NOT NULL, token_hash text UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS pairings (
    key_hash text PRIMARY KEY, host_id uuid NOT NULL REFERENCES hosts(id),
    expires_at timestamptz NOT NULL, used_at timestamptz)`,
  `CREATE TABLE IF NOT EXISTS devices (
    id uuid PRIMARY KEY, host_id uuid NOT NULL REFERENCES hosts(id), name text NOT NULL,
    key_thumbprint text NOT NULL, token_hash text UNIQUE NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
    created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS devices_host_idx ON devices(host_id)`,
  // 旧设备升级后也只有普通权限；管理能力必须由桌面另行授予。
  `ALTER TABLE devices ADD COLUMN IF NOT EXISTS management boolean NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS proof_replays (
    thumbprint text NOT NULL, jti text NOT NULL, expires_at timestamptz NOT NULL,
    PRIMARY KEY (thumbprint, jti))`,
  `CREATE INDEX IF NOT EXISTS proof_expiry_idx ON proof_replays(expires_at)`,
]

export type Device = { id: string; host_id: string; name: string; key_thumbprint: string;
  status: 'pending' | 'active' | 'revoked'; management: boolean; created_at: Date; expires_at: Date }

export class Store {
  constructor(readonly db: Database) {}
  async migrate(): Promise<void> {
    await this.db.transaction(async tx => {
      for (const sql of migration) await tx.query(sql)
    })
  }
  async enrollHost(name: string, token = secret()): Promise<{ id: string; token: string }> {
    const id = randomUUID()
    await this.db.query('INSERT INTO hosts (id,name,token_hash) VALUES ($1,$2,$3)', [id, name, hash(token)])
    return { id, token }
  }
  async authenticateHost(token: string): Promise<string> {
    const result = await this.db.query<{ id: string }>('SELECT id FROM hosts WHERE token_hash=$1', [hash(token)])
    if (!result.rows[0]) throw new ApiError(401, 'invalid_host_credential')
    return result.rows[0].id
  }
  async createPairing(hostId: string, key: string, ttlSeconds: number): Promise<void> {
    const result = await this.db.query(`INSERT INTO pairings (key_hash,host_id,expires_at)
      VALUES ($1,$2,now()+$3*interval '1 second') ON CONFLICT DO NOTHING RETURNING key_hash`, [hash(key), hostId, ttlSeconds])
    if (!result.rows.length) throw new ApiError(409, 'pairing_key_already_issued')
  }
  async claimPairing(key: string, name: string, thumbprint: string): Promise<{ deviceId: string; hostId: string; token: string; status: 'pending' }> {
    return this.db.transaction(async tx => {
      // 同一事务内消费 key 并创建绑定，竞争请求只有一个能拿到 RETURNING。
      const result = await tx.query<{ host_id: string }>(`UPDATE pairings SET used_at=now()
        WHERE key_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING host_id`, [hash(key)])
      const pair = result.rows[0]
      if (!pair) throw new ApiError(409, 'pairing_unavailable')
      const deviceId = randomUUID(), token = secret()
      await tx.query(`INSERT INTO devices (id,host_id,name,key_thumbprint,token_hash,status,expires_at)
        VALUES ($1,$2,$3,$4,$5,'pending',now()+interval '90 days')`, [deviceId, pair.host_id, name, thumbprint, hash(token)])
      return { deviceId, hostId: pair.host_id, token, status: 'pending' }
    })
  }
  async listDevices(hostId: string): Promise<Device[]> {
    return (await this.db.query<Device>(`SELECT id,host_id,name,key_thumbprint,status,management,created_at,expires_at
      FROM devices WHERE host_id=$1 ORDER BY created_at DESC`, [hostId])).rows
  }
  async authenticateDevice(token: string, thumbprint: string, allowPending = false): Promise<Device> {
    const result = await this.db.query<Device>(`SELECT id,host_id,name,key_thumbprint,status,management,created_at,expires_at
      FROM devices WHERE token_hash=$1 AND key_thumbprint=$2 AND expires_at>now()`, [hash(token), thumbprint])
    const device = result.rows[0]
    if (!device || device.status === 'revoked') throw new ApiError(401, 'invalid_device_credential')
    if (device.status !== 'active' && !allowPending) throw new ApiError(403, 'device_pending')
    return device
  }
  async isDeviceActive(id: string): Promise<boolean> {
    const result = await this.db.query(`SELECT id FROM devices WHERE id=$1 AND status='active' AND expires_at>now()`, [id])
    return result.rows.length === 1
  }
  async activeDevice(id: string): Promise<Device | undefined> {
    return (await this.db.query<Device>(`SELECT id,host_id,name,key_thumbprint,status,management,created_at,expires_at
      FROM devices WHERE id=$1 AND status='active' AND expires_at>now()`, [id])).rows[0]
  }
  async setManagement(hostId: string, deviceId: string, enabled: boolean): Promise<void> {
    const result = await this.db.query(`UPDATE devices SET management=$3 WHERE id=$1 AND host_id=$2
      AND status='active' AND expires_at>now() RETURNING id`, [deviceId, hostId, enabled])
    if (!result.rows.length) throw new ApiError(404, 'device_not_active')
  }
  async changeDevice(hostId: string, deviceId: string, status: 'active' | 'revoked'): Promise<void> {
    const result = await this.db.query(`UPDATE devices SET status=$3 WHERE id=$1 AND host_id=$2
      AND (status='pending' OR ($3='revoked' AND status='active')) RETURNING id`, [deviceId, hostId, status])
    if (!result.rows.length) throw new ApiError(404, 'device_not_pending_or_active')
  }
  async consumeProof(thumbprint: string, jti: string): Promise<void> {
    const result = await this.db.query(`INSERT INTO proof_replays (thumbprint,jti,expires_at)
      VALUES ($1,$2,now()+interval '5 minutes') ON CONFLICT DO NOTHING RETURNING jti`, [thumbprint, jti])
    if (!result.rows.length) throw new ApiError(401, 'proof_replayed')
  }
  async cleanup(): Promise<void> {
    await this.db.query('DELETE FROM proof_replays WHERE expires_at<now()')
    await this.db.query("DELETE FROM pairings WHERE used_at IS NULL AND expires_at<now()-interval '1 day'")
  }
}
