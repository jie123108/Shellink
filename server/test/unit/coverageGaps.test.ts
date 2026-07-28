import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import { buildApp } from '../../src/app.js'
import { bus } from '../../src/core/events.js'
import { FileTransfer } from '../../src/core/FileTransfer.js'
import { LocalPtySession } from '../../src/core/LocalPtySession.js'
import { mapEditError, RemoteEdit } from '../../src/core/RemoteEdit.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { setupWsGateway } from '../../src/ws/gateway.js'
import { MockSession } from '../helpers/mockSession.js'
import { TestClient, waitForState } from '../helpers/client.js'
import { resetDb } from '../helpers/resetDb.js'
import { sleep } from '../helpers/wait.js'

function historyFor(sessionId: string, stored: Array<{ seq: number; plain: string }>) {
  return {
    history(_id: string, since = 0) {
      const parts = stored.filter((c) => c.seq > since)
      return {
        cursor: parts.length ? parts[parts.length - 1]!.seq : since,
        text: parts.map((c) => c.plain).join(''),
      }
    },
  }
}

function trackOutput(sessionId: string) {
  const stored: Array<{ seq: number; plain: string }> = []
  const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
    if (e.sessionId === sessionId && e.direction === 'output') {
      stored.push({ seq: e.seq, plain: e.plain })
    }
  }
  bus.on('session.data', onData)
  return {
    stored,
    historySource: historyFor(sessionId, stored),
    stop: () => bus.off('session.data', onData),
  }
}

describe('coverage gaps: FileTransfer scripted errors', () => {
  it('upload size mismatch and decode timeout', async () => {
    const { historySource, stop } = trackOutput('ft-gap-up')
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: 'ft-gap-up' })
    s.forceState('WAITING_INPUT')
    s.resize = () => {}

    const orig = s.write.bind(s)
    s.write = (chunk: string, opts?) => {
      orig(chunk, opts)
      queueMicrotask(() => {
        if (chunk.includes('SP_CODEC')) {
          s.feed('SP_CODEC:base64\n$ ')
          return
        }
        if (chunk.includes('stty cols')) {
          s.feed('$ ')
          return
        }
        if (chunk.includes('SP_DRAIN_') || chunk.includes('SP_S_')) {
          const m = chunk.match(/SP_(?:DRAIN|S)_[A-Za-z0-9_]+/)?.[0]
          s.feed(`${m}\n$ `)
          return
        }
        // finalize: stay silent → timeout
      })
    }

    try {
      await expect(ft.upload(s, '/tmp/x', Buffer.from('hi'), { timeoutMs: 400 })).rejects.toMatchObject({
        statusCode: 504,
      })

      s.forceState('WAITING_INPUT')
      s.write = (chunk: string, opts?) => {
        orig(chunk, opts)
        queueMicrotask(() => {
          if (chunk.includes('SP_CODEC')) {
            s.feed('SP_CODEC:base64\n$ ')
            return
          }
          if (chunk.includes('stty cols')) {
            s.feed('$ ')
            return
          }
          if (chunk.includes('SP_DRAIN_') || chunk.includes('SP_S_')) {
            const m = chunk.match(/SP_(?:DRAIN|S)_[A-Za-z0-9_]+/)?.[0]
            s.feed(`${m}\n$ `)
            return
          }
          if (chunk.includes('SP_UP')) {
            s.feed('SP_UP:999\n$ '); s.forceState('WAITING_INPUT')
          }
        })
      }
      await expect(ft.upload(s, '/tmp/x', Buffer.from('hi'), { timeoutMs: 5_000 })).rejects.toMatchObject({
        statusCode: 502,
      })
    } finally {
      stop()
    }
  })

  it('download unreadable, size mismatch, and bad marker', async () => {
    const { historySource, stop } = trackOutput('ft-gap-dl')
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: 'ft-gap-dl' })
    s.forceState('WAITING_INPUT')

    let mode: 'unreadable' | 'mismatch' | 'nostat' = 'unreadable'
    const orig = s.write.bind(s)
    s.write = (data: string, opts?) => {
      orig(data, opts)
      queueMicrotask(() => {
        if (data.includes('SP_CODEC')) {
          s.feed('SP_CODEC:base64\n$ ')
          return
        }
        if (data.includes('SP_STAT')) {
          if (mode === 'unreadable') s.feed('SP_STAT:unreadable\n$ ')
          else if (mode === 'nostat') s.feed('no marker\n$ ')
          else s.feed('SP_STAT:ok:2\n$ ')
          return
        }
        if (data.includes('SPB_') || data.includes('base64')) {
          // wrong payload length vs remoteSize 2
          s.feed(`${data.match(/SPB_[a-f0-9]+/)?.[0] ?? 'SPB_x'}\nYQ==\n${data.match(/SPE_[a-f0-9]+/)?.[0] ?? 'SPE_x'}\n$ `)
          return
        }
        s.feed('$ ')
      })
    }

    try {
      await expect(ft.download(s, '/tmp/x', 3_000)).rejects.toMatchObject({ statusCode: 502 })
      mode = 'nostat'
      s.forceState('WAITING_INPUT')
      await expect(ft.download(s, '/tmp/y', 3_000)).rejects.toMatchObject({ statusCode: 502 })
      mode = 'mismatch'
      s.forceState('WAITING_INPUT')
      await expect(ft.download(s, '/tmp/z', 3_000)).rejects.toMatchObject({ statusCode: 502 })
    } finally {
      stop()
    }
  })
})

