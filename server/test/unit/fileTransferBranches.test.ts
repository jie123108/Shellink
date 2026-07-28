import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import { bus } from '../../src/core/events.js'
import { FileTransfer } from '../../src/core/FileTransfer.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { MockSession } from '../helpers/mockSession.js'

type Step = { timedOut?: boolean; text?: string }

function makeFt(): { ft: FileTransfer; stored: Array<{ seq: number; plain: string }> } {
  const stored: Array<{ seq: number; plain: string }> = []
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
  return { ft, stored }
}

function makeSession(id: string): MockSession {
  const s = new MockSession({ id})
  s.forceState('WAITING_INPUT')
  return s
}

/**
 * Overrides waitForStable so execCapture's `startSeq`/`history()` bookkeeping
 * (based on the session's real lastSeq counter, bumped by every write()) still
 * lines up correctly: pushed text is stamped with the session's *current*
 * lastSeq, which is always >= the startSeq captured just before this call's
 * write() ran.
 */
function scriptWaitForStable(
  s: MockSession,
  stored: Array<{ seq: number; plain: string }>,
  steps: Step[],
): void {
  let i = 0
  s.waitForStable = async (_timeoutMs: number) => {
    const step = steps[i++] ?? {}
    if (step.text) stored.push({ seq: s.lastSeq, plain: step.text })
    return { state: s.state, timedOut: !!step.timedOut }
  }
}

describe('FileTransfer.download error branches', () => {
  it('reports a timeout when probing the remote codec never stabilizes', async () => {
    const { ft, stored } = makeFt()
    const s = makeSession('dl-probe-timeout')
    scriptWaitForStable(s, stored, [{ timedOut: true }])
    await expect(ft.download(s, '/tmp/x')).rejects.toMatchObject({
      message: 'Timed out probing remote encoders',
      statusCode: 504,
    })
  })

  it('reports a timeout when checking the remote file status never stabilizes', async () => {
    const { ft, stored } = makeFt()
    const s = makeSession('dl-stat-timeout')
    scriptWaitForStable(s, stored, [{ text: 'SP_CODEC:base64\n' }, { timedOut: true }])
    await expect(ft.download(s, '/tmp/x')).rejects.toMatchObject({
      message: 'Timed out checking the remote file',
      statusCode: 504,
    })
  })

  it('rejects a remote file larger than the configured transfer limit', async () => {
    const { ft, stored } = makeFt()
    const s = makeSession('dl-too-large')
    const hugeSize = config.transferMaxBytes + 1000
    scriptWaitForStable(s, stored, [{ text: 'SP_CODEC:base64\n' }, { text: `SP_STAT:ok:${hugeSize}\n` }])
    await expect(ft.download(s, '/tmp/x')).rejects.toMatchObject({ statusCode: 413 })
  })

  it('reports a timeout when the download encoding command never stabilizes', async () => {
    const { ft, stored } = makeFt()
    const s = makeSession('dl-enc-timeout')
    scriptWaitForStable(s, stored, [{ text: 'SP_CODEC:base64\n' }, { text: 'SP_STAT:ok:2\n' }, { timedOut: true }])
    await expect(ft.download(s, '/tmp/x')).rejects.toMatchObject({
      message: 'Download encoding timed out',
      statusCode: 504,
    })
  })

  it('reports a missing marker frame when the encoding output has no begin/end markers', async () => {
    const { ft, stored } = makeFt()
    const s = makeSession('dl-no-markers')
    scriptWaitForStable(s, stored, [
      { text: 'SP_CODEC:base64\n' },
      { text: 'SP_STAT:ok:2\n' },
      { text: 'unexpected output with no markers at all\n' },
    ])
    await expect(ft.download(s, '/tmp/x')).rejects.toMatchObject({
      message: expect.stringContaining('marker frame was not found'),
      statusCode: 502,
    })
  })
})

