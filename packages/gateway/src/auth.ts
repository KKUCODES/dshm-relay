import { createHash, timingSafeEqual } from 'node:crypto'
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify } from 'jose'
import { z } from 'zod'
import { ApiError, type Store } from './store.js'

export function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}
export function authorization(value: string | undefined, scheme: 'Bearer' | 'DPoP'): string {
  const match = new RegExp(`^${scheme} ([A-Za-z0-9_-]{43})$`).exec(value ?? '')
  if (!match?.[1]) throw new ApiError(401, 'missing_credential')
  return match[1]
}
const publicKey = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), y: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()

/** RFC 9449 的证明校验；配对授权本身由一次性 key 与桌面确认提供。 */
export async function verifyProof(store: Store, proof: string | undefined, method: string, url: string, token?: string): Promise<string> {
  let thumbprint: string, jti: string
  try {
    if (!proof || proof.length > 4096) throw new Error('invalid proof size')
    const header = decodeProtectedHeader(proof)
    if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256') throw new Error('invalid header')
    const jwk = publicKey.parse(header.jwk)
    const key = await importJWK(jwk, 'ES256')
    const { payload } = await jwtVerify(proof, key, {
      algorithms: ['ES256'], typ: 'dpop+jwt', requiredClaims: ['iat', 'jti', 'htm', 'htu'],
      maxTokenAge: 60, clockTolerance: 5,
    })
    if (typeof payload.iat !== 'number' || !Number.isInteger(payload.iat)
      || payload.iat > Date.now() / 1000 + 5 || payload.htm !== method || payload.htu !== url
      || typeof payload.jti !== 'string' || payload.jti.length < 16 || payload.jti.length > 200) throw new Error('invalid claims')
    if (token && payload.ath !== createHash('sha256').update(token).digest('base64url')) throw new Error('token mismatch')
    thumbprint = await calculateJwkThumbprint(jwk)
    jti = payload.jti
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(401, 'invalid_dpop_proof')
  }
  // 签名通过后仍必须原子消费防重放记录。存储故障由网关返回服务错误，
  // 不能伪装成凭据失效，导致手机要求用户重新配对；也不能跳过消费放行。
  await store.consumeProof(thumbprint, jti)
  return thumbprint
}
