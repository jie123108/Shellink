import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { resetDb } from '../helpers/resetDb.js'

describe('GET /api/auth/sensitive-ops', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    resetDb()
    app = await buildApp({ logger: false, skipMarkStale: true })
  })

  afterEach(async () => {
    resetDb()
    await app.close()
  })

  it('is public and reports local vs remote policy', async () => {
    const local = await app.inject({
      method: 'GET',
      url: '/shellink/api/auth/sensitive-ops',
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1:7070' },
    })
    expect(local.statusCode).toBe(200)
    expect(local.json()).toEqual({ requireToken: false })

    const remote = await app.inject({
      method: 'GET',
      url: '/shellink/api/auth/sensitive-ops',
      remoteAddress: '10.0.0.1',
      headers: { host: 'example.com' },
    })
    expect(remote.statusCode).toBe(200)
    expect(remote.json()).toEqual({ requireToken: true })
  })

  it('requires token when nginx proxies with public Host (loopback peer)', async () => {
    // nginx on the same host: TCP peer is 127.0.0.1, Host is the external name.
    const viaNginx = await app.inject({
      method: 'GET',
      url: '/shellink/api/auth/sensitive-ops',
      remoteAddress: '127.0.0.1',
      headers: {
        host: 'shellink.example.com',
        'x-forwarded-for': '203.0.113.50',
        'x-real-ip': '203.0.113.50',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'shellink.example.com',
      },
    })
    expect(viaNginx.statusCode).toBe(200)
    expect(viaNginx.json()).toEqual({ requireToken: true })

    // Spoofed X-Forwarded-For / X-Real-IP as loopback must not disable the token.
    const spoofed = await app.inject({
      method: 'GET',
      url: '/shellink/api/auth/sensitive-ops',
      remoteAddress: '127.0.0.1',
      headers: {
        host: 'shellink.example.com',
        'x-forwarded-for': '127.0.0.1',
        'x-real-ip': '::1',
      },
    })
    expect(spoofed.statusCode).toBe(200)
    expect(spoofed.json()).toEqual({ requireToken: true })
  })

  it('rejects unauthenticated delete when reached via nginx-style Host', async () => {
    const purge = await app.inject({
      method: 'DELETE',
      url: '/shellink/api/sessions/records?olderThan=all',
      remoteAddress: '127.0.0.1',
      headers: {
        host: 'shellink.example.com',
        'x-forwarded-for': '203.0.113.50',
        'x-real-ip': '203.0.113.50',
      },
    })
    expect(purge.statusCode).toBe(401)

    const withToken = await app.inject({
      method: 'DELETE',
      url: '/shellink/api/sessions/records?olderThan=all',
      remoteAddress: '127.0.0.1',
      headers: {
        host: 'shellink.example.com',
        'x-forwarded-for': '203.0.113.50',
        authorization: 'Bearer test-token',
      },
    })
    expect(withToken.statusCode).toBe(200)
    expect(withToken.json()).toEqual({ ok: true, deleted: 0 })
  })
})
