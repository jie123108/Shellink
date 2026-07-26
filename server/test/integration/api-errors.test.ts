import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { bus } from '../../src/core/events.js'
import { FileTransfer } from '../../src/core/FileTransfer.js'
import { RemoteEdit } from '../../src/core/RemoteEdit.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { config } from '../../src/config.js'
import { TestClient, waitForState } from '../helpers/client.js'
import { MockSession } from '../helpers/mockSession.js'
import { resetDb } from '../helpers/resetDb.js'

describe('API error paths', () => {
  let app: FastifyInstance
  let client: TestClient
  let sid: string

  beforeEach(async () => {
    resetDb()
    app = await buildApp({ logger: false, skipMarkStale: true })
    client = new TestClient({ kind: 'inject', app }, 'test-token')
    const profile = await client.createProfile({
      name: 'err-bash',
      connectType: 'command',
      command: "bash --norc --noprofile -c 'export PS1=\"$ \"; exec bash --norc --noprofile'",
      promptRegex: '[$#]\\s*$',
    })
    const session = await client.createSession((profile.json as { id: string }).id)
    sid = (session.json as { id: string }).id
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
  })

  afterEach(async () => {
    if (sid) await client.closeSession(sid).catch(() => {})
    resetDb()
    await app.close()
  })

  it('upload missing path and missing file', async () => {
    const noPath = await app.inject({
      method: 'POST',
      url: `/shellink/api/sessions/${sid}/upload`,
      headers: { authorization: 'Bearer test-token' },
    })
    expect(noPath.statusCode).toBe(400)

    const boundary = '----ErrBoundary'
    const raw = Buffer.from(`--${boundary}--\r\n`)
    const noFile = await app.inject({
      method: 'POST',
      url: `/shellink/api/sessions/${sid}/upload?path=/tmp/x`,
      headers: {
        authorization: 'Bearer test-token',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: raw,
    })
    expect([400, 500]).toContain(noFile.statusCode)
  })

  it('upload sha256 mismatch', async () => {
    const data = Buffer.from('abc')
    const up = await client.upload(sid, '/tmp/sp-sha.txt', data, { sha256: '00'.repeat(32) })
    expect(up.status).toBe(400)
  })

  it('invalid download timeoutMs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/shellink/api/sessions/${sid}/download?path=/tmp/x&timeoutMs=10`,
      headers: { authorization: 'Bearer test-token' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('MANUAL blocks input exec and download', async () => {
    await client.setMode(sid, 'MANUAL')
    expect((await client.input(sid, 'x')).status).toBe(409)
    expect((await client.exec(sid, 'echo x')).status).toBe(409)
    expect((await client.download(sid, '/tmp/x')).status).toBe(409)
    await client.setMode(sid, 'AUTO')
  })

  it('edit validation errors', async () => {
    const empty = await client.edit(sid, '/tmp/x', [])
    expect(empty.status).toBe(400)
  })

  it('detach start validation and error mapping', async () => {
    const noPath = await app.inject({
      method: 'POST',
      url: `/shellink/api/sessions/${sid}/upload-start`,
      headers: { authorization: 'Bearer test-token' },
    })
    expect(noPath.statusCode).toBe(400)

    const boundary = '----ErrDetachBoundary'
    const raw = Buffer.from(`--${boundary}--\r\n`)
    const noFile = await app.inject({
      method: 'POST',
      url: `/shellink/api/sessions/${sid}/upload-start?path=/tmp/x&timeoutMs=abc`,
      headers: {
        authorization: 'Bearer test-token',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: raw,
    })
    // invalid timeoutMs throws 400 via sendError, or 400 missing file first
    expect([400, 500]).toContain(noFile.statusCode)

    const makeUploadStart = async (timeoutMs: string) =>
      app.inject({
        method: 'POST',
        url: `/shellink/api/sessions/${sid}/upload-start?path=/tmp/x&timeoutMs=${timeoutMs}`,
        headers: {
          authorization: 'Bearer test-token',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          ),
          Buffer.from('hi'),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      })

    const badTimeout = await makeUploadStart('10')
    expect(badTimeout.statusCode).toBe(400)

    // Valid timeoutMs exercises the successful return path of timeout()
    const okTimeout = await makeUploadStart('5000')
    expect([200, 404, 409]).toContain(okTimeout.statusCode)

    const badDownload = await app.inject({
      method: 'POST',
      url: `/shellink/api/sessions/${sid}/download-start`,
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: JSON.stringify({ path: '/tmp/x' }),
    })
    expect(badDownload.statusCode).toBe(400)

    const badEdit = await app.inject({
      method: 'POST',
      url: `/shellink/api/sessions/${sid}/edit-start`,
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      payload: JSON.stringify({ path: '/tmp/x', edits: [] }),
    })
    expect(badEdit.statusCode).toBe(400)
  })
})

describe('FileTransfer error scripted paths', () => {
  it('rejects oversized upload and sha mismatch', async () => {
    const ft = new FileTransfer({ history: () => ({ cursor: 0, text: '' }) }, new SessionOpLock())
    const s = new MockSession({ id: 'ft-err1' })
    s.forceState('WAITING_INPUT')
    const big = Buffer.alloc(config.transferMaxBytes + 1)
    await expect(ft.upload(s, '/tmp/x', big)).rejects.toMatchObject({ statusCode: 413 })
    await expect(
      ft.upload(s, '/tmp/x', Buffer.from('a'), { expectedSha256: 'deadbeef' }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('probe codec none and missing file', async () => {
    const stored: Array<{ seq: number; plain: string }> = []
    const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
      if (e.sessionId === 'ft-err2' && e.direction === 'output') {
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
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: 'ft-err2' })
    s.forceState('WAITING_INPUT')

    const orig = s.write.bind(s)
    s.write = (data: string, opts?) => {
      orig(data, opts)
      queueMicrotask(() => {
        if (data.includes('SP_CODEC')) s.feed('SP_CODEC:none\n$ ')
        else s.feed('$ ')
      })
    }

    try {
      await expect(ft.download(s, '/tmp/x', 3_000)).rejects.toMatchObject({ statusCode: 502 })
    } finally {
      bus.off('session.data', onData)
    }
  })

  it('stat missing returns 404', async () => {
    const stored: Array<{ seq: number; plain: string }> = []
    const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
      if (e.sessionId === 'ft-err3' && e.direction === 'output') {
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
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: 'ft-err3' })
    s.forceState('WAITING_INPUT')
    const orig = s.write.bind(s)
    s.write = (data: string, opts?) => {
      orig(data, opts)
      queueMicrotask(() => {
        if (data.includes('SP_CODEC')) s.feed('SP_CODEC:base64\n$ ')
        else if (data.includes('SP_STAT')) s.feed('SP_STAT:missing\n$ ')
        else s.feed('$ ')
      })
    }
    try {
      await expect(ft.download(s, '/tmp/missing', 3_000)).rejects.toMatchObject({ statusCode: 404 })
    } finally {
      bus.off('session.data', onData)
    }
  })

  it('concurrent lock returns 409', async () => {
    const lock = new SessionOpLock()
    const ft = new FileTransfer({ history: () => ({ cursor: 0, text: '' }) }, lock)
    const s = new MockSession({ id: 'ft-lock' })
    s.forceState('WAITING_INPUT')
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const first = lock.withLock('ft-lock', async () => {
      await gate
    })
    await expect(ft.download(s, '/tmp/x')).rejects.toMatchObject({ statusCode: 409 })
    release()
    await first
  })
})

describe('RemoteEdit error scripted paths', () => {
  it('maps not_found and rejects multi-edit on sed', async () => {
    const stored: Array<{ seq: number; plain: string }> = []
    const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
      if (e.sessionId === 're-err' && e.direction === 'output') {
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
    const re = new RemoteEdit(historySource, new SessionOpLock())
    const s = new MockSession({ id: 're-err' })
    s.forceState('WAITING_INPUT')
    s.resize = () => {}

    const orig = s.write.bind(s)
    s.write = (data: string, opts?) => {
      orig(data, opts)
      queueMicrotask(() => {
        if (data.includes('SP_EDIT_ENGINE')) s.feed('SP_EDIT_ENGINE:sed\n$ ')
        else if (data.includes('sed ') || data.includes('grep') || data.includes('SP_EDIT')) {
          s.feed('SP_EDIT:err:not_found:Could not find the exact text\n$ ')
        } else s.feed('$ ')
      })
    }

    try {
      await expect(re.edit(s, '/tmp/x', [{ oldText: 'a', newText: 'b' }], 3_000)).rejects.toMatchObject(
        { statusCode: 400 },
      )
      await expect(
        re.edit(
          s,
          '/tmp/x',
          [
            { oldText: 'a', newText: 'b' },
            { oldText: 'c', newText: 'd' },
          ],
          3_000,
        ),
      ).rejects.toMatchObject({ statusCode: 400 })
    } finally {
      bus.off('session.data', onData)
    }
  })
})
