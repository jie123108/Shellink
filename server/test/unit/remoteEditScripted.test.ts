import { describe, expect, it } from 'vitest'
import { bus } from '../../src/core/events.js'
import { RemoteEdit } from '../../src/core/RemoteEdit.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { MockSession } from '../helpers/mockSession.js'

describe('RemoteEdit scripted sed path', () => {
  it('edits via sed engine', async () => {
    const stored: Array<{ seq: number; plain: string }> = []
    const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
      if (e.sessionId === 're-sed' && e.direction === 'output') {
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
    const s = new MockSession({ id: 're-sed' })
    s.forceState('WAITING_INPUT')
    s.resize = () => {}

    const origWrite = s.write.bind(s)
    s.write = (data: string, opts?) => {
      origWrite(data, opts)
      queueMicrotask(() => {
        if (data.includes('SP_EDIT_ENGINE')) {
          s.feed('SP_EDIT_ENGINE:sed\n$ ')
        } else if (data.includes('SP_EDIT:') || data.includes('sed ') || data.includes('grep -F')) {
          s.feed('SP_EDIT:ok:1\n$ ')
        } else {
          s.feed('$ ')
        }
      })
    }

    try {
      const result = await re.edit(s, '/tmp/x.txt', [{ oldText: 'old', newText: 'new' }], 5_000)
      expect(result.ok).toBe(true)
      expect(result.engine).toBe('sed')
      expect(result.replaced).toBe(1)
    } finally {
      bus.off('session.data', onData)
    }
  })
})
