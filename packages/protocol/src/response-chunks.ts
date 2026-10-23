import { z } from 'zod'

export const RESPONSE_CHUNKS_VERSION = 1
export const RESPONSE_CHUNK_BYTES = 64 * 1024
export const RESPONSE_CHUNK_WINDOW = 4
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
export const MAX_RESPONSE_BUFFER_BYTES = 64 * 1024 * 1024
export const MAX_RESPONSE_TRANSFERS = 4
export const RESPONSE_IDLE_MS = 30000
export const RESPONSE_TOTAL_MS = 120000

const identity = { id: z.uuid(), transferId: z.uuid() }
export const responseStartSchema = z.object({ ...identity, type: z.literal('responseStart'),
  kind: z.enum(['result', 'event']), bytes: z.number().int().min(1).max(MAX_RESPONSE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const responseChunkSchema = z.object({ ...identity, type: z.literal('responseChunk'),
  index: z.number().int().min(0).max(Math.ceil(MAX_RESPONSE_BYTES / RESPONSE_CHUNK_BYTES) - 1),
  data: z.string().min(4).max(Math.ceil(RESPONSE_CHUNK_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict()
export const responseEndSchema = z.object({ ...identity, type: z.literal('responseEnd') }).strict()
export const responseAckSchema = z.object({ ...identity, type: z.literal('responseAck'),
  index: z.number().int().min(0).max(Math.ceil(MAX_RESPONSE_BYTES / RESPONSE_CHUNK_BYTES) - 1) }).strict()
export type ResponseStart = z.infer<typeof responseStartSchema>
export type ResponseChunk = z.infer<typeof responseChunkSchema>
export type ResponseEnd = z.infer<typeof responseEndSchema>
export type ResponseAck = z.infer<typeof responseAckSchema>
export type ResponsePart = ResponseStart | ResponseChunk | ResponseEnd

/** 中转和手机共用顺序/窗口约束；中转只保存计数，不保存或重组聊天正文。 */
export class ResponseSequence {
  received = 0
  acknowledged = 0
  readonly startedAt = Date.now()
  touchedAt = this.startedAt
  constructor(readonly start: ResponseStart, stream: boolean) {
    if (start.kind === 'event' && !stream) throw Error('invalid_response_chunk')
  }
  check(frame: { transferId: string }, now = Date.now()) {
    if (frame.transferId !== this.start.transferId) throw Error('invalid_response_chunk')
    if (now - this.touchedAt >= RESPONSE_IDLE_MS || now - this.startedAt >= RESPONSE_TOTAL_MS) throw Error('response_chunk_timeout')
  }
  chunk(frame: ResponseChunk): Uint8Array {
    this.check(frame)
    if (frame.index !== this.received || this.received - this.acknowledged >= RESPONSE_CHUNK_WINDOW) throw Error('invalid_response_chunk')
    const raw = atob(frame.data)
    const expected = Math.min(RESPONSE_CHUNK_BYTES, this.start.bytes - this.received * RESPONSE_CHUNK_BYTES)
    if (raw.length !== expected || expected <= 0 || btoa(raw) !== frame.data) throw Error('invalid_response_chunk')
    this.received++; this.touchedAt = Date.now()
    return Uint8Array.from(raw, char => char.charCodeAt(0))
  }
  ack(frame: ResponseAck) {
    this.check(frame)
    if (frame.index !== this.acknowledged || frame.index >= this.received) throw Error('invalid_response_ack')
    this.acknowledged++; this.touchedAt = Date.now()
  }
  end(frame: ResponseEnd) {
    this.check(frame)
    if (this.received !== Math.ceil(this.start.bytes / RESPONSE_CHUNK_BYTES) || this.acknowledged !== this.received) throw Error('incomplete_response_chunk')
  }
}

type Assembly = { sequence: ResponseSequence; chunks: Uint8Array[]; released: boolean }

/** 只向业务层交付校验后的完整值；取消/重连释放所有半成品，不跨连接续接。 */
export class ResponseAssembler {
  private entries = new Map<string, Assembly>()
  private reserved = 0
  get bytes() { return this.reserved }
  get size() { return this.entries.size }
  async accept(frame: ResponsePart, stream: boolean): Promise<{
    ack?: ResponseAck; frame?: { type: 'result' | 'event'; id: string; value: unknown }
  }> {
    if (frame.type === 'responseStart') {
      if (this.entries.has(frame.id)) throw Error('invalid_response_chunk')
      if (this.entries.size >= MAX_RESPONSE_TRANSFERS || this.reserved + frame.bytes > MAX_RESPONSE_BUFFER_BYTES) throw Error('response_buffer_limit')
      const sequence = new ResponseSequence(frame, stream)
      this.entries.set(frame.id, { sequence, chunks: [], released: false }); this.reserved += frame.bytes
      return {}
    }
    const entry = this.entries.get(frame.id)
    if (!entry) throw Error('invalid_response_chunk')
    try {
      if (frame.type === 'responseChunk') {
        entry.chunks.push(entry.sequence.chunk(frame))
        const ack: ResponseAck = { type: 'responseAck', id: frame.id, transferId: frame.transferId, index: frame.index }
        entry.sequence.ack(ack)
        return { ack }
      }
      entry.sequence.end(frame)
      const bytes = new Uint8Array(entry.sequence.start.bytes)
      let offset = 0
      for (const chunk of entry.chunks) { bytes.set(chunk, offset); offset += chunk.length }
      entry.chunks = []
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
      if (entry.released) throw Error('response_chunk_cancelled')
      entry.sequence.check(frame)
      if (hash !== entry.sequence.start.sha256) throw Error('response_chunk_corrupt')
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      return { frame: { type: entry.sequence.start.kind, id: frame.id, value } }
    } catch (error) { this.cancel(frame.id); throw error }
    finally { if (frame.type === 'responseEnd') this.cancel(frame.id) }
  }
  cancel(id: string) {
    const entry = this.entries.get(id)
    if (!entry || entry.released) return
    entry.released = true; entry.chunks = []; this.reserved -= entry.sequence.start.bytes; this.entries.delete(id)
  }
  clear() { for (const id of this.entries.keys()) this.cancel(id) }
}
