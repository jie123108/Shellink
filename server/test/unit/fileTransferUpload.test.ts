import { describe, expect, it } from 'vitest'
import { bus } from '../../src/core/events.js'
import { FileTransfer } from '../../src/core/FileTransfer.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { MockSession } from '../helpers/mockSession.js'

describe('FileTransfer upload scripted', () => {
  it.each(['base64', 'openssl', 'python3', 'xxd'] as const)(
    'uploads via %s codec',
    async (codecName) => {
      const sessionId = `up-${codecName}`
      const stored: Array<{ seq: number; plain: string }> = []
      const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
        if (e.sessionId === sessionId && e.direction === 'output') {
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
      const s = new MockSession({ id: sessionId })
      s.forceState('WAITING_INPUT')
      s.resize = () => {}

      const data = Buffer.from('hi')
      const origWrite = s.write.bind(s)
      s.write = (chunk: string, opts?) => {
        origWrite(chunk, opts)
        if (chunk.includes('SP_CODEC') || chunk.includes('command -v base64')) {
          queueMicrotask(() => s.feed(`SP_CODEC:${codecName}\n$ `))
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
        const meta = await ft.upload(s, '/tmp/u.txt', data, { timeoutMs: 5_000 })
        expect(meta.size).toBe(2)
        expect(meta.codec).toBe(codecName)
      } finally {
        bus.off('session.data', onData)
      }
    },
  )
})
