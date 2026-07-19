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
      const s = new MockSession({ id: sessionId})
      s.forceState('WAITING_INPUT')

      const data = Buffer.from('hi')
      // Drive the exchange purely by write() call order so codec-specific
      // command text (base64/openssl/python3/xxd) never needs to be matched.
      type Phase = 'probe' | 'stty' | 'decode' | 'chunk' | 'eof' | 'verify' | 'done'
      let phase: Phase = 'probe'
      const respond = (text: string) => {
        queueMicrotask(() => s.feed(text))
      }

      const origWrite = s.write.bind(s)
      s.write = (chunk: string, opts?) => {
        origWrite(chunk, opts)
        switch (phase) {
          case 'probe':
            phase = 'stty'
            respond(`SP_CODEC:${codecName}\n$ `)
            return
          case 'stty':
            phase = 'decode'
            respond('$ ')
            return
          case 'decode':
            phase = 'chunk'
            return
          case 'chunk':
            phase = 'eof'
            return
          case 'eof':
            phase = 'verify'
            respond('$ ')
            return
          case 'verify':
            phase = 'done'
            respond(`SP_UP:${data.length}\n$ `)
            return
          case 'done':
            return
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
