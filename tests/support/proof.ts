import { createHash, randomUUID } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

export async function clientKey() {
  const pair = await generateKeyPair('ES256', { extractable: true })
  return { ...pair, jwk: await exportJWK(pair.publicKey) }
}
export async function proof(key: Awaited<ReturnType<typeof clientKey>>, url: string, method: string, token?: string, jti = randomUUID()) {
  return new SignJWT({ htu: url, htm: method,
    ...(token ? { ath: createHash('sha256').update(token).digest('base64url') } : {}) })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk })
    .setIssuedAt().setJti(jti).sign(key.privateKey)
}
