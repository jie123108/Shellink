import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'
import { TestClient } from '../helpers/client.js'
import { resetDb } from '../helpers/resetDb.js'

describe('profiles API', () => {
  let app: FastifyInstance
  let client: TestClient

  beforeEach(async () => {
    resetDb()
    app = await buildApp({ logger: false, skipMarkStale: true })
    client = new TestClient({ kind: 'inject', app }, 'test-token')
  })

  afterEach(async () => {
    resetDb()
    await app.close()
  })

  it('CRUD ssh profile without leaking secrets', async () => {
    const created = await client.createProfile({
      name: 'prod',
      connectType: 'ssh',
      host: '10.0.0.1',
      username: 'root',
      password: 's3cret',
    })
    expect(created.status).toBe(201)
    const body = created.json as Record<string, unknown>
    expect(body.hasPassword).toBe(true)
    expect(body).not.toHaveProperty('password')
    expect(body).not.toHaveProperty('encryptedPassword')

    const id = body.id as string
    const got = await client.getProfile(id)
    expect(got.status).toBe(200)

    const listed = await client.listProfiles('prod')
    expect((listed.json as unknown[]).length).toBe(1)

    const updated = await client.updateProfile(id, { name: 'prod2', password: '',
    })
    expect((updated.json as { name: string; hasPassword: boolean }).name).toBe('prod2')
    expect((updated.json as { hasPassword: boolean }).hasPassword).toBe(false)

    const del = await client.deleteProfile(id)
    expect(del.status).toBe(204)
    expect((await client.getProfile(id)).status).toBe(404)
  })

  it('rejects command profile without command and ssh without host', async () => {
    const command = await client.createProfile({ name: 'c', connectType: 'command', command: '' })
    expect(command.status).toBe(400)
    const ssh = await client.createProfile({ name: 's', connectType: 'ssh', host: '', username: 'u' })
    expect(ssh.status).toBe(400)
  })

  it('creates command profile', async () => {
    const res = await client.createProfile({
      name: 'expect-jump',
      connectType: 'command',
      command: 'expect jump.exp',
      host: '',
      username: '',
    })
    expect(res.status).toBe(201)
    expect((res.json as { connectType: string }).connectType).toBe('command')
  })

  it('filters profiles by name, SSH host or IP, and command', async () => {
    const byName = await client.createProfile({ name: 'staging-bastion', connectType: 'ssh', host: 'bastion.internal', username: 'ops' })
    const byIp = await client.createProfile({ name: 'database', connectType: 'ssh', host: '10.0.0.24', username: 'dba' })
    const byCommand = await client.createProfile({ name: 'jump', connectType: 'command', command: 'expect connect-production.exp' })

    for (const [query, expected] of [
      ['STAGING', byName.json],
      ['10.0.0.24', byIp.json],
      ['production.exp', byCommand.json],
    ] as const) {
      const listed = await client.listProfiles(query)
      expect(listed.status).toBe(200)
      expect(listed.json).toMatchObject([{ id: (expected as { id: string }).id }])
      expect(listed.json).toHaveLength(1)
    }
  })

  it('stores uniqueId, enforces uniqueness, supports clear and search', async () => {
    const created = await client.createProfile({
      name: 'host-a',
      connectType: 'ssh',
      host: '10.0.0.1',
      username: 'root',
      uniqueId: '10.0.0.1',
    })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ uniqueId: '10.0.0.1', name: 'host-a' })

    const conflict = await client.createProfile({
      name: 'host-a-dup',
      connectType: 'ssh',
      host: '10.0.0.2',
      username: 'root',
      uniqueId: '10.0.0.1',
    })
    expect(conflict.status).toBe(409)

    const id = (created.json as { id: string }).id
    const renamed = await client.updateProfile(id, { name: 'host-a-renamed', uniqueId: 'bastion.internal' })
    expect(renamed.status).toBe(200)
    expect(renamed.json).toMatchObject({ name: 'host-a-renamed', uniqueId: 'bastion.internal' })

    const byUniqueId = await client.listProfiles('bastion.internal')
    expect(byUniqueId.status).toBe(200)
    expect(byUniqueId.json).toMatchObject([{ id }])

    const cleared = await client.updateProfile(id, { uniqueId: null })
    expect(cleared.status).toBe(200)
    expect((cleared.json as { uniqueId: string | null }).uniqueId).toBeNull()

    const reused = await client.createProfile({
      name: 'host-b',
      connectType: 'ssh',
      host: '10.0.0.3',
      username: 'root',
      uniqueId: 'bastion.internal',
    })
    expect(reused.status).toBe(201)
    expect(reused.json).toMatchObject({ uniqueId: 'bastion.internal' })
  })
})