describe('FileTransfer.upload error and chunking branches', () => {
  it('reports a timeout when upload decode+verify never stabilizes', async () => {
    const { ft, stored } = makeFt()
    const s = makeSession('up-verify-timeout')
    s.resize = () => {}
    const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
      if (e.sessionId === s.id && e.direction === 'output') stored.push({ seq: e.seq, plain: e.plain })
    }
    bus.on('session.data', onData)
    const orig = s.write.bind(s)
    s.write = (chunk: string, opts?) => {
      orig(chunk, opts)
      if (chunk.includes('SP_CODEC') || chunk.includes('command -v base64')) {
        queueMicrotask(() => s.feed('SP_CODEC:base64\n$ '))
        return
      }
      if (chunk.includes('stty cols')) {
        queueMicrotask(() => s.feed('$ '))
        return
      }
      if (chunk.includes('SP_DRAIN_') || chunk.includes('SP_S_')) {
        const m = chunk.match(/SP_(?:DRAIN|S)_[A-Za-z0-9_]+/)?.[0]
        queueMicrotask(() => s.feed(`${m}\n$ `))
        return
      }
      // finalize: stay silent → marker wait times out
    }
    try {
      await expect(ft.upload(s, '/tmp/x', Buffer.from('hi'), { timeoutMs: 400 })).rejects.toMatchObject({
        message: 'Upload decoding timed out',
        statusCode: 504,
      })
    } finally {
      bus.off('session.data', onData)
    }
  })

  it('reports a missing marker when the verify output has no SP_UP marker', async () => {
    const { ft, stored } = makeFt()
    const s = makeSession('up-no-marker')
    s.resize = () => {}
    const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
      if (e.sessionId === s.id && e.direction === 'output') stored.push({ seq: e.seq, plain: e.plain })
    }
    bus.on('session.data', onData)
    const orig = s.write.bind(s)
    s.write = (chunk: string, opts?) => {
      orig(chunk, opts)
      if (chunk.includes('SP_CODEC') || chunk.includes('command -v base64')) {
        queueMicrotask(() => s.feed('SP_CODEC:base64\n$ '))
        return
      }
      if (chunk.includes('stty cols')) {
        queueMicrotask(() => s.feed('$ '))
        return
      }
      if (chunk.includes('SP_DRAIN_') || chunk.includes('SP_S_')) {
        const m = chunk.match(/SP_(?:DRAIN|S)_[A-Za-z0-9_]+/)?.[0]
        queueMicrotask(() => s.feed(`${m}\n$ `))
        return
      }
      if (chunk.includes('SP_UP')) {
        // produce output without the SP_UP:N marker the uploader requires
        queueMicrotask(() => s.feed('no marker in this output\n$ '))
      }
    }
    try {
      await expect(ft.upload(s, '/tmp/x', Buffer.from('hi'), { timeoutMs: 400 })).rejects.toMatchObject({
        message: 'Upload decoding timed out',
        statusCode: 504,
      })
    } finally {
      bus.off('session.data', onData)
    }
  })

  it('chunks large payloads across multiple writes (exercising the inter-chunk sleep) and succeeds', async () => {
    const { ft, stored } = makeFt()
    const s = makeSession('up-large-chunked')
    s.resize = () => {}
    const data = Buffer.alloc(20_000, 'a')
    // Drive via write scripting: wait is armed before the SP_UP write, so
    // scriptWaitForStable (which stamps text at wait-call time) would miss the
    // marker under history(since=startSeq). Feed through the write path instead.
    const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
      if (e.sessionId === s.id && e.direction === 'output') {
        stored.push({ seq: e.seq, plain: e.plain })
      }
    }
    bus.on('session.data', onData)
    const orig = s.write.bind(s)
    s.write = (chunk: string, opts?) => {
      orig(chunk, opts)
      if (chunk.includes('SP_CODEC') || chunk.includes('command -v base64')) {
        queueMicrotask(() => s.feed('SP_CODEC:base64\n$ '))
        return
      }
      if (chunk.includes('stty cols')) {
        queueMicrotask(() => s.feed('$ '))
        return
      }
      if (chunk.includes('SP_DRAIN_') || chunk.includes('SP_S_')) {
        const m = chunk.match(/SP_(?:DRAIN|S)_[A-Za-z0-9_]+/)?.[0]
        queueMicrotask(() => s.feed(`${m}\n$ `))
        return
      }
      if (chunk.includes('SP_UP')) {
        queueMicrotask(() => { s.feed(`SP_UP:${data.length}\n$ `); s.forceState('WAITING_INPUT') })
      }
    }
    try {
      const meta = await ft.upload(s, '/tmp/x', data, { timeoutMs: 10_000 })
      expect(meta.size).toBe(data.length)
      const printfWrites = s.writes.filter((w) => w.includes("printf '%s'"))
      expect(printfWrites.length).toBeGreaterThanOrEqual(3)
      // chunkSize is 32; keep every printf line under 80 for Bun ExpectPty
      expect(printfWrites.every((w) => w.length <= 80)).toBe(true)
    } finally {
      bus.off('session.data', onData)
    }
  })
})

describe('FileTransfer.basenameForDisposition', () => {
  it('falls back to "download" when the remote path has no basename', () => {
    const { ft } = makeFt()
    expect(ft.basenameForDisposition('/')).toBe('download')
  })
})
