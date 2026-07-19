import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { TestClient, waitForState } from '../helpers/client.js'
import { resetDb } from '../helpers/resetDb.js'

describe('sessions API edge paths', () => {
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

  it('covers llms.txt, bad create, download missing, delete disconnected', async () => {
    const llms = await app.inject({ method: 'GET', url: '/shellink/llms.txt' })
    expect(llms.statusCode).toBe(200)

    const bad = await client.createSession('no-such-profile')
    expect(bad.status).toBe(404)

    const profile = await client.createProfile({
      name: 'edge-bash',
      connectType: 'command',
      command: "bash --norc --noprofile -c 'export PS1=\"$ \"; exec bash --norc --noprofile'",
      promptRegex: '[$#]\\s*$',
    })
    const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string }).id
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)

    const miss = await client.download(sid, '/tmp/does-not-exist-sp-test')
    expect([404, 502]).toContain(miss.status)

    const badEdit = await client.edit(sid, '/tmp/x', [])
    expect(badEdit.status).toBe(400)

    await client.closeSession(sid)
    await new Promise((r) => setTimeout(r, 600))
    const again = await client.closeSession(sid)
    expect(again.status).toBe(200)

    const localNoToken = await app.inject({
      method: 'DELETE',
      url: `/shellink/api/sessions/${sid}/record`,
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1:7070' },
    })
    expect(localNoToken.statusCode).toBe(200)

    const remoteNoToken = await app.inject({
      method: 'DELETE',
      url: `/shellink/api/sessions/${sid}/record`,
      remoteAddress: '10.0.0.1',
      headers: { host: 'example.com' },
    })
    expect(remoteNoToken.statusCode).toBe(401)
  }, 60_000)
})
