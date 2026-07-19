import { describe, expect, it, vi } from 'vitest'
import {
  checkToken,
  extractBearerToken,
  isLocalHostHeader,
  isLocalRequest,
  isLoopbackAddress,
  requireToken,
  resolveSensitiveOpsRequireToken,
} from '../../src/api/auth.js'

describe('auth helpers', () => {
  it('isLoopbackAddress', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.1')).toBe(false)
    expect(isLoopbackAddress(null)).toBe(false)
  })

  it('isLocalHostHeader', () => {
    expect(isLocalHostHeader('localhost:7070')).toBe(true)
    expect(isLocalHostHeader('127.0.0.1')).toBe(true)
    expect(isLocalHostHeader('[::1]:7070')).toBe(true)
    expect(isLocalHostHeader('example.com')).toBe(false)
    expect(isLocalHostHeader(undefined)).toBe(false)
  })

  it('isLocalRequest requires loopback + local host', () => {
    expect(
      isLocalRequest({
        ip: '127.0.0.1',
        headers: { host: 'localhost:7070' },
        socket: { remoteAddress: '127.0.0.1' },
      } as never),
    ).toBe(true)
    expect(
      isLocalRequest({
        ip: '10.0.0.1',
        headers: { host: 'localhost:7070' },
        socket: { remoteAddress: '10.0.0.1' },
      } as never),
    ).toBe(false)
  })

  it('isLocalRequest treats nginx-proxied public Host as non-local', () => {
    // Typical nginx → backend: peer is loopback, Host is the public name.
    expect(
      isLocalRequest({
        ip: '127.0.0.1',
        headers: {
          host: 'shellink.example.com',
          'x-forwarded-for': '203.0.113.10',
          'x-real-ip': '203.0.113.10',
          'x-forwarded-proto': 'https',
        },
        socket: { remoteAddress: '127.0.0.1' },
      } as never),
    ).toBe(false)
    // Spoofed forwarded headers must not grant locality when Host is public.
    expect(
      isLocalRequest({
        ip: '127.0.0.1',
        headers: {
          host: 'api.example.com',
          'x-forwarded-for': '127.0.0.1',
          'x-real-ip': '127.0.0.1',
        },
        socket: { remoteAddress: '127.0.0.1' },
      } as never),
    ).toBe(false)
  })

  it('checkToken and extractBearerToken', () => {
    expect(checkToken('test-token')).toBe(true)
    expect(checkToken('wrong')).toBe(false)
    expect(checkToken(undefined)).toBe(false)
    expect(
      extractBearerToken({ headers: { authorization: 'Bearer test-token' } } as never),
    ).toBe('test-token')
    expect(extractBearerToken({ headers: {} } as never)).toBeUndefined()
  })

  it('resolveSensitiveOpsRequireToken', () => {
    expect(resolveSensitiveOpsRequireToken(true, undefined)).toBe(false)
    expect(resolveSensitiveOpsRequireToken(false, undefined)).toBe(true)
    expect(resolveSensitiveOpsRequireToken(true, true)).toBe(true)
    expect(resolveSensitiveOpsRequireToken(false, false)).toBe(false)
  })

  it('requireToken skips local requests by default', async () => {
    const reply = { code: vi.fn().mockReturnValue({ send: vi.fn() }) }
    expect(
      await requireToken(
        {
          ip: '127.0.0.1',
          headers: { host: 'localhost:7070' },
          socket: { remoteAddress: '127.0.0.1' },
        } as never,
        reply as never,
      ),
    ).toBe(true)
    expect(reply.code).not.toHaveBeenCalled()
  })

  it('requireToken still enforces for remote requests', async () => {
    const reply = { code: vi.fn().mockReturnValue({ send: vi.fn() }) }
    expect(
      await requireToken({ headers: { authorization: 'Bearer test-token' } } as never, reply as never),
    ).toBe(true)
    expect(
      await requireToken({ headers: {} } as never, reply as never),
    ).toBe(false)
    expect(reply.code).toHaveBeenCalledWith(401)
  })
})
