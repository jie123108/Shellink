import { describe, expect, it } from 'vitest'
import { bus } from '../../src/core/events.js'
import { MockSession } from '../helpers/mockSession.js'
import { sleep } from '../helpers/wait.js'

describe('BaseSession state machine', () => {
  it('first prompt completes login -> WAITING_INPUT', async () => {
    const s = new MockSession({ id: 's5' })
    s.feed('welcome\n$ ')
    await sleep(250)
    expect(s.state).toBe('WAITING_INPUT')
  })

  it('after login, silence without prompt -> IDLE', async () => {
    const s = new MockSession({ id: 's6' })
    s.completeLoginPublic()
    s.feed('running...\nno prompt yet')
    await sleep(250)
    expect(s.state).toBe('IDLE')
  })

  it('waitForStable resolves on WAITING_INPUT', async () => {
    const s = new MockSession({ id: 's7' })
    const p = s.waitForStable(5_000)
    s.completeLoginPublic()
    s.feed('$ ')
    await sleep(250)
    const r = await p
    expect(r.timedOut).toBe(false)
    expect(r.state).toBe('WAITING_INPUT')
  })

  it('waitForStable times out', async () => {
    const s = new MockSession({ id: 's8' })
    const r = await s.waitForStable(50)
    expect(r.timedOut).toBe(true)
  })

  it('setMode emits once', () => {
    const modes: string[] = []
    const onMode = (e: { mode: string }) => modes.push(e.mode)
    bus.on('session.mode', onMode)
    try {
      const s = new MockSession({ id: 's9' })
      s.setMode('MANUAL')
      s.setMode('MANUAL')
      expect(modes).toEqual(['MANUAL'])
    } finally {
      bus.off('session.mode', onMode)
    }
  })

  it('close emits DISCONNECTED', () => {
    const s = new MockSession({ id: 's11' })
    s.close('bye')
    expect(s.state).toBe('DISCONNECTED')
  })
})
