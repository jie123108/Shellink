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
  const s = new MockSession({ id: sessionId})
  s.forceState('WAITING_INPUT')
  s.resize = () => {}
  return { re, s, dispose: () => bus.off('session.data', onData) }
}

describe('RemoteEdit python path coverage', () => {
  it('runs python3 edit via waitForStable scripting', async () => {
    const { re, s, dispose } = makeRemoteEdit('re-py3')

    // Order of waitForStable calls in runPythonEdit:
    // 1 probeEngine, 2 stty -echo, 3 probeDecoder, 4 write script, 5 write payload, 6 run python
    const replies = [
      'SP_EDIT_ENGINE:python3\n$ ',
      '$ ',
      'SP_DEC:base64\n$ ',
      '$ ',
      '$ ',
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

    // Steps: 1 probeEngine, 2 stty -echo, 3 probeDecoder, 4 write script,
    // 5 write payload, 6 run python (times out), 7 cleanup stty echo.
    scriptWaitForStable(s, [
      { text: 'SP_EDIT_ENGINE:python3\n$ ' },
      { text: '$ ' },
      { text: 'SP_DEC:base64\n$ ' },
      { text: '$ ' },
      { text: '$ ' },
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

    // Steps: 1 probeEngine, 2 stty -echo, 3 probeDecoder,
    // 4 write script file (times out), 5 outer-catch cleanup.
    scriptWaitForStable(s, [
      { text: 'SP_EDIT_ENGINE:python3\n$ ' },
      { text: '$ ' },
      { text: 'SP_DEC:base64\n$ ' },
      { timeout: true },
      { text: '$ ' },
    ])

    try {
      await expect(re.edit(s, '/tmp/x.txt', [{ oldText: 'a', newText: 'b' }], 10_000)).rejects.toMatchObject({
        message: 'Timed out writing the remote temporary file',
      })
    } finally {
      dispose()
    }
  })
})
