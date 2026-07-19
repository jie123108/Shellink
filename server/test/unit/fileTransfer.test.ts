import { describe, expect, it } from 'vitest'
import {
  extractMarkedPayload,
  lastLineMarker,
  shellQuote,
  validateRemotePath,
  FileTransfer,
} from '../../src/core/FileTransfer.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { TransferError } from '../../src/core/TransferError.js'
import { bus } from '../../src/core/events.js'
import { MockSession } from '../helpers/mockSession.js'
import { sleep } from '../helpers/wait.js'

describe('FileTransfer helpers', () => {
  it('shellQuote escapes single quotes', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`)
  })

  it('validateRemotePath', () => {
    expect(validateRemotePath(' /tmp/x ')).toBe('/tmp/x')
    expect(() => validateRemotePath('')).toThrow(TransferError)
    expect(() => validateRemotePath('a\0b')).toThrow(TransferError)
    expect(() => validateRemotePath('x'.repeat(5000))).toThrow(TransferError)
  })

  it('extractMarkedPayload', () => {
    const out = 'echo\nSPB_1\nYWJj\nSPE_1\n$ '
    expect(extractMarkedPayload(out, 'SPB_1', 'SPE_1')).toBe('YWJj')
    expect(() => extractMarkedPayload('nope', 'SPB_1', 'SPE_1')).toThrow(TransferError)
    const dual = 'SPB_1\nZmFrZQ==\nSPE_1\nSPB_1\ncmVhbA==\nSPE_1\n$ '
    expect(extractMarkedPayload(dual, 'SPB_1', 'SPE_1')).toBe('cmVhbA==')
  })

  it('lastLineMarker prefers last line match over echo', () => {
    const out = 'echo SP_STAT:unreadable\nSP_STAT:ok:12\n'
    const m = lastLineMarker(out, /SP_STAT:(missing|unreadable|ok:(\d+))/)
    expect(m?.[1]).toBe('ok:12')
    expect(m?.[2]).toBe('12')
  })
})

describe('FileTransfer download/upload with scripted session', () => {
  it('rejects MANUAL and non-WAITING_INPUT', async () => {
    const ft = new FileTransfer({ history: () => ({ cursor: 0, text: '' }) }, new SessionOpLock())
    const s = new MockSession({ id: 'ft1' })
    s.setMode('MANUAL')
    s.forceState('WAITING_INPUT')
    await expect(ft.download(s, '/tmp/x')).rejects.toMatchObject({ statusCode: 409 })

    const s2 = new MockSession({ id: 'ft2' })
    s2.forceState('IDLE')
    await expect(ft.download(s2, '/tmp/x')).rejects.toMatchObject({ statusCode: 409 })
  })

  it('downloads via scripted codec probe and markers', async () => {
    const stored: Array<{ seq: number; plain: string }> = []
    const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
      if (e.sessionId === 'ft3' && e.direction === 'output') {
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
    const s = new MockSession({ id: 'ft3' })
    s.forceState('WAITING_INPUT')

    const origWrite = s.write.bind(s)
    s.write = (data: string, opts?) => {
      origWrite(data, opts)
      const cmd = data
      void (async () => {
        await sleep(30)
        if (cmd.includes('SP_CODEC')) {
          s.feed('SP_CODEC:base64\n$ ')
        } else if (cmd.includes('SP_STAT')) {
          s.feed('SP_STAT:ok:3\n$ ')
        } else if (cmd.includes('printf') || cmd.includes('SPB_')) {
          const bm = /'(SPB_[a-f0-9]+)'/.exec(cmd)
          const em = /'(SPE_[a-f0-9]+)'/.exec(cmd)
          const begin = bm?.[1] ?? 'SPB_x'
          const end = em?.[1] ?? 'SPE_x'
          const payload = Buffer.from('abc').toString('base64')
          s.feed(`${begin}\n${payload}\n${end}\n$ `)
        } else {
          s.feed('$ ')
        }
      })()
    }

    try {
      const result = await ft.download(s, '/tmp/hello.txt', 5_000)
      expect(result.data.toString()).toBe('abc')
      expect(result.size).toBe(3)
      expect(result.codec).toBe('base64')
    } finally {
      bus.off('session.data', onData)
    }
  })

  it('basenameForDisposition sanitizes', () => {
    const ft = new FileTransfer({ history: () => ({ cursor: 0, text: '' }) }, new SessionOpLock())
    expect(ft.basenameForDisposition('/a/b/c.txt')).toBe('c.txt')
    expect(ft.basenameForDisposition('/a/"x\ny"')).toBe('_x_y_')
  })
})
