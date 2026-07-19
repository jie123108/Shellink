import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { AppError, RpcErrorCode } from '@shellink/protocol'
import { buildApp } from '../../src/app.js'
import { TransferError } from '../../src/core/TransferError.js'
import { profileService } from '../../src/services/ProfileService.js'
import { sessionService } from '../../src/services/SessionService.js'
import { asAppError } from '../../src/services/errors.js'
import { WebhookInboxService } from '../../src/services/WebhookInboxService.js'
import { TestClient, waitForState } from '../helpers/client.js'
import { resetDb } from '../helpers/resetDb.js'

describe('asAppError', () => {
  it('maps TransferError status codes to RPC error codes', () => {
    expect(asAppError(new TransferError('x', 404)).code).toBe(RpcErrorCode.NOT_FOUND)
    expect(asAppError(new TransferError('x', 409)).code).toBe(RpcErrorCode.CONFLICT)
    expect(asAppError(new TransferError('x', 413)).code).toBe(RpcErrorCode.PAYLOAD_TOO_LARGE)
    expect(asAppError(new TransferError('x', 502)).code).toBe(RpcErrorCode.INVALID_REQUEST)
  })

  it('wraps unknown errors with a fallback message', () => {
    expect(asAppError('not an error object', 'fallback msg').message).toBe('fallback msg')
    expect(asAppError(new Error('boom')).message).toBe('boom')
  })
})

describe('ProfileService.update branches', () => {
  beforeEach(() => resetDb())
  afterEach(() => resetDb())

  it('throws NOT_FOUND for a missing profile', () => {
    expect(() => profileService.update('missing-id', { name: 'x' })).toThrow(AppError)
  })

  it('applies explicit connectType/host/username overrides', () => {
    const created = profileService.create({ name: 'svc-a', connectType: 'ssh', host: 'h1', username: 'u1' })
    const updated = profileService.update(created.id, { connectType: 'ssh', host: 'h2', username: 'u2' })
    expect(updated.host).toBe('h2')
    expect(updated.username).toBe('u2')
  })
})

describe('SessionService branches', () => {
  it('state() returns a disconnected record for a closed session still on file', async () => {
    resetDb()
    const app = await buildApp({ logger: false, skipMarkStale: true })
    const client = new TestClient({ kind: 'inject', app }, 'test-token')
    const profile = await client.createProfile({
      name: 'svc-state',
      connectType: 'command',
      command: "bash --norc --noprofile -c 'export PS1=\"$ \"; exec bash --norc --noprofile'",
      promptRegex: '[$#]\\s*$',
    })
    const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string }).id
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
    await client.closeSession(sid)
    await new Promise((r) => setTimeout(r, 600))

    const state = sessionService.state(sid)
    expect(state.state).toBe('DISCONNECTED')
    expect(state.active).toBe(false)

    await app.close()
    resetDb()
  }, 30_000)

  it('history() 404s for an unknown session record', () => {
    resetDb()
    expect(() => sessionService.history({ id: 'does-not-exist' })).toThrow(AppError)
  })

  it('input() honors manual mode and rejects manual input outside MANUAL', async () => {
    resetDb()
    const app = await buildApp({ logger: false, skipMarkStale: true })
    const client = new TestClient({ kind: 'inject', app }, 'test-token')
    const profile = await client.createProfile({
      name: 'svc-manual',
      connectType: 'command',
      command: "bash --norc --noprofile -c 'export PS1=\"$ \"; exec bash --norc --noprofile'",
      promptRegex: '[$#]\\s*$',
    })
    const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string }).id
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)

    await client.setMode(sid, 'MANUAL')
    const ok = await app.inject({
      method: 'POST',
      url: `/shellink/api/sessions/${sid}/input`,
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'echo hi', manual: true }),
    })
    expect(ok.statusCode).toBe(200)

    await client.setMode(sid, 'AUTO')
    const conflict = await app.inject({
      method: 'POST',
      url: `/shellink/api/sessions/${sid}/input`,
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'echo hi', manual: true }),
    })
    expect(conflict.statusCode).toBe(409)

    await client.closeSession(sid)
    await app.close()
    resetDb()
  }, 30_000)
})

describe('WebhookService validation', () => {
  it('rejects an invalid webhook URL with 400', async () => {
    resetDb()
    const app: FastifyInstance = await buildApp({ logger: false, skipMarkStale: true })
    const res = await app.inject({
      method: 'POST',
      url: '/shellink/api/webhooks',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: JSON.stringify({ url: 'not-a-url' }),
    })
    expect(res.statusCode).toBe(400)
    await app.close()
    resetDb()
  })
})

describe('WebhookInboxService overflow', () => {
  it('caps stored messages at 200 and drops the oldest', () => {
    const svc = new WebhookInboxService()
    for (let i = 0; i < 205; i++) svc.receive({ i })
    const list = svc.list()
    expect(list.length).toBe(200)
    expect((list[list.length - 1]!.data as { i: number }).i).toBe(5)
    expect((list[0]!.data as { i: number }).i).toBe(204)
  })
})
