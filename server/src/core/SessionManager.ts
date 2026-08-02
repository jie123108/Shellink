import crypto from 'node:crypto'
import fs from 'node:fs'
import { and, asc, eq, gt, ne } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { decryptSecret } from '../db/crypto.js'
import { config } from '../config.js'
import { bus } from './events.js'
import { SshSession } from './SshSession.js'
import { LocalPtySession } from './LocalPtySession.js'
import { FileTransfer, type DownloadResult, type TransferMeta } from './FileTransfer.js'
import { RemoteEdit, type RemoteEditResult, type TextEdit } from './RemoteEdit.js'
import { SessionOpLock } from './SessionOpLock.js'
import { ExecJobRegistry, type JobSnapshot, type JobStatus } from './ExecJobRegistry.js'
import { TransferError } from './TransferError.js'
import { resolveSshPrivateKey } from './sshIdentity.js'
import { stripAnsi } from './ansi.js'
import type { BaseSession } from './BaseSession.js'
import type { HistoryChunkRow, ProfileRow, SessionRow } from '../db/schema.js'

export interface CreateSessionOptions {
  profileId: string
  cols?: number
  rows?: number
}

export interface ExecResult {
  jobId: string
  status: JobStatus
  state: string
  output: string
  startSeq: number
  cursor: number
  durationMs: number
  timedOut: boolean
}

export interface ExecStartResult {
  jobId: string
  status: JobStatus
  startSeq: number
  state: string
}

export interface ExecStatusResult {
  job: JobSnapshot
  output: string
  cursor: number
  done: boolean
}

/** Collapse consecutive internal output chunks into a single human-readable placeholder. */
export function renderHistoryWithoutInternal(
  chunks: Array<{ dataRaw: string; internal?: number | null }>,
  opts: { newline?: '\n' | '\r\n' } = {},
): string {
  const nl = opts.newline ?? '\n'
  let out = ''
  let hidden = 0
  const flushHidden = () => {
    if (hidden <= 0) return
    // Leading newline: the last public chunk is often a prompt with no trailing \n,
    // so without this the placeholder glues onto `user@host$ `.
    out += `${nl}[shellink] hidden ${hidden} internal transfer output chunks${nl}`
    hidden = 0
  }
  for (const chunk of chunks) {
    if (chunk.internal) {
      hidden += 1
      continue
    }
    flushHidden()
    out += chunk.dataRaw
  }
  flushHidden()
  return out
}

/** 8 位字母数字会话 ID（排除易混淆字符 0/O/1/I/l） */
const SESSION_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz'

function generateSessionId(): string {
  const bytes = crypto.randomBytes(8)
  let id = ''
  for (let i = 0; i < 8; i++) {
    id += SESSION_ID_ALPHABET[bytes[i]! % SESSION_ID_ALPHABET.length]
  }
  return id
}

class SessionManager {
  private sessions = new Map<string, BaseSession>()
  private readonly opLock = new SessionOpLock()
  readonly jobs = new ExecJobRegistry()
  readonly fileTransfer = new FileTransfer(this, this.opLock)
  readonly remoteEdit = new RemoteEdit(this, this.opLock)

  /**
   * `session.data` fires once per output/input chunk — a burst upload/exec can raise
   * hundreds of events within milliseconds. Buffering them and flushing in a single
   * batched insert on the next microtask avoids hundreds of synchronous SQLite writes
   * blocking the event loop, which previously starved the PTY reader and silently
   * dropped input bytes under sustained write pressure (the PS2-hang failure mode).
   */
  private pendingHistory: Array<typeof schema.historyChunks.$inferInsert> = []
  private historyFlushScheduled = false
  /** AbortControllers for detached transfer/edit jobs, keyed by job ID; see execCancel. */
  private readonly transferAborts = new Map<string, AbortController>()

