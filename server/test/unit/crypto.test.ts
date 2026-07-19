import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from '../../src/db/crypto.js'

describe('crypto', () => {
  it('round-trips secrets', () => {
    const enc = encryptSecret('hello-secret')
    expect(enc).not.toContain('hello-secret')
    expect(decryptSecret(enc)).toBe('hello-secret')
  })

  it('produces different ciphertext each time', () => {
    expect(encryptSecret('x')).not.toBe(encryptSecret('x'))
  })

  it('rejects tampered payload', () => {
    const enc = encryptSecret('ok')
    const buf = Buffer.from(enc, 'base64')
    buf[buf.length - 1] ^= 0xff
    expect(() => decryptSecret(buf.toString('base64'))).toThrow()
  })
})
