import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'

export type JobKind = 'exec' | 'upload' | 'download' | 'edit'
export type JobStatus = 'RUNNING' | 'DONE' | 'TIMED_OUT' | 'CANCELED' | 'DISCONNECTED' | 'FAILED'

const JOB_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz'
const MAX_JOBS_PER_SESSION = 20

export interface JobSnapshot {
  id: string
  sessionId: string
  kind: JobKind
  command: string | null
  remotePath: string | null
  startSeq: number
  startedAt: number
  endedAt: number | null
  timeoutMs: number
  status: JobStatus
  state: string | null
  error: string | null
  result: unknown | null
}

interface JobRecord extends Omit<JobSnapshot, 'result'> {
  result: unknown | null
}

function generateJobId(): string {
  const bytes = crypto.randomBytes(8)
  let id = ''
  for (let i = 0; i < 8; i++) id += JOB_ID_ALPHABET[bytes[i]! % JOB_ID_ALPHABET.length]
  return id
}

/**
 * In-memory registry of long-running session operations (exec / transfer / edit).
 * Each session keeps the most recent {@link MAX_JOBS_PER_SESSION} jobs; running jobs are never evicted.
 * Long-polling is supported via {@link waitForSettlement}.
 */
export class ExecJobRegistry {
  private readonly jobs = new Map<string, JobRecord>()
  private readonly bySession = new Map<string, string[]>()
  private readonly emitter = new EventEmitter()

  create(
    sessionId: string,
    kind: JobKind,
    opts: { command?: string; remotePath?: string; startSeq: number; timeoutMs: number },
  ): JobSnapshot {
    const id = this.allocId()
    const record: JobRecord = {
      id,
      sessionId,
      kind,
      command: opts.command ?? null,
      remotePath: opts.remotePath ?? null,
      startSeq: opts.startSeq,
      startedAt: Date.now(),
      endedAt: null,
      timeoutMs: opts.timeoutMs,
      status: 'RUNNING',
      state: null,
      error: null,
      result: null,
    }
    this.jobs.set(id, record)
    const list = this.bySession.get(sessionId) ?? []
    list.push(id)
    this.bySession.set(sessionId, list)
    this.evict(sessionId)
    return this.snapshot(record)
  }

  get(jobId: string): JobSnapshot | undefined {
    const r = this.jobs.get(jobId)
    return r ? this.snapshot(r) : undefined
  }

  /**
   * Returns the most recent non-terminal job for a session (RUNNING or TIMED_OUT).
   * TIMED_OUT is included because the session lock is still held until the remote command
   * actually finishes (or is canceled).
   */
  activeForSession(sessionId: string): JobSnapshot | undefined {
    const ids = this.bySession.get(sessionId)
    if (!ids) return undefined
    for (let i = ids.length - 1; i >= 0; i--) {
      const r = this.jobs.get(ids[i]!)
      if (r && (r.status === 'RUNNING' || r.status === 'TIMED_OUT')) return this.snapshot(r)
    }
    return undefined
  }

  listForSession(sessionId: string): JobSnapshot[] {
    const ids = this.bySession.get(sessionId) ?? []
    return ids
      .map((id) => this.jobs.get(id))
      .filter((r): r is JobRecord => !!r)
      .map((r) => this.snapshot(r))
  }

  /** Transition a job's status. Terminal statuses (DONE/CANCELED/DISCONNECTED) cannot be overwritten;
   *  TIMED_OUT may later transition to a terminal status. Returns true if the transition applied. */
  settle(jobId: string, status: JobStatus, extra?: { state?: string | null; error?: string | null; result?: unknown }): boolean {
    const r = this.jobs.get(jobId)
    if (!r) return false
    const terminal = status === 'DONE' || status === 'CANCELED' || status === 'DISCONNECTED' || status === 'FAILED'
    const alreadyTerminal = r.status === 'DONE' || r.status === 'CANCELED' || r.status === 'DISCONNECTED' || r.status === 'FAILED'
    if (alreadyTerminal || r.status === status) return false
    r.status = status
    if (extra?.state !== undefined) r.state = extra.state
    if (extra?.error !== undefined) r.error = extra.error
    if (extra?.result !== undefined) r.result = extra.result
    if (terminal) r.endedAt = Date.now()
    this.emitter.emit(`settled:${jobId}`)
    return true
  }