  constructor() {
    this.opLock.setBusyDescriber((sid) => this.lockBusyMessage(sid))
    bus.on('session.data', (e) => {
      this.pendingHistory.push({
        sessionId: e.sessionId,
        seq: e.seq,
        direction: e.direction,
        dataRaw: e.raw,
        dataPlain: e.plain,
        internal: e.internal ? 1 : 0,
        createdAt: Date.now(),
      })
      this.scheduleHistoryFlush()
    })
    bus.on('session.state', (e) => {
      db.update(schema.sessions)
        .set({ state: e.state as never })
        .where(eq(schema.sessions.id, e.sessionId))
        .run()
    })
    bus.on('session.mode', (e) => {
      db.update(schema.sessions)
        .set({ mode: e.mode })
        .where(eq(schema.sessions.id, e.sessionId))
        .run()
    })
    bus.on('session.closed', (e) => {
      db.update(schema.sessions)
        .set({
          state: 'DISCONNECTED',
          closedAt: Date.now(),
          closeReason: e.reason,
          exitCode: e.exitCode,
        })
        .where(eq(schema.sessions.id, e.sessionId))
        .run()
      this.fileTransfer.clearSession(e.sessionId)
      this.remoteEdit.clearSession(e.sessionId)
      this.jobs.clearSession(e.sessionId)
      this.opLock.clear(e.sessionId)
      this.sessions.delete(e.sessionId)
    })
  }

  private scheduleHistoryFlush(): void {
    if (this.historyFlushScheduled) return
    this.historyFlushScheduled = true
    setImmediate(() => this.flushHistory())
  }

  /** Synchronously persist any buffered history chunks; call before any history read. */
  private flushHistory(): void {
    this.historyFlushScheduled = false
    if (this.pendingHistory.length === 0) return
    const batch = this.pendingHistory
    this.pendingHistory = []
    db.insert(schema.historyChunks).values(batch).run()
  }

  /** 服务重启后，将库中残留的"活跃"会话标记为断开 */
  markStaleSessions(): void {
    db.update(schema.sessions)
      .set({ state: 'DISCONNECTED', closedAt: Date.now(), closeReason: 'Service restarted' })
      .where(ne(schema.sessions.state, 'DISCONNECTED'))
      .run()
  }

