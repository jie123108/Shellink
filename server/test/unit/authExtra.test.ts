import { describe, expect, it } from 'vitest'
import { extractBearerToken, isLocalHostHeader, isLoopbackAddress } from '../../src/api/auth.js'

describe('isLoopbackAddress', () => {
  it('returns false for undefined/null/empty', () => {
    expect(isLoopbackAddress(undefined)).toBe(false)
    expect(isLoopbackAddress(null)).toBe(false)
    expect(isLoopbackAddress('')).toBe(false)
  })
  it('recognizes IPv4-mapped IPv6 loopback', () => {
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })
  it('rejects non-loopback addresses', () => {
    expect(isLoopbackAddress('10.0.0.1')).toBe(false)
  })
})

describe('isLocalHostHeader', () => {
  it('returns false for undefined/null/empty', () => {
    expect(isLocalHostHeader(undefined)).toBe(false)
    expect(isLocalHostHeader(null)).toBe(false)
  })
  it('handles bracketed IPv6 literals with a port', () => {
    expect(isLocalHostHeader('[::1]:7070')).toBe(true)
  })
  it('falls back to the raw hostname when a bracketed literal has no closing bracket', () => {
    expect(isLocalHostHeader('[::1')).toBe(false)
  })
  it('strips the port from a plain hostname', () => {
    expect(isLocalHostHeader('localhost:7070')).toBe(true)
  })
  it('rejects remote hosts', () => {
    expect(isLocalHostHeader('example.com')).toBe(false)
  })
})

describe('extractBearerToken', () => {
  const req = (authorization?: string) => ({ headers: { authorization } }) as never
  it('returns undefined when the header is missing', () => {
    expect(extractBearerToken(req(undefined))).toBeUndefined()
  })
  it('returns undefined when the header is not Bearer-prefixed', () => {
    expect(extractBearerToken(req('Basic abc'))).toBeUndefined()
  })
  it('extracts the token after Bearer ', () => {
    expect(extractBearerToken(req('Bearer abc123'))).toBe('abc123')
  })
})
