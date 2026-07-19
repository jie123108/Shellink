import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../../src/app.js'
import { db, schema } from '../../src/db/index.js'
import { sessionManager } from '../../src/core/SessionManager.js'
import { TestClient, waitForState } from '../helpers/client.js'
import { resetDb } from '../helpers/resetDb.js'

function insertClosedSession(opts: {
  id: string
  createdAt: number
  closedAt: number
  withHistory?: boolean
}) {
  db.insert(schema.sessions)
    .values({
      id: opts.id,
      profileId: 'p1',
      profileName: 'purge-profile',
      target: 'bash',
      state: 'DISCONNECTED',
      mode: 'AUTO',
      cols: 80,
      rows: 24,
      createdAt: opts.createdAt,
      closedAt: opts.closedAt,
      closeReason: 'test',
    })
    .run()
  if (opts.withHistory) {
    db.insert(schema.historyChunks)
      .values({
        sessionId: opts.id,
        seq: 1,
        direction: 'output',
        dataRaw: 'hello',
        dataPlain: 'hello',
        createdAt: opts.closedAt,
      })
      .run()
  }
}

describe('DELETE /api/sessions/records', () => {
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

  it('allows local deletes without a token; remote still requires Bearer', async () => {
    const localNoToken = await app.inject({
      method: 'DELETE',
      url: '/shellink/api/sessions/records?olderThan=all',
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1:7070' },
    })
    expect(localNoToken.statusCode).toBe(200)
    expect(localNoToken.json()).toEqual({ ok: true, deleted: 0 })

    const remoteNoToken = await app.inject({
      method: 'DELETE',
      url: '/shellink/api/sessions/records?olderThan=all',
      remoteAddress: '10.0.0.1',
      headers: { host: 'example.com' },
    })
    expect(remoteNoToken.statusCode).toBe(401)

    const remoteBadToken = await app.inject({
      method: 'DELETE',
      url: '/shellink/api/sessions/records?olderThan=all',
      remoteAddress: '10.0.0.1',
      headers: { host: 'example.com', authorization: 'Bearer wrong-token' },
    })
    expect(remoteBadToken.statusCode).toBe(401)
  })

  it('rejects invalid olderThan values', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/shellink/api/sessions/records?olderThan=1h',
      headers: { authorization: 'Bearer test-token' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('purges by 24h / 7d boundaries, keeps active sessions, and clears history', async () => {
    const now = Date.now()
    insertClosedSession({
      id: 'old7dxx1',
      createdAt: now - 10 * 24 * 60 * 60 * 1000,
      closedAt: now - 8 * 24 * 60 * 60 * 1000,
      withHistory: true,
    })
    insertClosedSession({
      id: 'old1dxx2',
      createdAt: now - 3 * 24 * 60 * 60 * 1000,
      closedAt: now - 30 * 60 * 60 * 1000,
      withHistory: true,
    })
    insertClosedSession({
      id: 'recentxx3',
      createdAt: now - 2 * 60 * 60 * 1000,
      closedAt: now - 30 * 60 * 1000,
      withHistory: true,
    })

    const profile = await client.createProfile({
      name: 'purge-live',
      connectType: 'command',
      command: "bash --norc --noprofile -c 'export PS1=\"$ \"; exec bash --norc --noprofile'",
      promptRegex: '[$#]\\s*$',
    })
    const liveId = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string }).id
    await waitForState(client, liveId, ['WAITING_INPUT'], 20_000)

    const week = await client.purgeClosedRecords('7d')
    expect(week.status).toBe(200)
    expect(week.json).toEqual({ ok: true, deleted: 1 })
    expect(db.select().from(schema.sessions).where(eq(schema.sessions.id, 'old7dxx1')).get()).toBeUndefined()
    expect(db.select().from(schema.historyChunks).where(eq(schema.historyChunks.sessionId, 'old7dxx1')).all()).toHaveLength(0)
    expect(db.select().from(schema.sessions).where(eq(schema.sessions.id, 'old1dxx2')).get()).toBeTruthy()

    const day = await client.purgeClosedRecords('24h')
    expect(day.status).toBe(200)
    expect(day.json).toEqual({ ok: true, deleted: 1 })
    expect(db.select().from(schema.sessions).where(eq(schema.sessions.id, 'old1dxx2')).get()).toBeUndefined()
    expect(db.select().from(schema.historyChunks).where(eq(schema.historyChunks.sessionId, 'old1dxx2')).all()).toHaveLength(0)
    expect(db.select().from(schema.sessions).where(eq(schema.sessions.id, 'recentxx3')).get()).toBeTruthy()

    const all = await client.purgeClosedRecords('all')
    expect(all.status).toBe(200)
    expect(all.json).toEqual({ ok: true, deleted: 1 })
    expect(db.select().from(schema.sessions).where(eq(schema.sessions.id, 'recentxx3')).get()).toBeUndefined()
    expect(sessionManager.get(liveId)).toBeTruthy()
    expect(db.select().from(schema.sessions).where(eq(schema.sessions.id, liveId)).get()).toBeTruthy()
  }, 60_000)
})
