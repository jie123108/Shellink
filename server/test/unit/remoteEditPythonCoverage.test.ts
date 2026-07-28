import { describe, expect, it } from 'vitest'
import { bus } from '../../src/core/events.js'
import { RemoteEdit } from '../../src/core/RemoteEdit.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { MockSession } from '../helpers/mockSession.js'

type Step = { timeout: true } | { text: string }

function scriptWaitForStable(s: MockSession, steps: Step[]): void {
  let i = 0
  const orig = s.waitForStable.bind(s)
  s.waitForStable = async (timeoutMs: number) => {
    const step = steps[i++] ?? { text: '$ ' }
    if ('timeout' in step) return { state: s.state, timedOut: true }
    queueMicrotask(() => s.feed(step.text))
    return orig(timeoutMs)
  }
}

/** Feed SP_DRAIN / SP_S_ / SP_WROTE markers that writeRemoteBase64File polls from history. */
function scriptWriteMarkers(s: MockSession, opts: { hangWrite?: boolean } = {}): void {
  const orig = s.write.bind(s)
  s.write = (chunk: string, writeOpts?) => {
    orig(chunk, writeOpts)
    if (opts.hangWrite) {
      if (chunk.includes('SP_DRAIN_') || chunk.includes('SP_S_') || chunk.includes('SP_WROTE_')) {
        return
      }
    }
    if (chunk.includes('SP_DRAIN_') || chunk.includes('SP_S_')) {
      const m = chunk.match(/SP_(?:DRAIN|S)_[A-Za-z0-9_]+/)?.[0]
      if (m) {
        queueMicrotask(() => {
          s.feed(`${m}\n$ `)
          s.forceState('WAITING_INPUT')
        })
      }
      return
    }
    if (chunk.includes('SP_WROTE_')) {
      const m = chunk.match(/SP_WROTE_[a-f0-9]+/)?.[0]
      if (m) {
        queueMicrotask(() => {
          s.feed(`${m}\n$ `)
          s.forceState('WAITING_INPUT')
        })
      }
    }
  }
}

function makeRemoteEdit(sessionId: string): { re: RemoteEdit; s: MockSession; dispose: () => void } {
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
  const re = new RemoteEdit(historySource, new SessionOpLock())
  const s = new MockSession({ id: sessionId })
  s.forceState('WAITING_INPUT')
  s.resize = () => {}
  return { re, s, dispose: () => bus.off('session.data', onData) }
}

describe('RemoteEdit python path coverage', () => {
  it('runs python3 edit via waitForStable scripting', async () => {
    const { re, s, dispose } = makeRemoteEdit('re-py3')
    scriptWriteMarkers(s)

    // Order of waitForStable calls in runPythonEdit:
    // 1 probeEngine, 2 widenPty stty, 3 stty -echo, 4 probeDecoder, 5 run python
    // (write script/payload now poll history markers, not waitForStable)
    const replies = [
      'SP_EDIT_ENGINE:python3\n$ ',
      '$ ',
      '$ ',
      'SP_DEC:base64\n$ ',
      'SP_EDIT:ok:1\n$ ',
    ]
    let step = 0
    const origWait = s.waitForStable.bind(s)
    s.waitForStable = async (timeoutMs: number) => {
      const text = replies[step++] ?? '$ '
      queueMicrotask(() => s.feed(text))
      return origWait(timeoutMs)
    }

    try {
      const r = await re.edit(s, '/tmp/x.txt', [{ oldText: 'a', newText: 'b' }], 10_000)
      expect(r.ok).toBe(true)
      expect(r.engine).toBe('python3')
      expect(r.replaced).toBe(1)
    } finally {
      dispose()
    }
  })

  it('reports a timeout when the python edit command itself never stabilizes', async () => {
    const { re, s, dispose } = makeRemoteEdit('re-py-timeout')
    scriptWriteMarkers(s)

    // Steps: 1 probeEngine, 2 widenPty, 3 stty -echo, 4 probeDecoder,
    // 5 run python (times out), 6 cleanup stty echo.
    scriptWaitForStable(s, [
      { text: 'SP_EDIT_ENGINE:python3\n$ ' },
      { text: '$ ' },
      { text: '$ ' },
      { text: 'SP_DEC:base64\n$ ' },
      { timeout: true },
      { text: '$ ' },
    ])

    try {
      await expect(re.edit(s, '/tmp/x.txt', [{ oldText: 'a', newText: 'b' }], 10_000)).rejects.toMatchObject({
        message: 'Remote edit timed out',
      })
    } finally {
      dispose()
    }
  })

  it('reports a timeout when writing the remote temp file never stabilizes', async () => {
    const { re, s, dispose } = makeRemoteEdit('re-py-writetimeout')
    scriptWriteMarkers(s, { hangWrite: true })

    // Steps: 1 probeEngine, 2 widenPty, 3 stty -echo, 4 probeDecoder,
    // then write script file polls markers and times out; outer-catch cleanup.
    scriptWaitForStable(s, [
      { text: 'SP_EDIT_ENGINE:python3\n$ ' },
      { text: '$ ' },
      { text: '$ ' },
      { text: 'SP_DEC:base64\n$ ' },
      { text: '$ ' },
    ])

    try {
      await expect(re.edit(s, '/tmp/x.txt', [{ oldText: 'a', newText: 'b' }], 400)).rejects.toMatchObject({
        message: 'Timed out writing the remote temporary file',
      })
    } finally {
      dispose()
    }
  })
})
