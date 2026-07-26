import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionManager } from '../../src/core/SessionManager.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { TransferError } from '../../src/core/TransferError.js'
import { MockSession } from '../helpers/mockSession.js'

type Internal = {
  sessions: Map<string, MockSession>
  opLock: SessionOpLock
}

function internals(): Internal {
  return sessionManager as unknown as Internal
}

afterEach(() => {
  const { sessions, opLock } = internals()
  for (const [id, s] of sessions) {
    try { s.close('test cleanup') } catch { /* ignore */ }
    sessions.delete(id)
    opLock.clear(id)
    sessionManager.jobs.clearSession(id)
  }
})

describe('SessionManager job edge paths', () => {
  it('execCancel is a no-op for an already terminal job', async () => {
    const s = new MockSession({ id: 'job-cancel-term' })
    s.forceState('WAITING_INPUT')
    internals().sessions.set(s.id, s)
    const started = sessionManager.execStart(s, 'echo x', 2000)
    // Force terminal without waiting for PTY
    sessionManager.jobs.settle(started.jobId, 'DONE', { state: 'WAITING_INPUT' })
    const canceled = await sessionManager.execCancel(started.jobId)
    expect(canceled.status).toBe('DONE')
  })

  it('downloadStart settles FAILED when the remote file is missing', async () => {
    const s = new MockSession({ id: 'job-dl-fail' })
    s.forceState('WAITING_INPUT')
    internals().sessions.set(s.id, s)
    // Scripted session has no codec/file; download will throw.
    const job = sessionManager.downloadStart(s, '/tmp/does-not-exist-shellink', '/tmp/shellink-out-unused', 2000)
    const settled = await sessionManager.jobs.waitUntilTerminal(job.id, 5000)
    expect(settled?.status).toBe('FAILED')
    expect(settled?.error).toBeTruthy()
  })

  it('uploadStart settles FAILED when MANUAL blocks transfer', async () => {
    const s = new MockSession({ id: 'job-up-fail' })
    s.forceState('WAITING_INPUT')
    s.setMode('MANUAL')
    internals().sessions.set(s.id, s)
    const job = sessionManager.uploadStart(s, '/tmp/x', Buffer.from('hi'))
    const settled = await sessionManager.jobs.waitUntilTerminal(job.id, 3000)
    expect(settled?.status).toBe('FAILED')
    expect(settled?.error).toMatch(/MANUAL/)
  })

  it('editStart settles DONE when RemoteEdit succeeds', async () => {
    const s = new MockSession({ id: 'job-edit-ok' })
    s.forceState('WAITING_INPUT')
    internals().sessions.set(s.id, s)

    const editSpy = vi.spyOn(sessionManager.remoteEdit, 'edit').mockResolvedValue({
      ok: true,
      path: '/tmp/e.txt',
      replaced: 1,
      engine: 'python3',
      durationMs: 1,
    })
    try {
      const job = sessionManager.editStart(s, '/tmp/e.txt', [{ oldText: 'a', newText: 'b' }], 3000)
      const settled = await sessionManager.jobs.waitUntilTerminal(job.id, 3000)
      expect(settled?.status).toBe('DONE')
      expect(settled?.result).toMatchObject({ replaced: 1 })
    } finally {
      editSpy.mockRestore()
    }
  })

  it('sync exec rethrows when waitUntilNotRunning returns FAILED', async () => {
    const s = new MockSession({ id: 'job-fail-rethrow' })
    s.forceState('WAITING_INPUT')
    internals().sessions.set(s.id, s)

    const spy = vi.spyOn(sessionManager.jobs, 'waitUntilNotRunning').mockImplementation(async (jobId) => {
      const cur = sessionManager.jobs.get(jobId)
      return cur
        ? { ...cur, status: 'FAILED', error: 'busy job conflict' }
        : undefined
    })
    try {
      await expect(sessionManager.exec(s, 'echo no', 1000)).rejects.toMatchObject({
        statusCode: 409,
        message: 'busy job conflict',
      })
    } finally {
      spy.mockRestore()
      // Cancel any background runner left over from startExecJob
      const active = sessionManager.jobs.activeForSession(s.id)
      if (active) await sessionManager.execCancel(active.id).catch(() => {})
      internals().opLock.clear(s.id)
    }
  })

  it('runExecJob settles DISCONNECTED when session.isClosed() inside the lock', async () => {
    const s = new MockSession({ id: 'job-isclosed' })
    s.forceState('WAITING_INPUT')
    internals().sessions.set(s.id, s)
    const closedSpy = vi.spyOn(s, 'isClosed').mockReturnValue(true)
    try {
      const started = sessionManager.execStart(s, 'echo x', 2000)
      const settled = await sessionManager.jobs.waitUntilTerminal(started.jobId, 3000)
      expect(settled?.status).toBe('DISCONNECTED')
    } finally {
      closedSpy.mockRestore()
    }
  })

  it('startExecJob catch settles FAILED when withLock throws 409 after create', async () => {
    const s = new MockSession({ id: 'job-race-lock' })
    s.forceState('WAITING_INPUT')
    internals().sessions.set(s.id, s)

    const lock = internals().opLock
    const isLockedSpy = vi.spyOn(lock, 'isLocked').mockReturnValue(false)
    const withLockSpy = vi.spyOn(lock, 'withLock').mockRejectedValue(new TransferError('conflict job', 409))
    try {
      const started = sessionManager.execStart(s, 'echo x', 2000)
      const settled = await sessionManager.jobs.waitUntilTerminal(started.jobId, 3000)
      expect(settled?.status).toBe('FAILED')
      expect(settled?.error).toMatch(/conflict/)
    } finally {
      isLockedSpy.mockRestore()
      withLockSpy.mockRestore()
    }
  })

  it('lockBusyMessage without an active job uses the generic text', async () => {
    const s = new MockSession({ id: 'job-busy-generic' })
    s.forceState('WAITING_INPUT')
    internals().sessions.set(s.id, s)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const held = internals().opLock.withLock(s.id, async () => { await gate }, 'busy', 'transfer')
    await expect(sessionManager.exec(s, 'echo x', 1000)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/performing another operation|running a/),
    })
    release()
    await held
  })

  it('execCancel works when the live session map entry is gone', async () => {
    const s = new MockSession({ id: 'job-cancel-nosess' })
    s.forceState('WAITING_INPUT')
    internals().sessions.set(s.id, s)
    const started = sessionManager.execStart(s, 'echo x\n', 2000)
    internals().sessions.delete(s.id)
    internals().opLock.clear(s.id)
    const canceled = await sessionManager.execCancel(started.jobId)
    expect(canceled.status).toBe('CANCELED')
  })

  it('execStatus waitMs 0 returns immediately for a RUNNING job', async () => {
    const s = new MockSession({ id: 'job-status-nowait' })
    s.forceState('WAITING_INPUT')
    internals().sessions.set(s.id, s)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    // Hold lock so the runner cannot finish quickly
    const held = internals().opLock.withLock(s.id, async () => { await gate }, 'busy', 'exec')
    // Bypass isLocked precheck
    const isLockedSpy = vi.spyOn(internals().opLock, 'isLocked').mockReturnValue(false)
    try {
      // Create a bare RUNNING job without starting the runner
      const job = sessionManager.jobs.create(s.id, 'exec', { command: 'x', startSeq: 0, timeoutMs: 1000 })
      const status = await sessionManager.execStatus(job.id, 0, 0)
      expect(status.done).toBe(false)
      expect(status.job.status).toBe('RUNNING')
    } finally {
      isLockedSpy.mockRestore()
      release()
      await held
    }
  })

  it('lockBusyMessage includes command snippet for an active TIMED_OUT job', async () => {
    const s = new MockSession({ id: 'job-busy-timeout' })
    s.forceState('WAITING_INPUT')
    internals().sessions.set(s.id, s)
    const job = sessionManager.jobs.create(s.id, 'exec', {
      command: 'very-long-command-name-for-busy-message',
      startSeq: 0,
      timeoutMs: 1000,
    })
    sessionManager.jobs.settle(job.id, 'TIMED_OUT', { state: 'OUTPUTTING' })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const held = internals().opLock.withLock(s.id, async () => { await gate }, 'busy', 'exec')
    await expect(sessionManager.exec(s, 'echo x', 1000)).rejects.toMatchObject({
      message: expect.stringContaining(job.id),
    })
    release()
    await held
  })
})