  /** 生成不与内存/库中已有会话冲突的短 ID */
  private allocSessionId(): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const id = generateSessionId()
      if (this.sessions.has(id)) continue
      const exists = db
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, id))
        .get()
      if (!exists) return id
    }
    throw new Error('Unable to allocate a unique session ID')
  }

  create(profile: ProfileRow, opts: CreateSessionOptions): BaseSession {
    const id = this.allocSessionId()
    const cols = opts.cols ?? profile.cols
    const rows = opts.rows ?? profile.rows

    const common = {
      id,
      profileId: profile.id,
      profileName: profile.name,
      term: profile.term,
      cols,
      rows,
      promptRegex: profile.promptRegex,
    }
    const password = profile.encryptedPassword ? decryptSecret(profile.encryptedPassword) : undefined
    const passphrase = profile.encryptedPassphrase
      ? decryptSecret(profile.encryptedPassphrase)
      : undefined

    let session: BaseSession
    let target: string
    if (profile.connectType === 'command') {
      const command = profile.command ?? ''
      session = new LocalPtySession({ ...common, command })
      target = command.length > 120 ? command.slice(0, 117) + '...' : command
    } else {
      let authType = profile.authType
      let privateKey = profile.encryptedPrivateKey
        ? decryptSecret(profile.encryptedPrivateKey)
        : undefined
      // 无可用凭证时回退本机 SSH 默认私钥（~/.ssh/config IdentityFile / id_rsa 等）
      if (!privateKey && !password) {
        const fallback = resolveSshPrivateKey({
          host: profile.host,
          username: profile.username,
        })
        if (fallback) {
          authType = 'key'
          privateKey = fallback.content
        }
      }
      session = new SshSession({
        ...common,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        authType,
        password,
        passphrase,
        privateKey,
      })
      target = `${profile.username}@${profile.host}:${profile.port}`
    }

    db.insert(schema.sessions)
      .values({
        id,
        profileId: profile.id,
        profileName: profile.name,
        target,
        state: 'CONNECTING',
        mode: 'AUTO',
        cols,
        rows,
        createdAt: session.createdAt,
      })
      .run()

    this.sessions.set(id, session)
    session.connect()
    bus.emit('session.created', { sessionId: id })
    return session
  }

  get(id: string): BaseSession | undefined {
    return this.sessions.get(id)
  }

  /** 活跃会话 + 库中历史会话合并列表 */
  list(): Array<Record<string, unknown>> {
    const rows = db
      .select()
      .from(schema.sessions)
      .orderBy(asc(schema.sessions.createdAt))
      .all() as SessionRow[]
    return rows.map((row) => {
      const live = this.sessions.get(row.id)
      return {
        id: row.id,
        profileId: row.profileId,
        profileName: row.profileName,
        target: row.target,
        state: live?.state ?? row.state,
        mode: live?.mode ?? row.mode,
        cols: row.cols,
        rows: row.rows,
        createdAt: row.createdAt,
        closedAt: row.closedAt,
        closeReason: row.closeReason,
        active: !!live,
      }
    }).sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1
      const leftTime = left.active ? left.createdAt : (left.closedAt ?? left.createdAt)
      const rightTime = right.active ? right.createdAt : (right.closedAt ?? right.createdAt)
      return rightTime - leftTime
    })
  }

  /**
   * 增量读取纯文本历史（从 data_raw 重算，避免旧 data_plain 把 \\r 误当成换行）。
   * `includeInternal` 默认 true：FileTransfer/RemoteEdit/exec 解析需要完整 PTY 流；
   * 展示路径传 false，把连续内部段折叠成一行占位摘要。
   */
  history(
    sessionId: string,
    since = 0,
    limit = 2000,
    opts: { includeInternal?: boolean } = {},
  ): { cursor: number; text: string } {
    this.flushHistory()
    const includeInternal = opts.includeInternal !== false
    const chunks = db
      .select()
      .from(schema.historyChunks)
      .where(
        and(
          eq(schema.historyChunks.sessionId, sessionId),
          gt(schema.historyChunks.seq, since),
        ),
      )
      .orderBy(asc(schema.historyChunks.seq))
      .limit(limit)
      .all() as HistoryChunkRow[]
    const outputs = chunks.filter((c) => c.direction === 'output')
    const raw = includeInternal
      ? outputs.map((c) => c.dataRaw).join('')
      : renderHistoryWithoutInternal(outputs)
    const cursor = chunks.length > 0 ? chunks[chunks.length - 1]!.seq : since
    return { cursor, text: stripAnsi(raw) }
  }

  /** 读取原始 ANSI 历史（Web 端重放用），限制总量 */
  rawHistory(
    sessionId: string,
    maxBytes = 512 * 1024,
    opts: { includeInternal?: boolean } = {},
  ): string {
    this.flushHistory()
    const includeInternal = opts.includeInternal !== false
    const chunks = db
      .select()
      .from(schema.historyChunks)
      .where(
        and(
          eq(schema.historyChunks.sessionId, sessionId),
          eq(schema.historyChunks.direction, 'output'),
        ),
      )
      .orderBy(asc(schema.historyChunks.seq))
      .all() as HistoryChunkRow[]
    if (!includeInternal) {
      // CRLF so xterm replay advances to column 0 (bare \n leaves the cursor mid-line).
      const filtered = renderHistoryWithoutInternal(chunks, { newline: '\r\n' })
      return filtered.length > maxBytes ? filtered.slice(-maxBytes) : filtered
    }
    let total = 0
    const parts: string[] = []
    for (let i = chunks.length - 1; i >= 0; i--) {
      total += chunks[i]!.dataRaw.length
      if (total > maxBytes) break
      parts.unshift(chunks[i]!.dataRaw)
    }
    return parts.join('')
  }

  /**
   * AUTO 输入门禁：CONNECTING（OTP）始终可写；transfer 锁下仅 Ctrl+C；
   * exec 锁下允许交互输入；未加锁时 AUTO 可在 WAITING_INPUT / OUTPUTTING / IDLE 写入
   *（read 等待常落入 IDLE；DISCONNECTED 拒绝）。
   */
  writeInput(session: BaseSession, text: string, appendNewline = true): void {
    if (session.mode === 'MANUAL') {
      throw new TransferError('Session is in MANUAL mode; AI input was rejected', 409)
    }
    const payload = appendNewline ? text + '\n' : text
    const isCtrlC = text === '\u0003' || payload === '\u0003'

    if (session.state === 'DISCONNECTED') {
      throw new TransferError('Session is disconnected', 404)
    }

    if (session.state === 'CONNECTING') {
      session.write(payload)
      return
    }

    const lockKind = this.opLock.kind(session.id)
    if (lockKind === 'transfer') {
      if (!isCtrlC) {
        throw new TransferError('This session is performing a file operation; try again later', 409)
      }
      session.write(payload)
      return
    }

    // exec 锁或空闲稳定态：允许交互 / 正常输入
    if (
      lockKind === 'exec' ||
      session.state === 'WAITING_INPUT' ||
      session.state === 'OUTPUTTING' ||
      session.state === 'IDLE'
    ) {
      session.write(payload)
      return
    }

    throw new TransferError(`Session state is ${session.state}; input is not currently allowed`, 409)
  }

  /** 同步执行：写入命令并等待会话回到稳定状态，返回本次输出。超时时也返回 jobId 与 cursor，便于轮询续接。 */
  async exec(
    session: BaseSession,
    command: string,
    timeoutMs = config.execDefaultTimeoutMs,
  ): Promise<ExecResult> {
    const job = this.startExecJob(session, command, timeoutMs)
    const startAt = job.startedAt
    const settled = await this.jobs.waitUntilNotRunning(job.id, timeoutMs + 1000)
    const status = settled?.status ?? 'DISCONNECTED'
    // Lock conflicts settle the job as FAILED with the 409 message; surface that to the caller.
    if (status === 'FAILED' && settled?.error) {
      throw new TransferError(settled.error, 409)
    }
    const state = settled?.state ?? session.state
    const { text } = this.history(session.id, job.startSeq, 10_000)
    const cursor = session.lastSeq
    return {
      jobId: job.id,
      status,
      state,
      output: text,
      startSeq: job.startSeq,
      cursor,
      durationMs: Date.now() - startAt,
      timedOut: status === 'TIMED_OUT',
    }
  }

  /** 启动一个 exec 作业并立即返回，不等待完成。 */
  execStart(session: BaseSession, command: string, timeoutMs = config.execDefaultTimeoutMs): ExecStartResult {
    const job = this.startExecJob(session, command, timeoutMs)
    return { jobId: job.id, status: job.status, startSeq: job.startSeq, state: session.state }
  }

  /** 查询 exec 作业状态；长轮询最多等待 waitMs 直到作业进入终态。返回自 since 之后的增量输出。 */
  async execStatus(jobId: string, since: number, waitMs = 0): Promise<ExecStatusResult> {
    const job = this.jobs.get(jobId)
    if (!job) throw new TransferError('Job not found', 404)
    const final = await this.jobs.waitUntilTerminal(jobId, waitMs)
    const current = final ?? this.jobs.get(jobId) ?? job
    const { text, cursor } = this.history(current.sessionId, since, 10_000)
    const done = current.status === 'DONE' || current.status === 'CANCELED' || current.status === 'DISCONNECTED' || current.status === 'FAILED'
    return { job: current, output: text, cursor, done }
  }

  /**
   * 取消一个作业：向 PTY 发送 Ctrl+C 并标记为 CANCELED。对 transfer/edit 作业额外
   * 触发 AbortController，让其内部等待循环立即退出而不是空等到 timeoutMs 才释放
   * opLock（此前取消一个卡在 PS2 里的上传，锁要等满 120s 超时才释放）。
   */
  async execCancel(jobId: string): Promise<JobSnapshot> {
    const job = this.jobs.get(jobId)
    if (!job) throw new TransferError('Job not found', 404)
    if (job.status === 'DONE' || job.status === 'CANCELED' || job.status === 'DISCONNECTED') {
      return job
    }
    this.transferAborts.get(jobId)?.abort()
    const session = this.sessions.get(job.sessionId)
    if (session && !session.isClosed()) {
      try { session.write('\u0003') } catch { /* session may be closing */ }
    }
    this.jobs.settle(jobId, 'CANCELED')
    return this.jobs.get(jobId) ?? job
  }

  /** 创建 exec 作业并启动后台运行器（在 opLock 下持有锁直到命令真正结束）。 */
  private startExecJob(session: BaseSession, command: string, timeoutMs: number): JobSnapshot {
    if (session.mode === 'MANUAL') {
      throw new TransferError('Session is in MANUAL mode; AI input was rejected', 409)
    }
    // Prefer the lock-busy hint over a generic state error when another job still holds the session.
    if (this.opLock.isLocked(session.id)) {
      throw new TransferError(this.lockBusyMessage(session.id), 409)
    }
    if (session.state !== 'WAITING_INPUT') {
      throw new TransferError(
        `Session state is ${session.state}; commands can run only while WAITING_INPUT`,
        409,
      )
    }
    const startSeq = session.lastSeq
    const job = this.jobs.create(session.id, 'exec', { command, startSeq, timeoutMs })
    void this.runExecJob(job, session, command, timeoutMs).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      const status = error instanceof TransferError && error.statusCode === 409 ? 'FAILED' : 'DISCONNECTED'
      this.jobs.settle(job.id, status, { error: message })
    })
    return job
  }

  private async runExecJob(job: JobSnapshot, session: BaseSession, command: string, timeoutMs: number): Promise<void> {
    await this.opLock.withLock(
      session.id,
      async () => {
        if (session.state === 'DISCONNECTED' || session.isClosed()) {
          this.jobs.settle(job.id, 'DISCONNECTED')
          return
        }
        session.write(command.endsWith('\n') || command.endsWith('\r') ? command : command + '\n')
        // 慢输出间隙会进 IDLE；exec 必须等到 prompt（WAITING_INPUT）或断开
        const first = await session.waitForStable(timeoutMs, { acceptIdle: false })
        this.jobs.touchState(job.id, first.state)
        if (!first.timedOut) {
          this.jobs.settle(job.id, 'DONE', { state: first.state })
          return
        }
        this.jobs.settle(job.id, 'TIMED_OUT', { state: first.state })
        // 超时后远端命令可能仍在运行；继续持有锁直到真正回到 prompt 或断开，
        // 避免后续 exec 与仍在运行的命令交错。
        const followUp = await session.waitForStable(24 * 60 * 60 * 1000, { acceptIdle: false })
        this.jobs.touchState(job.id, followUp.state)
        this.jobs.settle(job.id, followUp.timedOut ? 'TIMED_OUT' : 'DONE', { state: followUp.state })
      },
      this.lockBusyMessage(session.id),
      'exec',
    )
  }

  /** 构造带当前运行作业提示的 opLock 冲突消息。 */
  private lockBusyMessage(sessionId: string): string {
    const active = this.jobs.activeForSession(sessionId)
    if (!active) return 'This session is performing another operation; try again later'
    const what = active.command ? `exec: ${active.command.slice(0, 80)}` : `${active.kind} operation`
    return `This session is running a ${what} (job ${active.id}, status ${active.status}); poll 'session exec-status ${active.id}' or cancel with 'session exec-cancel ${active.id}'`
  }

  async download(
    session: BaseSession,
    remotePath: string,
    timeoutMs = config.transferTimeoutMs,
  ): Promise<DownloadResult> {
    return this.fileTransfer.download(session, remotePath, timeoutMs)
  }

  async upload(
    session: BaseSession,
    remotePath: string,
    data: Buffer,
    opts: { timeoutMs?: number; expectedSha256?: string } = {},
  ): Promise<TransferMeta> {
    return this.fileTransfer.upload(session, remotePath, data, opts)
  }

  async edit(
    session: BaseSession,
    remotePath: string,
    edits: TextEdit[],
    timeoutMs = config.editTimeoutMs,
  ): Promise<RemoteEditResult> {
    return this.remoteEdit.edit(session, remotePath, edits, timeoutMs)
  }

  /** 启动一个 detach 上传作业并立即返回。 */
  uploadStart(
    session: BaseSession,
    remotePath: string,
    data: Buffer,
    opts: { timeoutMs?: number; expectedSha256?: string } = {},
  ): JobSnapshot {
    const timeoutMs = opts.timeoutMs ?? config.transferTimeoutMs
    const job = this.jobs.create(session.id, 'upload', { remotePath, startSeq: session.lastSeq, timeoutMs })
    const controller = new AbortController()
    this.transferAborts.set(job.id, controller)
    void this.runUploadJob(job, session, remotePath, data, { ...opts, signal: controller.signal })
    return this.jobs.get(job.id) ?? job
  }

  /** 启动一个 detach 下载作业并立即返回；完成后由 daemon 将文件写入 outputLocalPath。 */
  downloadStart(
    session: BaseSession,
    remotePath: string,
    outputLocalPath: string,
    timeoutMs = config.transferTimeoutMs,
  ): JobSnapshot {
    const job = this.jobs.create(session.id, 'download', { remotePath, startSeq: session.lastSeq, timeoutMs })
    const controller = new AbortController()
    this.transferAborts.set(job.id, controller)
    void this.runDownloadJob(job, session, remotePath, outputLocalPath, timeoutMs, controller.signal)
    return this.jobs.get(job.id) ?? job
  }

  /** 启动一个 detach 远程编辑作业并立即返回。 */
  editStart(
    session: BaseSession,
    remotePath: string,
    edits: TextEdit[],
    timeoutMs = config.editTimeoutMs,
  ): JobSnapshot {
    const job = this.jobs.create(session.id, 'edit', { remotePath, startSeq: session.lastSeq, timeoutMs })
    const controller = new AbortController()
    this.transferAborts.set(job.id, controller)
    void this.runEditJob(job, session, remotePath, edits, timeoutMs, controller.signal)
    return this.jobs.get(job.id) ?? job
  }

  private async runUploadJob(
    job: JobSnapshot,
    session: BaseSession,
    remotePath: string,
    data: Buffer,
    opts: { timeoutMs?: number; expectedSha256?: string; signal?: AbortSignal },
  ): Promise<void> {
    try {
      const result = await this.fileTransfer.upload(session, remotePath, data, opts)
      this.jobs.settle(job.id, 'DONE', { state: session.state, result })
    } catch (error) {
      this.jobs.settle(job.id, 'FAILED', { state: session.state, error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.transferAborts.delete(job.id)
    }
  }

  private async runDownloadJob(
    job: JobSnapshot,
    session: BaseSession,
    remotePath: string,
    outputLocalPath: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const result = await this.fileTransfer.download(session, remotePath, timeoutMs, signal)
      fs.writeFileSync(outputLocalPath, Buffer.from(result.data))
      const meta: Record<string, unknown> = { ...result, data: undefined, output: outputLocalPath }
      this.jobs.settle(job.id, 'DONE', { state: session.state, result: meta })
    } catch (error) {
      this.jobs.settle(job.id, 'FAILED', { state: session.state, error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.transferAborts.delete(job.id)
    }
  }

  private async runEditJob(
    job: JobSnapshot,
    session: BaseSession,
    remotePath: string,
    edits: TextEdit[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const result = await this.remoteEdit.edit(session, remotePath, edits, timeoutMs, signal)
      this.jobs.settle(job.id, 'DONE', { state: session.state, result })
    } catch (error) {
      this.jobs.settle(job.id, 'FAILED', { state: session.state, error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.transferAborts.delete(job.id)
    }
  }

  /**
   * 彻底删除会话记录（含历史输出）。
   * 若仍在活跃则先关闭。供 Web 端在携带有效 token 时调用。
   */
  remove(sessionId: string): boolean {
    const live = this.sessions.get(sessionId)
    if (live) {
      live.close('Deleted from the Web UI')
    }
    // Flush before deleting so a still-pending batch cannot resurrect rows for a
    // session record we are about to remove.
    this.flushHistory()
    const row = db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get()
    if (!row && !live) return false
    db.delete(schema.historyChunks).where(eq(schema.historyChunks.sessionId, sessionId)).run()
    db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run()
    this.fileTransfer.clearSession(sessionId)
    this.remoteEdit.clearSession(sessionId)
    this.jobs.clearSession(sessionId)
    this.opLock.clear(sessionId)
    this.sessions.delete(sessionId)
    return true
  }

  /**
   * 批量删除已结束会话记录（含历史）。活跃会话始终保留。
   * - `24h` / `7d`：按 closedAt（缺失时回退 createdAt）早于截止时间
   * - `all`：删除全部非活跃会话
   */
  removeClosedRecords(olderThan: '24h' | '7d' | 'all', now = Date.now()): number {
    const cutoffMs =
      olderThan === '24h' ? now - 24 * 60 * 60 * 1000
        : olderThan === '7d' ? now - 7 * 24 * 60 * 60 * 1000
          : null

    const rows = db.select({ id: schema.sessions.id, createdAt: schema.sessions.createdAt, closedAt: schema.sessions.closedAt })
      .from(schema.sessions)
      .all()

    let deleted = 0
    for (const row of rows) {
      if (this.sessions.has(row.id)) continue
      if (cutoffMs !== null) {
        const endedAt = row.closedAt ?? row.createdAt
        if (endedAt >= cutoffMs) continue
      }
      if (this.remove(row.id)) deleted += 1
    }
    return deleted
  }
}

export const sessionManager = new SessionManager()
