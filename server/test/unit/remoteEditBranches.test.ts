import { describe, expect, it } from 'vitest'
import { RemoteEdit } from '../../src/core/RemoteEdit.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { extractEchoProofMarker } from '../helpers/echoProofMarker.js'
import { MockSession } from '../helpers/mockSession.js'

type Step = { timedOut?: boolean; text?: string }

function makeRe(): { re: RemoteEdit; stored: Array<{ seq: number; plain: string }> } {
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
  const re = new RemoteEdit(historySource, new SessionOpLock())
  return { re, stored }
}

function makeSession(id: string): MockSession {
  const s = new MockSession({ id})
  s.forceState('WAITING_INPUT')
  return s
}

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

/**
 * writeRemoteBase64File polls `historySource.history()` directly for its
 * echo-proof sync/drain/write markers instead of going through waitForStable,
 * so scriptWaitForStable's steps never see those writes. Answer them here.
 */
function scriptWriteMarkers(s: MockSession, stored: Array<{ seq: number; plain: string }>): void {
  const orig = s.write.bind(s)
  s.write = (chunk: string, opts?) => {
    orig(chunk, opts)
    if (chunk.includes("printf '\\n%s%s\\n'")) {
      const marker = extractEchoProofMarker(chunk)
      if (marker) stored.push({ seq: s.lastSeq, plain: `${marker}\n` })
    }
  }
}

describe('RemoteEdit.edit error branches', () => {
  it('reports a timeout when probing the remote edit engine never stabilizes', async () => {
    const { re, stored } = makeRe()
    const s = makeSession('re-probe-timeout')
    scriptWaitForStable(s, stored, [{ timedOut: true }])
    await expect(re.edit(s, '/tmp/x', [{ oldText: 'a', newText: 'b' }])).rejects.toMatchObject({
      message: 'Timed out probing remote edit engines',
      statusCode: 504,
    })
  })

  it('rejects when no supported edit engine is available remotely', async () => {
    const { re, stored } = makeRe()
    const s = makeSession('re-no-engine')
    scriptWaitForStable(s, stored, [{ text: 'SP_EDIT_ENGINE:none\n' }])
    await expect(re.edit(s, '/tmp/x', [{ oldText: 'a', newText: 'b' }])).rejects.toMatchObject({
      message: expect.stringContaining('No remote edit engine is available'),
      statusCode: 502,
    })
  })

  it('reports a timeout when probing the remote base64 decoder never stabilizes', async () => {
    const { re, stored } = makeRe()
    const s = makeSession('re-decoder-timeout')
    // Steps: probeEngine, widenPty (stty cols), stty -echo, probeDecoder (times out).
    scriptWaitForStable(s, stored, [{ text: 'SP_EDIT_ENGINE:python3\n' }, {}, {}, { timedOut: true }])
    await expect(re.edit(s, '/tmp/x', [{ oldText: 'a', newText: 'b' }])).rejects.toMatchObject({
      message: 'Timed out probing the remote decoder',
      statusCode: 504,
    })
  })

  it('succeeds via the python (not python3) engine using the openssl decoder', async () => {
    const { re, stored } = makeRe()
    const s = makeSession('re-python-openssl')
    scriptWriteMarkers(s, stored)
    // Steps: probeEngine, widenPty (stty cols), stty -echo, probeDecoder, run python.
    // writeRemoteBase64File (script + payload) polls history markers directly,
    // answered by scriptWriteMarkers instead of consuming a step here.
    scriptWaitForStable(s, stored, [
      { text: 'SP_EDIT_ENGINE:python\n' },
      {},
      {},
      { text: 'SP_DEC:openssl\n' },
      { text: 'SP_EDIT:ok:1\n' },
    ])
    const r = await re.edit(s, '/tmp/x', [{ oldText: 'a', newText: 'b' }])
    expect(r.engine).toBe('python')
    expect(r.replaced).toBe(1)
  })

  it('maps an error result with an empty error message to a default 502', async () => {
    const { re, stored } = makeRe()
    const s = makeSession('re-empty-err')
    scriptWriteMarkers(s, stored)
    scriptWaitForStable(s, stored, [
      { text: 'SP_EDIT_ENGINE:python3\n' },
      {},
      {},
      { text: 'SP_DEC:base64\n' },
      { text: 'SP_EDIT:err:\n' },
    ])
    await expect(re.edit(s, '/tmp/x', [{ oldText: 'a', newText: 'b' }])).rejects.toMatchObject({
      message: 'edit failed',
      statusCode: 502,
    })
  })

  it('rejects when the ok marker reports a non-numeric replaced count', async () => {
    const { re, stored } = makeRe()
    const s = makeSession('re-bad-count')
    scriptWriteMarkers(s, stored)
    scriptWaitForStable(s, stored, [
      { text: 'SP_EDIT_ENGINE:python3\n' },
      {},
      {},
      { text: 'SP_DEC:base64\n' },
      { text: 'SP_EDIT:ok:notanumber\n' },
    ])
    await expect(re.edit(s, '/tmp/x', [{ oldText: 'a', newText: 'b' }])).rejects.toMatchObject({
      message: 'Unable to parse the edit result',
      statusCode: 502,
    })
  })

  it('ignores a resize() failure while widening the PTY and still completes the edit', async () => {
    const { re, stored } = makeRe()
    const s = makeSession('re-resize-throws')
    s.resize = () => {
      throw new Error('resize not supported')
    }
    scriptWriteMarkers(s, stored)
    scriptWaitForStable(s, stored, [
      { text: 'SP_EDIT_ENGINE:python3\n' },
      {},
      {},
      { text: 'SP_DEC:base64\n' },
      { text: 'SP_EDIT:ok:1\n' },
    ])
    const r = await re.edit(s, '/tmp/x', [{ oldText: 'a', newText: 'b' }])
    expect(r.ok).toBe(true)
  })

  it('rejects when the session is not WAITING_INPUT (and not MANUAL either)', async () => {
    const { re } = makeRe()
    const s = makeSession('re-bad-state')
    s.forceState('CONNECTING')
    await expect(re.edit(s, '/tmp/x', [{ oldText: 'a', newText: 'b' }])).rejects.toMatchObject({
      message: expect.stringContaining('can be edited only while'),
      statusCode: 409,
    })
  })
})
