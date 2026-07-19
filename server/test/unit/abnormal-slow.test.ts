import { describe, expect, it } from 'vitest'
import { bus } from '../../src/core/events.js'
import { extractMarkedPayload, FileTransfer } from '../../src/core/FileTransfer.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { TransferError } from '../../src/core/TransferError.js'
import { MockSession } from '../helpers/mockSession.js'
import { sleep } from '../helpers/wait.js'

function track(sessionId: string) {
  const stored: Array<{ seq: number; plain: string }> = []
  const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
    if (e.sessionId === sessionId && e.direction === 'output') {
      stored.push({ seq: e.seq, plain: e.plain })
    }
  }
  bus.on('session.data', onData)
  return {
    historySource: {
      history(_id: string, since = 0) {
        const parts = stored.filter((c) => c.seq > since)
        return {
          cursor: parts.length ? parts[parts.length - 1]!.seq : since,
          text: parts.map((c) => c.plain).join(''),
        }
      },
    },
    stop: () => bus.off('session.data', onData),
  }
}

describe('abnormal slow / partial PTY', () => {
  it('extractMarkedPayload prefers last complete frame', () => {
    const fake = 'SPB_tok\nZmFrZQ==\nSPE_tok\n'
    const real = 'SPB_tok\ncmVhbA==\nSPE_tok\n'
    expect(extractMarkedPayload(fake + real, 'SPB_tok', 'SPE_tok')).toBe('cmVhbA==')
  })

  it('slow chunked download completes within timeout', async () => {
    const { historySource, stop } = track('slow-dl')
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: 'slow-dl' })
    s.forceState('WAITING_INPUT')
    const payload = Buffer.from('hello-slow').toString('base64')

    const orig = s.write.bind(s)
    s.write = (data: string, opts?) => {
      orig(data, opts)
      void (async () => {
        if (data.includes('SP_CODEC')) {
          s.feed('SP_CODEC:base64\n$ ')
          return
        }
        if (data.includes('SP_STAT')) {
          s.feed(`SP_STAT:ok:${Buffer.from('hello-slow').length}\n$ `)
          return
        }
        if (data.includes('SPB_') || data.includes('base64')) {
          const begin = data.match(/SPB_[a-f0-9]+/)?.[0] ?? 'SPB_x'
          const end = data.match(/SPE_[a-f0-9]+/)?.[0] ?? 'SPE_x'
          // slow partial output
          s.feed(`${begin}\n`)
          for (const ch of payload) {
            await sleep(20)
            s.feed(ch)
          }
          await sleep(20)
          s.feed(`\n${end}\n$ `)
          return
        }
        s.feed('$ ')
      })()
    }

    try {
      const r = await ft.download(s, '/tmp/slow.txt', 10_000)
      expect(r.data.toString()).toBe('hello-slow')
    } finally {
      stop()
    }
  }, 20_000)

  it('slow download times out cleanly', async () => {
    const { historySource, stop } = track('slow-to')
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: 'slow-to' })
    s.forceState('WAITING_INPUT')

    const orig = s.write.bind(s)
    s.write = (data: string, opts?) => {
      orig(data, opts)
      queueMicrotask(() => {
        if (data.includes('SP_CODEC')) {
          s.feed('SP_CODEC:base64\n$ ')
          return
        }
        if (data.includes('SP_STAT')) {
          s.feed('SP_STAT:ok:100\n$ ')
          return
        }
        if (data.includes('SPB_') || data.includes('base64')) {
          // never finish — hang in OUTPUTTING
          return
        }
        s.feed('$ ')
      })
    }

    try {
      await expect(ft.download(s, '/tmp/x', 400)).rejects.toMatchObject({ statusCode: 504 })
    } finally {
      stop()
    }
  })

  it('upload decode timeout then retry succeeds', async () => {
    const { historySource, stop } = track('up-recover')
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: 'up-recover' })
    s.forceState('WAITING_INPUT')
    const data = Buffer.from('hi')

    let hang = true
    const orig = s.write.bind(s)
    const installHandler = () => {
      s.write = (chunk: string, opts?) => {
        orig(chunk, opts)
        queueMicrotask(() => {
          if (chunk.includes('SP_CODEC')) {
            s.feed('SP_CODEC:base64\n$ ')
            return
          }
          if (chunk.includes('stty -echo')) {
            s.feed('$ ')
            return
          }
          if (chunk.includes('base64 -d') || chunk.includes('openssl base64')) {
            if (hang) return
            return
          }
          if (chunk.includes('SPEOF_')) {
            if (hang) return
            s.feed('$ ')
            return
          }
          if (chunk.includes('rm -f') && chunk.includes('.shellink-xfer')) {
            s.forceState('WAITING_INPUT')
            s.feed('$ ')
            return
          }
          if (chunk.includes('mv -f') || chunk.includes('wc -c') || chunk.includes('SP_UP')) {
            s.feed(`SP_UP:${data.length}\n$ `)
            return
          }
          if (chunk.includes('stty echo')) {
            s.feed('$ ')
          }
        })
      }
    }
    installHandler()

    try {
      await expect(ft.upload(s, '/tmp/r.txt', data, { timeoutMs: 400 })).rejects.toMatchObject({
        statusCode: 504,
      })
      hang = false
      s.forceState('WAITING_INPUT')
      // mirror successful upload script from fileTransferUpload.test.ts
      let phase: 'probe' | 'stty' | 'decode' | 'payload' | 'verify' = 'probe'
      s.write = (chunk: string, opts?) => {
        orig(chunk, opts)
        queueMicrotask(() => {
          if (chunk.includes('SP_CODEC')) {
            phase = 'stty'
            s.feed('SP_CODEC:base64\n$ ')
            return
          }
          if (chunk.includes('stty -echo')) {
            phase = 'decode'
            s.feed('$ ')
            return
          }
          if (chunk.includes('base64 -d') || chunk.includes('openssl base64')) {
            phase = 'payload'
            return
          }
          if (chunk.includes('SPEOF_') || (phase === 'payload' && chunk.startsWith('\n'))) {
            phase = 'verify'
            s.feed('$ ')
            return
          }
          if (chunk.includes('mv -f') || chunk.includes('wc -c') || chunk.includes('SP_UP')) {
            s.feed(`SP_UP:${data.length}\n$ `)
            return
          }
          if (chunk.includes('stty echo')) s.feed('$ ')
        })
      }
      const meta = await ft.upload(s, '/tmp/r.txt', data, { timeoutMs: 5_000 })
      expect(meta.size).toBe(2)
    } finally {
      stop()
    }
  }, 30_000)

  it('single waitForStable waiter resolves once', async () => {
    const s = new MockSession({ id: 'ws1' })
    s.forceState('OUTPUTTING')
    const p = s.waitForStable(5_000)
    s.feed('$ ')
    await sleep(250)
    const r = await p
    expect(r.timedOut).toBe(false)
    expect(r.state).toBe('WAITING_INPUT')
  })
})
