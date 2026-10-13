import { expect, test } from 'vitest'
import { validateOrigin } from '../packages/gateway/src/app.js'

test.each(['http://127.0.0.1:8787', 'http://192.168.1.20:8787', 'http://relay.example.com', 'https://relay.example.com'])('accepts HTTP/HTTPS origin without an opt-in: %s', origin => {
  expect(validateOrigin(origin + '/')).toBe(origin)
})

test.each(['ftp://relay.example.com', 'ws://relay.example.com', 'file:///tmp', 'https://user:secret@relay.example.com',
  'https://relay.example.com/api', 'https://relay.example.com?key=value', 'https://relay.example.com#key=value', 'not-a-url'])('rejects unsupported protocols and non-root addresses: %s', origin => {
  expect(() => validateOrigin(origin)).toThrow()
})
