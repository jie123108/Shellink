import { describe, expect, it } from 'vitest'
import { sessionManager } from '../../src/core/SessionManager.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { TransferError } from '../../src/core/TransferError.js'
import { MockSession } from '../helpers/mockSession.js'

describe('SessionManager.writeInput gates', () => {
  it('rejects MANUAL and DISCONNECTED; allows CONNECTING', () => {
    const s = new MockSession({ id: 'wi1' })
    s.setMode('MANUAL')
    s.forceState('WAITING_INPUT')
    expect(() => sessionManager.writeInput(s, 'x')).toThrow(TransferError)

    s.setMode('AUTO')
    s.forceState('DISCONNECTED')
    expect(() => sessionManager.writeInput(s, 'x')).toThrow(TransferError)

    const c = new MockSession({ id: 'wi2' })
    // stay CONNECTING (default before completeLogin)
    sessionManager.writeInput(c, 'otp')
    expect(c.writes.some((w) => w.includes('otp'))).toBe(true)
  })

  it('transfer lock blocks normal input but allows Ctrl+C', async () => {
    const s = new MockSession({ id: 'wi3' })
    s.forceState('WAITING_INPUT')
    const lock = (sessionManager as unknown as { opLock: SessionOpLock }).opLock
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const held = lock.withLock('wi3', async () => {
      await gate
    }, 'busy', 'transfer')
    expect(() => sessionManager.writeInput(s, 'nope')).toThrow(TransferError)
    sessionManager.writeInput(s, '\u0003', false)
    expect(s.writes.some((w) => w.includes('\u0003'))).toBe(true)
    release()
    await held
  })

  it('acceptIdle false keeps waiting through IDLE', async () => {
    const s = new MockSession({ id: 'wi4' })
    s.forceState('OUTPUTTING')
    const p = s.waitForStable(800, { acceptIdle: false })
    s.feed('partial\n') // silence → IDLE
    await new Promise((r) => setTimeout(r, 250))
    // still pending — resolve via prompt
    s.feed('$ ')
    await new Promise((r) => setTimeout(r, 250))
    const r = await p
    expect(r.timedOut).toBe(false)
    expect(r.state).toBe('WAITING_INPUT')
  })
})
