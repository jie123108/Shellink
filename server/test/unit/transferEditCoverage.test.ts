import { describe, expect, it } from 'vitest'
import { bus } from '../../src/core/events.js'
import { FileTransfer } from '../../src/core/FileTransfer.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { MockSession } from '../helpers/mockSession.js'

function historyFor(sessionId: string) {
  const stored: Array<{ seq: number; plain: string }> = []
  const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
    if (e.sessionId === sessionId && e.direction === 'output') {
      stored.push({ seq: e.seq, plain: e.plain })
    }
  }
  bus.on('session.data', onData)
  return {
    onData,
    source: {
      history(_id: string, since = 0) {
        const parts = stored.filter((c) => c.seq > since)
        return {
          cursor: parts.length ? parts[parts.length - 1]!.seq : since,
          text: parts.map((c) => c.plain).join(''),
        }
      },
    },
  }
}

describe('FileTransfer openssl codec', () => {
  it('downloads via openssl codec', async () => {
    const { onData, source } = historyFor('ft-ssl')
    const ft = new FileTransfer(source, new SessionOpLock())
    const s = new MockSession({ id: 'ft-ssl' })
    s.forceState('WAITING_INPUT')
    const payload = Buffer.from('xy').toString('base64')
    const orig = s.write.bind(s)
    s.write = (data: string, opts?) => {
      orig(data, opts)
      queueMicrotask(() => {
        if (data.includes('SP_CODEC')) s.feed('SP_CODEC:openssl\n$ ')
        else if (data.includes('SP_STAT')) s.feed('SP_STAT:ok:2\n$ ')
        else if (data.includes('printf') || data.includes('SPB_')) {
          const bm = /'(SPB_[a-f0-9]+)'/.exec(data)
          const em = /'(SPE_[a-f0-9]+)'/.exec(data)
          s.feed(`${bm?.[1]}\n${payload}\n${em?.[1]}\n$ `)
        } else s.feed('$ ')
      })
    }
    try {
      const r = await ft.download(s, '/tmp/o.txt', 5_000)
      expect(r.codec).toBe('openssl')
      expect(r.data.toString()).toBe('xy')
    } finally {
      bus.off('session.data', onData)
    }
  })

  it('downloads via xxd codec', async () => {
    const { onData, source } = historyFor('ft-xxd')
    const ft = new FileTransfer(source, new SessionOpLock())
    const s = new MockSession({ id: 'ft-xxd' })
    s.forceState('WAITING_INPUT')
    const hex = Buffer.from('zz').toString('hex')
    const orig = s.write.bind(s)
    s.write = (data: string, opts?) => {
      orig(data, opts)
      queueMicrotask(() => {
        if (data.includes('SP_CODEC')) s.feed('SP_CODEC:xxd\n$ ')
        else if (data.includes('SP_STAT')) s.feed('SP_STAT:ok:2\n$ ')
        else if (data.includes('printf') || data.includes('SPB_')) {
          const bm = /'(SPB_[a-f0-9]+)'/.exec(data)
          const em = /'(SPE_[a-f0-9]+)'/.exec(data)
          s.feed(`${bm?.[1]}\n${hex}\n${em?.[1]}\n$ `)
        } else s.feed('$ ')
      })
    }
    try {
      const r = await ft.download(s, '/tmp/x.txt', 5_000)
      expect(r.codec).toBe('xxd')
      expect(r.data.toString()).toBe('zz')
    } finally {
      bus.off('session.data', onData)
    }
  })

  it('downloads via python3 codec', async () => {
    const { onData, source } = historyFor('ft-py')
    const ft = new FileTransfer(source, new SessionOpLock())
    const s = new MockSession({ id: 'ft-py' })
    s.forceState('WAITING_INPUT')
    const payload = Buffer.from('pq').toString('base64')
    const orig = s.write.bind(s)
    s.write = (data: string, opts?) => {
      orig(data, opts)
      queueMicrotask(() => {
        if (data.includes('SP_CODEC')) s.feed('SP_CODEC:python3\n$ ')
        else if (data.includes('SP_STAT')) s.feed('SP_STAT:ok:2\n$ ')
        else if (data.includes('printf') || data.includes('SPB_')) {
          const bm = /'(SPB_[a-f0-9]+)'/.exec(data)
          const em = /'(SPE_[a-f0-9]+)'/.exec(data)
          s.feed(`${bm?.[1]}\n${payload}\n${em?.[1]}\n$ `)
        } else s.feed('$ ')
      })
    }
    try {
      const r = await ft.download(s, '/tmp/p.txt', 5_000)
      expect(r.codec).toBe('python3')
      expect(r.data.toString()).toBe('pq')
    } finally {
      bus.off('session.data', onData)
    }
  })
})