  /** Update the recorded session state without settling (used while RUNNING). */
  touchState(jobId: string, state: string): void {
    const r = this.jobs.get(jobId)
    if (r) r.state = state
  }

  /** Wait until the job leaves RUNNING (TIMED_OUT/DONE/CANCELED/DISCONNECTED) or waitMs elapses. */
  async waitUntilNotRunning(jobId: string, waitMs: number): Promise<JobSnapshot | undefined> {
    return this.waitFor(jobId, (s) => s !== 'RUNNING', waitMs)
  }

  /** Wait until the job reaches a terminal status (DONE/CANCELED/DISCONNECTED/FAILED) or waitMs elapses. */
  async waitUntilTerminal(jobId: string, waitMs: number): Promise<JobSnapshot | undefined> {
    return this.waitFor(jobId, (s) => s === 'DONE' || s === 'CANCELED' || s === 'DISCONNECTED' || s === 'FAILED', waitMs)
  }
  private async waitFor(jobId: string, predicate: (s: JobStatus) => boolean, waitMs: number): Promise<JobSnapshot | undefined> {
    const r = this.jobs.get(jobId)
    if (!r) return undefined
    if (predicate(r.status)) return this.snapshot(r)
    if (waitMs <= 0) return this.snapshot(r)
    return new Promise<JobSnapshot | undefined>((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const onSettle = (): void => {
        const cur = this.jobs.get(jobId)
        if (!cur) { cleanup(); resolve(undefined); return }
        if (predicate(cur.status)) { cleanup(); resolve(this.snapshot(cur)) }
      }
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        this.emitter.off(`settled:${jobId}`, onSettle)
      }
      this.emitter.on(`settled:${jobId}`, onSettle)
      timer = setTimeout(() => { cleanup(); const cur = this.jobs.get(jobId); resolve(cur ? this.snapshot(cur) : undefined) }, waitMs)
    })
  }

  /** Mark any RUNNING jobs for a session as DISCONNECTED and drop all records for that session. */
  clearSession(sessionId: string): void {
    const ids = this.bySession.get(sessionId)
    if (!ids) return
    for (const id of ids) {
      const r = this.jobs.get(id)
      if (r && r.status === 'RUNNING') this.settle(id, 'DISCONNECTED')
      this.jobs.delete(id)
    }
    this.bySession.delete(sessionId)
  }

  private allocId(): string {
    for (let i = 0; i < 32; i++) {
      const id = generateJobId()
      if (!this.jobs.has(id)) return id
    }
    throw new Error('Unable to allocate a unique job ID')
  }

  private evict(sessionId: string): void {
    const ids = this.bySession.get(sessionId)
    if (!ids || ids.length <= MAX_JOBS_PER_SESSION) return
    let i = 0
    while (i < ids.length && ids.length > MAX_JOBS_PER_SESSION) {
      const id = ids[i]!
      const r = this.jobs.get(id)
      if (r && r.status === 'RUNNING') {
        i++
        continue
      }
      this.jobs.delete(id)
      ids.splice(i, 1)
    }
  }

  private snapshot(r: JobRecord): JobSnapshot {
    return {
      id: r.id,
      sessionId: r.sessionId,
      kind: r.kind,
      command: r.command,
      remotePath: r.remotePath,
      startSeq: r.startSeq,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      timeoutMs: r.timeoutMs,
      status: r.status,
      state: r.state,
      error: r.error,
      result: r.result,
    }
  }
}
