import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { bus } from '../../src/core/events.js'
import { RemoteEdit, type TextEdit } from '../../src/core/RemoteEdit.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { sessionManager } from '../../src/core/SessionManager.js'
import { resolveSshPrivateKey } from '../../src/core/sshIdentity.js'
import { TransferError } from '../../src/core/TransferError.js'
import { MockSession } from '../helpers/mockSession.js'

function trackOutput(sessionId: string) {
  const stored: Array<{ seq: number; plain: string }> = []
  const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
    if (e.sessionId === sessionId && e.direction === 'output') stored.push({ seq: e.seq, plain: e.plain })
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

describe('sshIdentity fallback with no matches', () => {
  it('returns undefined when ssh -G is unavailable and no default keys exist', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-fakehome-'))
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome)
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      const result = resolveSshPrivateKey({ host: 'example.com', username: 'u' })
      expect(result).toBeUndefined()
    } finally {
      homedirSpy.mockRestore()
      process.env.PATH = originalPath
      fs.rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})

describe('SessionManager.writeInput allows IDLE state', () => {
  it('accepts input while the session is IDLE with no active lock', () => {
    const s = new MockSession({ id: 'sm-idle' })
    s.forceState('IDLE')
    expect(() => sessionManager.writeInput(s, 'hello')).not.toThrow()
    expect(s.writes.some((w) => w.includes('hello'))).toBe(true)
  })
})

describe('RemoteEdit catch cleanup and defensive branches', () => {
  it('cleans up remote temp files and rethrows when the python edit reports an error', async () => {
    const { historySource, stop } = trackOutput('re-py-cleanup')
    const re = new RemoteEdit(historySource, new SessionOpLock())
    const s = new MockSession({ id: 're-py-cleanup' })
    s.forceState('WAITING_INPUT')
    s.resize = () => {}

    const replies = [
      'SP_EDIT_ENGINE:python3\n$ ', // probeEngine
      '$ ', // stty -echo
      'SP_DEC:base64\n$ ', // probeDecoder
      '$ ', // write script
      '$ ', // write payload
      'SP_EDIT:err:not_found:Could not find the exact text\n$ ', // run python (errors)
      '$ ', // cleanup rm -f
    ]
    let step = 0
    const origWait = s.waitForStable.bind(s)
    s.waitForStable = async (timeoutMs: number) => {
      const text = replies[step++] ?? '$ '
      queueMicrotask(() => s.feed(text))
      return origWait(timeoutMs)
    }

    try {
      await expect(
        re.edit(s, '/tmp/x.txt', [{ oldText: 'a', newText: 'b' }], 10_000),
      ).rejects.toMatchObject({ statusCode: 400 })
    } finally {
      stop()
    }
  })

  it('covers the defensive empty-oldText guard in runSedEdit when called directly', async () => {
    const historySource = { history: () => ({ cursor: 0, text: '' }) }
    const re = new RemoteEdit(historySource, new SessionOpLock())
    const s = new MockSession({ id: 're-sed-empty' })
    s.forceState('WAITING_INPUT')

    const direct = re as unknown as {
      runSedEdit: (
        session: MockSession,
        remotePath: string,
        edits: TextEdit[],
        timeoutMs: number,
        startAt: number,
      ) => Promise<unknown>
    }
    await expect(
      direct.runSedEdit(s, '/tmp/x', [{ oldText: '', newText: 'y' }], 5_000, Date.now()),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('SessionOpLock', () => {
  it('rejects a second lock while one is held, and clears explicitly', async () => {
    const lock = new SessionOpLock()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const held = lock.withLock('op1', async () => {
      await gate
    })
    expect(lock.isLocked('op1')).toBe(true)
    await expect(lock.withLock('op1', async () => {})).rejects.toBeInstanceOf(TransferError)
    release()
    await held
    lock.clear('op1')
    expect(lock.isLocked('op1')).toBe(false)
  })
})
