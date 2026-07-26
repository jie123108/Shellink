import { describe, expect, it } from 'vitest'
import { ExecJobRegistry } from '../../src/core/ExecJobRegistry.js'

describe('ExecJobRegistry', () => {
  it('creates a RUNNING job and snapshots it', () => {
    const reg = new ExecJobRegistry()
    const job = reg.create('s1', 'exec', { command: 'ls', startSeq: 5, timeoutMs: 1000 })
    expect(job.id).toHaveLength(8)
    expect(job.sessionId).toBe('s1')
    expect(job.kind).toBe('exec')
    expect(job.command).toBe('ls')
    expect(job.startSeq).toBe(5)
    expect(job.status).toBe('RUNNING')
    expect(job.endedAt).toBeNull()
    expect(reg.get(job.id)).toMatchObject({ id: job.id, status: 'RUNNING' })
  })

  it('settle transitions to terminal status and resolves waitUntilNotRunning', async () => {
    const reg = new ExecJobRegistry()
    const job = reg.create('s1', 'exec', { command: 'x', startSeq: 0, timeoutMs: 100 })
    const waiting = reg.waitUntilNotRunning(job.id, 5000)
    reg.settle(job.id, 'DONE', { state: 'WAITING_INPUT' })
    const settled = await waiting
    expect(settled?.status).toBe('DONE')
    expect(settled?.state).toBe('WAITING_INPUT')
    expect(settled?.endedAt).not.toBeNull()
  })

  it('settle is idempotent: terminal statuses cannot be overwritten', () => {
    const reg = new ExecJobRegistry()
    const job = reg.create('s1', 'exec', { startSeq: 0, timeoutMs: 100 })
    expect(reg.settle(job.id, 'TIMED_OUT')).toBe(true)
    expect(reg.settle(job.id, 'DONE')).toBe(true)
    expect(reg.settle(job.id, 'CANCELED')).toBe(false)
    expect(reg.get(job.id)?.status).toBe('DONE')
  })

  it('TIMED_OUT can transition to DONE and waitUntilTerminal observes it', async () => {
    const reg = new ExecJobRegistry()
    const job = reg.create('s1', 'exec', { startSeq: 0, timeoutMs: 100 })
    reg.settle(job.id, 'TIMED_OUT')
    const waiting = reg.waitUntilTerminal(job.id, 5000)
    reg.settle(job.id, 'DONE', { state: 'WAITING_INPUT' })
    const settled = await waiting
    expect(settled?.status).toBe('DONE')
  })

  it('waitUntilNotRunning returns immediately when the job is already settled', async () => {
    const reg = new ExecJobRegistry()
    const job = reg.create('s1', 'exec', { startSeq: 0, timeoutMs: 100 })
    reg.settle(job.id, 'DONE')
    const snap = await reg.waitUntilNotRunning(job.id, 10_000)
    expect(snap?.status).toBe('DONE')
  })

  it('waitUntilNotRunning returns RUNNING snapshot when waitMs elapses without settlement', async () => {
    const reg = new ExecJobRegistry()
    const job = reg.create('s1', 'exec', { startSeq: 0, timeoutMs: 100 })
    const start = Date.now()
    const snap = await reg.waitUntilNotRunning(job.id, 50)
    expect(snap?.status).toBe('RUNNING')
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })

  it('waitUntilTerminal returns undefined for an unknown job', async () => {
    const reg = new ExecJobRegistry()
    expect(await reg.waitUntilTerminal('nope', 10)).toBeUndefined()
  })

  it('activeForSession returns the most recent RUNNING or TIMED_OUT job', () => {
    const reg = new ExecJobRegistry()
    const a = reg.create('s1', 'exec', { startSeq: 0, timeoutMs: 100 })
    const b = reg.create('s1', 'exec', { startSeq: 1, timeoutMs: 100 })
    reg.settle(a.id, 'DONE')
    expect(reg.activeForSession('s1')?.id).toBe(b.id)
    reg.settle(b.id, 'TIMED_OUT')
    expect(reg.activeForSession('s1')?.id).toBe(b.id)
    reg.settle(b.id, 'DONE')
    expect(reg.activeForSession('s1')).toBeUndefined()
  })

  it('listForSession returns all jobs for a session', () => {
    const reg = new ExecJobRegistry()
    const a = reg.create('s1', 'exec', { startSeq: 0, timeoutMs: 100 })
    const b = reg.create('s1', 'edit', { remotePath: '/x', startSeq: 1, timeoutMs: 100 })
    reg.create('s2', 'exec', { startSeq: 0, timeoutMs: 100 })
    expect(reg.listForSession('s1').map((j) => j.id)).toEqual([a.id, b.id])
  })

  it('clearSession settles RUNNING jobs as DISCONNECTED and drops all records', () => {
    const reg = new ExecJobRegistry()
    const a = reg.create('s1', 'exec', { startSeq: 0, timeoutMs: 100 })
    const b = reg.create('s1', 'exec', { startSeq: 1, timeoutMs: 100 })
    reg.settle(a.id, 'DONE')
    reg.clearSession('s1')
    expect(reg.get(a.id)).toBeUndefined()
    expect(reg.get(b.id)).toBeUndefined()
    expect(reg.listForSession('s1')).toEqual([])
    expect(reg.activeForSession('s1')).toBeUndefined()
  })

  it('evicts oldest completed jobs beyond the per-session limit but keeps RUNNING ones', () => {
    const reg = new ExecJobRegistry()
    const running = reg.create('s1', 'exec', { startSeq: 0, timeoutMs: 100 })
    // keep the running job pinned by never settling it; fill with completed jobs
    const ids: string[] = [running.id]
    for (let i = 0; i < 25; i++) {
      const j = reg.create('s1', 'exec', { startSeq: i + 1, timeoutMs: 100 })
      reg.settle(j.id, 'DONE')
      ids.push(j.id)
    }
    const list = reg.listForSession('s1')
    expect(list.length).toBeLessThanOrEqual(20)
    // running job is preserved even though it is the oldest
    expect(reg.get(running.id)?.status).toBe('RUNNING')
    // the oldest completed jobs are evicted
    expect(reg.get(ids[1]!)).toBeUndefined()
    // the most recent completed job is retained
    expect(reg.get(ids[ids.length - 1]!)).toBeDefined()
  })

  it('allocates unique ids', () => {
    const reg = new ExecJobRegistry()
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const j = reg.create('s1', 'exec', { startSeq: i, timeoutMs: 100 })
      expect(seen.has(j.id)).toBe(false)
      seen.add(j.id)
    }
  })

  it('touchState updates state without settling', () => {
    const reg = new ExecJobRegistry()
    const job = reg.create('s1', 'exec', { startSeq: 0, timeoutMs: 100 })
    reg.touchState(job.id, 'OUTPUTTING')
    expect(reg.get(job.id)?.state).toBe('OUTPUTTING')
    expect(reg.get(job.id)?.status).toBe('RUNNING')
  })
})