describe('agent doc and health', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildApp({ logger: false, skipMarkStale: true })
  })
  afterEach(async () => {
    await app.close()
  })

  it('serves healthz and agent.md', async () => {
    const client = new TestClient({ kind: 'inject', app })
    expect((await client.healthz()).json).toMatchObject({ ok: true })
    const doc = await client.agentMd()
    expect(doc.status).toBe(200)
    const text = doc.body.toString('utf8')
    expect(text).toContain('Shellink')
    expect(text).toContain('POST /shellink/api/profiles')
    expect(text).toContain('PUT /shellink/api/profiles/{id}')
    expect(text).not.toContain('DELETE /shellink/api/profiles/{id}')
    expect(text).toContain('promptRegex')
    expect(text).toContain('profile list --query')
    const web = await app.inject({ method: 'GET', url: '/shellink/ui/' })
    expect(web.statusCode).toBe(200)
    expect(web.headers['content-type']).toContain('text/html')
    expect(web.body).toContain('<div id="app">')
    const assetPath = /src="([^"]+\.js)"/.exec(web.body)?.[1]
    expect(assetPath).toMatch(/^\/shellink\/ui\/assets\//)
    const asset = await app.inject({ method: 'GET', url: assetPath! })
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['content-type']).toContain('javascript')
    expect(asset.headers['cache-control']).toContain('immutable')
    const favicon = await app.inject({ method: 'GET', url: '/shellink/ui/favicon.png' })
    expect(favicon.statusCode).toBe(200)
    expect(favicon.headers['content-type']).toContain('image/png')
    expect(favicon.headers['cache-control']).toBe('no-cache')
    expect(favicon.rawPayload.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const spaRoute = await app.inject({ method: 'GET', url: '/shellink/ui/profiles/example' })
    expect(spaRoute.statusCode).toBe(200)
    expect(spaRoute.headers['content-type']).toContain('text/html')
    expect(spaRoute.body).toContain('<div id="app">')
    const status = await app.inject({ method: 'GET', url: '/shellink/api/sessions' })
    expect(status.statusCode).toBe(200)
  })
})

describe('webhooks API', () => {
  let app: FastifyInstance
  let client: TestClient

  beforeEach(async () => {
    resetDb()
    app = await buildApp({ logger: false, skipMarkStale: true })
    client = new TestClient({ kind: 'inject', app }, 'test-token')
  })
  afterEach(async () => {
    resetDb()
    await app.close()
    vi.unstubAllGlobals()
  })

  it('CRUD and dispatches on bus events', async () => {
    const fetches: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        fetches.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
        return new Response('ok', { status: 200 })
      }),
    )

    const created = await client.createWebhook('http://127.0.0.1:9/hook', ['state', 'loginExternal'])
    expect(created.status).toBe(201)
    const id = (created.json as { id: string }).id

    const { bus } = await import('../../src/core/events.js')
    bus.emit('session.state', {
      sessionId: 'abc',
      state: 'WAITING_INPUT',
      prevState: 'CONNECTING',
      at: Date.now(),
    })
    bus.emit('session.loginExternal', { sessionId: 'abc', hint: 'OTP' })
    bus.emit('session.closed', { sessionId: 'abc', reason: 'x', exitCode: 0 })

    await new Promise((r) => setTimeout(r, 50))
    expect(fetches.some((f) => (f.body as { event: string }).event === 'state')).toBe(true)
    expect(fetches.some((f) => (f.body as { event: string }).event === 'loginExternal')).toBe(true)
    // closed not subscribed
    expect(fetches.some((f) => (f.body as { event: string }).event === 'closed')).toBe(false)

    expect((await client.listWebhooks()).status).toBe(200)
    expect((await client.deleteWebhook(id)).status).toBe(204)
  })

  it('receives callback messages in memory', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/shellink/webhook/callback',
      remoteAddress: '8.8.8.8',
      headers: { host: 'example.com', 'content-type': 'application/json' },
      payload: JSON.stringify({ event: 'build.completed', value: 1 }),
    })
    expect(first.statusCode).toBe(202)

    await client.receiveWebhook({ event: 'deploy.completed', value: 2 })
    const listed = await client.listWebhookMessages()
    expect(listed.status).toBe(200)
    expect(listed.json).toMatchObject([
      { data: { event: 'deploy.completed', value: 2 } },
      { data: { event: 'build.completed', value: 1 } },
    ])

    expect((await client.clearWebhookMessages()).status).toBe(204)
    expect((await client.listWebhookMessages()).json).toEqual([])
  })
})
