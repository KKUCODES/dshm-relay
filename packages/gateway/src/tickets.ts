import { ApiError, hash, secret, type Device } from './store.js'

/** 浏览器 WebSocket 无法设置 Authorization，使用短效、一次性的首帧凭据。 */
export class Tickets {
  private readonly entries = new Map<string, { device: Device; expires: number }>()
  mint(device: Device): string {
    this.cleanup()
    if (this.entries.size >= 1024) throw new ApiError(503, 'ticket_capacity')
    const ticket = secret()
    this.entries.set(hash(ticket), { device, expires: Date.now() + 30000 })
    return ticket
  }
  consume(ticket: string): Device {
    const key = hash(ticket), entry = this.entries.get(key)
    this.entries.delete(key)
    if (!entry || entry.expires <= Date.now()) throw new ApiError(401, 'invalid_ticket')
    return entry.device
  }
  revoke(deviceId: string): void {
    for (const [key, entry] of this.entries) if (entry.device.id === deviceId) this.entries.delete(key)
  }
  cleanup(): void {
    for (const [key, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(key)
  }
}
