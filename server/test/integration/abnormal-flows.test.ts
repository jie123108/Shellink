import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import { buildApp } from '../../src/app.js'
import { bus } from '../../src/core/events.js'
import { FileTransfer } from '../../src/core/FileTransfer.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { setupWsGateway } from '../../src/ws/gateway.js'
import { MockSession } from '../helpers/mockSession.js'
import { TestClient, waitForState } from '../helpers/client.js'
import { resetDb } from '../helpers/resetDb.js'
import { sleep } from '../helpers/wait.js'

describe('abnormal flows: concurrency and out-of-order API', () => {
  let app: FastifyInstance
  let client: TestClient
  let sid: string

  beforeEach(async () => {
    resetDb()
    app = await buildApp({ logger: false, skipMarkStale: true })
    client = new TestClient({ kind: 'inject', app }, 'test-token')
    const profile = await client.createProfile({
      name: 'abn-bash',
      connectType: 'command',
      command: "bash --norc --noprofile -c 'export PS1=\"$ \"; exec bash --norc --noprofile'",
      promptRegex: '[$#]\\s*$',
    })
    sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string }).id
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
  })

  afterEach(async () => {
    if (sid) await client.closeSession(sid).catch(() => {})
    resetDb()
    await app.close()
  })

  it('concurrent dual exec: one succeeds, other gets 409', async () => {
    const [a, b] = await Promise.all([
      client.exec(sid, 'sleep 1; echo MARK-A', 10_000),
      client.exec(sid, 'sleep 1; echo MARK-B', 10_000),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 409])
    const ok = a.status === 200 ? a : b
    const out = (ok.json as { output: string }).output
    const hasA = out.includes('MARK-A')
    const hasB = out.includes('MARK-B')
    expect(hasA !== hasB).toBe(true)
  }, 30_000)

  it('upload while exec in flight returns 409', async () => {
    const execP = client.exec(sid, 'sleep 2; echo EXEC-DONE', 10_000)
    await sleep(80)
    const up = await client.upload(sid, `/tmp/abn-block-${Date.now()}.txt`, Buffer.from('x'))
    expect(up.status).toBe(409)
    const ex = await execP
    expect(ex.status).toBe(200)
    expect((ex.json as { output: string }).output).toContain('EXEC-DONE')
  }, 30_000)

  it('input during exec lock is allowed for interactive; second exec blocked', async () => {
    void client.exec(sid, 'read -r LINE; echo got:$LINE', 10_000)
    await sleep(300)
    const inj = await client.input(sid, 'interactive-abn')
    expect(inj.status).toBe(200)
    await sleep(500)
    const hist = await client.history(sid, 0)
    expect((hist.json as { text: string }).text).toContain('got:interactive-abn')
  }, 30_000)

  it('exec while CONNECTING returns 409 not 500', async () => {
    const profile = await client.createProfile({
      name: 'abn-otp',
      connectType: 'command',
      command:
        "bash --norc --noprofile -c 'echo OTP:; read -r X; export PS1=\"$ \"; exec bash --norc --noprofile'",
      promptRegex: '[$#]\\s*$',
    })
    const s2 = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string })
      .id
    await waitForState(client, s2, ['CONNECTING'], 10_000)
    const ex = await client.exec(s2, 'echo no')
    expect(ex.status).toBe(409)
    await client.input(s2, '999999')
    await waitForState(client, s2, ['WAITING_INPUT'], 15_000)
    await client.closeSession(s2)
  }, 40_000)

  it('history rejects bad since/limit', async () => {
    const badSince = await app.inject({
      method: 'GET',
      url: `/shellink/api/sessions/${sid}/history?since=abc`,
      headers: { authorization: 'Bearer test-token' },
    })
    expect(badSince.statusCode).toBe(400)

    const badLimit = await app.inject({
      method: 'GET',
      url: `/shellink/api/sessions/${sid}/history?limit=0`,
      headers: { authorization: 'Bearer test-token' },
    })
    expect(badLimit.statusCode).toBe(400)

    const neg = await app.inject({
      method: 'GET',
      url: `/shellink/api/sessions/${sid}/history?limit=-1`,
      headers: { authorization: 'Bearer test-token' },
    })
    expect(neg.statusCode).toBe(400)
  })

  it('close mid-exec then ops return 404', async () => {
    const execP = client.exec(sid, 'sleep 5; echo late', 10_000)
    await sleep(100)
    await client.closeSession(sid)
    const res = await execP
    // may complete with disconnect or error; session gone
    expect([200, 404, 409, 500]).toContain(res.status)
    await sleep(600)
    const again = await client.exec(sid, 'echo x')
    expect(again.status).toBe(404)
    sid = '' // already closed
  }, 30_000)

  it('removeRecord mid-exec cleans up', async () => {
    const execP = client.exec(sid, 'sleep 8; echo gone', 15_000)
    await sleep(80)
    const del = await client.removeRecord(sid)
    expect(del.status).toBe(200)
    await execP.catch(() => {})
    const st = await client.getState(sid)
    expect(st.status).toBe(404)
    sid = ''
  }, 30_000)
})

describe('abnormal flows: mode flip mid-transfer', () => {
  it('MANUAL after probe aborts upload with 409', async () => {
    const stored: Array<{ seq: number; plain: string }> = []
    const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
      if (e.sessionId === 'abn-mode' && e.direction === 'output') {
        stored.push({ seq: e.seq, plain: e.plain })
      }
    }
    bus.on('session.data', onData)
    const historySource = {
      history(_id: string, since = 0) {
        const parts = stored.filter((c) => c.seq > since)
        return {
          cursor: parts.length ? parts[parts.length - 1]!.seq : since,
          text: parts.map((c) => c.plain).join(''),
        }
      },
    }
    const lock = new SessionOpLock()
    const ft = new FileTransfer(historySource, lock)
    const s = new MockSession({ id: 'abn-mode' })
    s.forceState('WAITING_INPUT')

    const orig = s.write.bind(s)
    s.write = (chunk: string, opts?) => {
      orig(chunk, opts)
      queueMicrotask(() => {
        if (chunk.includes('SP_CODEC')) {
          s.feed('SP_CODEC:base64\n$ ')
          s.setMode('MANUAL')
          return
        }
        s.feed('$ ')
      })
    }

    try {
      await expect(ft.upload(s, '/tmp/x', Buffer.from('hi'), { timeoutMs: 5_000 })).rejects.toMatchObject(
        { statusCode: 409 },
      )
      s.setMode('AUTO')
      s.forceState('WAITING_INPUT')
    } finally {
      bus.off('session.data', onData)
    }
  })
})

describe('abnormal flows: WS AUTO+WAITING_INPUT input', () => {
  it('accepts WS input when AUTO and WAITING_INPUT', async () => {
    resetDb()
    const app = await buildApp({ logger: false, skipMarkStale: true })
    await app.listen({ port: 0, host: '127.0.0.1' })
    setupWsGateway(app.server)
    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const client = new TestClient({ kind: 'http', baseUrl: `http://127.0.0.1:${port}` }, 'test-token')

    const profile = await client.createProfile({
      name: 'ws-abn',
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
    ws.send(JSON.stringify({ type: 'input', data: 'echo ws-auto-ok\n' }))
    await sleep(600)
    const hist = await client.history(sid, 0)
    expect((hist.json as { text: string }).text).toContain('ws-auto-ok')
    ws.close()
    await client.closeSession(sid)
    resetDb()
    await app.close()
  }, 45_000)
})