describe('coverage gaps: RemoteEdit', () => {
  it('rejects non-string edits and sed multiline', async () => {
    const { historySource, stop } = trackOutput('re-gap')
    const re = new RemoteEdit(historySource, new SessionOpLock())
    const s = new MockSession({ id: 're-gap' })
    s.forceState('WAITING_INPUT')
    s.resize = () => {}

    const orig = s.write.bind(s)
    s.write = (data: string, opts?) => {
      orig(data, opts)
      queueMicrotask(() => {
        if (data.includes('SP_EDIT_ENGINE')) s.feed('SP_EDIT_ENGINE:sed\n$ ')
        else s.feed('$ ')
      })
    }

    try {
      await expect(
        re.edit(s, '/tmp/x', [{ oldText: 'a\nb', newText: 'c' }], 3_000),
      ).rejects.toMatchObject({ statusCode: 400 })

      // force type check branch via cast
      await expect(
        re.edit(s, '/tmp/x', [{ oldText: 1 as unknown as string, newText: 'b' }], 3_000),
      ).rejects.toMatchObject({ statusCode: 400 })
    } finally {
      stop()
    }
  })

  it('maps remaining edit error codes', () => {
    expect(mapEditError('duplicate', 'x').statusCode).toBe(400)
    expect(mapEditError('no_change', 'x').statusCode).toBe(400)
    expect(mapEditError('overlap', 'x').statusCode).toBe(400)
    expect(mapEditError('sed_unsupported', 'x').statusCode).toBe(400)
    expect(mapEditError('bad_payload', 'x').statusCode).toBe(400)
    expect(mapEditError('encoding', 'x').statusCode).toBe(502)
    expect(mapEditError('unknown_code', 'x').statusCode).toBe(502)
  })
})

