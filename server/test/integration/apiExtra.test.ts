import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import { buildApp } from '../../src/app.js'
import { profileService } from '../../src/services/ProfileService.js'
import { sessionService } from '../../src/services/SessionService.js'
import { webhookService } from '../../src/services/WebhookService.js'
import { setupWsGateway } from '../../src/ws/gateway.js'
import { resetDb } from '../helpers/resetDb.js'

describe('API sendError rethrows unexpected errors', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    resetDb()
    app = await buildApp({ logger: false, skipMarkStale: true })
  })

  afterEach(async () => {
    resetDb()
    await app.close()
  })

  it('profiles route surfaces non-AppError failures as 500', async () => {
    const spy = vi.spyOn(profileService, 'get').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const res = await app.inject({
      method: 'GET',
      url: '/shellink/api/profiles/whatever',
      headers: { authorization: 'Bearer test-token' },
    })
    expect(res.statusCode).toBe(500)
    spy.mockRestore()
  })

  it('sessions route surfaces non-AppError failures as 500', async () => {
    const spy = vi.spyOn(sessionService, 'state').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const res = await app.inject({
      method: 'GET',
      url: '/shellink/api/sessions/whatever/state',
      headers: { authorization: 'Bearer test-token' },
    })
    expect(res.statusCode).toBe(500)
    spy.mockRestore()
  })

  it('webhooks route surfaces non-AppError failures as 500', async () => {
    const spy = vi.spyOn(webhookService, 'create').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const res = await app.inject({
      method: 'POST',
      url: '/shellink/api/webhooks',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'https://example.com/hook' }),
    })
    expect(res.statusCode).toBe(500)
    spy.mockRestore()
  })
})

describe('Web UI static routes not covered elsewhere', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    resetDb()
    app = await buildApp({ logger: false, skipMarkStale: true })
  })

  afterEach(async () => {
    resetDb()
    await app.close()
  })

  it('redirects /ui to /ui/', async () => {
    const res = await app.inject({ method: 'GET', url: '/shellink/ui' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/shellink/ui/')
  })

  it('serves index.html directly when the exact asset key is requested', async () => {
    const res = await app.inject({ method: 'GET', url: '/shellink/ui/index.html' })
    expect(res.statusCode).toBe(200)
  })

  it('returns 404 for a missing asset under /ui/assets/', async () => {
    const res = await app.inject({ method: 'GET', url: '/shellink/ui/assets/does-not-exist.js' })
    expect(res.statusCode).toBe(404)
  })
})

describe('WS gateway upgrade handling', () => {
  it('rejects unauthorized upgrades and destroys unmatched paths', async () => {
    resetDb()
    const app = await buildApp({ logger: false, skipMarkStale: true })
    await app.listen({ port: 0, host: '127.0.0.1' })
    setupWsGateway(app.server)
    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    // Spoof a non-local Host header so isLocalRequest() fails and the missing
    // token is actually enforced (127.0.0.1 access is otherwise trusted).
    const unauthorizedStatus = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/shellink/ws/sessions/whatever`, {
        headers: { host: 'evil.example.com' },
      })
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.once('error', () => resolve(0))
    })
    expect(unauthorizedStatus).toBe(401)

    const unmatchedDestroyed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/shellink/ws/unknown?token=test-token`, {
        headers: { host: 'evil.example.com' },
      })
      ws.once('open', () => resolve(false))
      ws.once('error', () => resolve(true))
      ws.once('unexpected-response', () => resolve(true))
    })
    expect(unmatchedDestroyed).toBe(true)

    await app.close()
    resetDb()
  })
})