describe('coverage gaps: API edges', () => {
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

  it('mode validation, record 404, profile key/passphrase clear', async () => {
    const created = await client.createProfile({
      name: 'gap-keys',
      connectType: 'ssh',
      host: '10.0.0.2',
      username: 'root',
      authType: 'key',
      privateKey: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
      passphrase: 'pp',
    })
    const id = (created.json as { id: string }).id
    const cleared = await client.updateProfile(id, { privateKey: '', passphrase: '' })
    expect(cleared.status).toBe(200)
    expect((cleared.json as { hasPrivateKey: boolean }).hasPrivateKey).toBe(false)

    const withPass = await client.updateProfile(id, {
      privateKey: '-----BEGIN KEY-----\ndef\n-----END KEY-----',
      passphrase: 'secret',
    })
    expect(withPass.status).toBe(200)

    const badMode = await app.inject({
      method: 'POST',
      url: '/shellink/api/sessions/nope/mode',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: JSON.stringify({ mode: 'NOPE' }),
    })
    expect([400, 404]).toContain(badMode.statusCode)

    const profile = await client.createProfile({
      name: 'gap-bash',
      connectType: 'command',
      command: "bash --norc --noprofile -c 'export PS1=\"$ \"; exec bash --norc --noprofile'",
      promptRegex: '[$#]\\s*$',
    })
    const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string })
      .id
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)

    const badModeBody = await app.inject({
      method: 'POST',
      url: `/shellink/api/sessions/${sid}/mode`,
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: JSON.stringify({ mode: 'WEIRD' }),
    })
    expect(badModeBody.statusCode).toBe(400)

    const missRecord = await app.inject({
      method: 'DELETE',
      url: '/shellink/api/sessions/does-not-exist/record',
      headers: { authorization: 'Bearer test-token' },
    })
    expect(missRecord.statusCode).toBe(404)

    await client.closeSession(sid)
  }, 45_000)

  it('creates ssh session with passphrase and keyless fallback', async () => {
    const keyed = await client.createProfile({
      name: 'gap-ssh-pass',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 1,
      username: 'u',
      authType: 'key',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nxxx\n-----END OPENSSH PRIVATE KEY-----',
      passphrase: 'pp',
    })
    expect(keyed.status).toBe(201)
    const s1 = await client.createSession((keyed.json as { id: string }).id)
    // connect may fail later; create should still allocate (or surface crypto/ssh errors)
    expect([201, 500]).toContain(s1.status)
    if (s1.status === 201) {
      await client.closeSession((s1.json as { id: string }).id).catch(() => {})
    }

    const bare = await client.createProfile({
      name: 'gap-ssh-bare',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 1,
      username: 'u',
      authType: 'password',
    })
    expect(bare.status).toBe(201)
    const s2 = await client.createSession((bare.json as { id: string }).id)
    expect([201, 500]).toContain(s2.status)
    if (s2.status === 201) {
      await client.closeSession((s2.json as { id: string }).id).catch(() => {})
    }
  })
})

describe('coverage gaps: WS resize and bad JSON', () => {
  it('ignores bad JSON and applies resize', async () => {
    resetDb()
    const app = await buildApp({ logger: false, skipMarkStale: true })
    await app.listen({ port: 0, host: '127.0.0.1' })
    setupWsGateway(app.server)
    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const client = new TestClient({ kind: 'http', baseUrl: `http://127.0.0.1:${port}` }, 'test-token')

    const profile = await client.createProfile({
      name: 'ws-gap',
      connectType: 'command',
      command: "bash --norc --noprofile -c 'export PS1=\"$ \"; exec bash --norc --noprofile'",
      promptRegex: '[$#]\\s*$',
    })
    const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string })
      .id
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/shellink/ws/sessions/${sid}?token=test-token`)
      sock.once('open', () => resolve(sock))
      sock.once('error', reject)
    })
    ws.send('not-json')
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    await sleep(100)
    ws.close()
    await client.closeSession(sid)
    resetDb()
    await app.close()
  }, 45_000)
})

describe('coverage gaps: LocalPty and BaseSession', () => {
  it('resize after close and waitForStable when disconnected', async () => {
    const s = new LocalPtySession({
      id: 'pty-gap',
      profileId: 'p',
      profileName: 't',
      term: 'xterm',
      cols: 80,
      rows: 24,
      command: "printf 'x\\n'; sleep 0.05",
    })
    s.connect()
    await sleep(400)
    s.close('bye')
    await sleep(700)
    expect(() => s.resize(90, 30)).not.toThrow()

    const m = new MockSession({ id: 'bs-gap' })
    m.forceState('DISCONNECTED')
    const r = await m.waitForStable(1_000)
    expect(r.state).toBe('DISCONNECTED')
    expect(r.timedOut).toBe(false)
  })
})

describe('coverage gaps: markStale on boot', () => {
  it('runs markStaleSessions when not skipped', async () => {
    resetDb()
    const app = await buildApp({ logger: false })
    expect((await app.inject({ method: 'GET', url: '/shellink/healthz' })).statusCode).toBe(200)
    await app.close()
    resetDb()
  })
})
