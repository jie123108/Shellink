import crypto from 'node:crypto'
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
  state: string
  output: string
  durationMs: number
  timedOut: boolean
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
  readonly fileTransfer = new FileTransfer(this, this.opLock)
  readonly remoteEdit = new RemoteEdit(this, this.opLock)

  constructor() {
    // SQLite 同步写入，事件处理完成即已持久化。
    bus.on('session.data', (e) => {
      db.insert(schema.historyChunks)
        .values({
          sessionId: e.sessionId,
          seq: e.seq,
          direction: e.direction,
          dataRaw: e.raw,
          dataPlain: e.plain,
          createdAt: Date.now(),
        })
        .run()
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
      this.opLock.clear(e.sessionId)
      this.sessions.delete(e.sessionId)
    })
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

  /** 增量读取纯文本历史（从 data_raw 重算，避免旧 data_plain 把 \\r 误当成换行） */
  history(sessionId: string, since = 0, limit = 2000): { cursor: number; text: string } {
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
    const raw = chunks
      .filter((c) => c.direction === 'output')
      .map((c) => c.dataRaw)
      .join('')
    const cursor = chunks.length > 0 ? chunks[chunks.length - 1].seq : since
    return { cursor, text: stripAnsi(raw) }
  }

  /** 读取原始 ANSI 历史（Web 端重放用），限制总量 */
  rawHistory(sessionId: string, maxBytes = 512 * 1024): string {
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
      .all()
    let total = 0
    const parts: string[] = []
    for (let i = chunks.length - 1; i >= 0; i--) {
      total += chunks[i].dataRaw.length
      if (total > maxBytes) break
      parts.unshift(chunks[i].dataRaw)
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

  /** 同步执行：写入命令并等待会话回到稳定状态，返回本次输出 */
  async exec(
    session: BaseSession,
    command: string,
    timeoutMs = config.execDefaultTimeoutMs,
  ): Promise<ExecResult> {
    if (session.mode === 'MANUAL') {
      throw new TransferError('Session is in MANUAL mode; AI input was rejected', 409)
    }
    if (session.state !== 'WAITING_INPUT') {
      throw new TransferError(
        `Session state is ${session.state}; commands can run only while WAITING_INPUT`,
        409,
      )
    }
    return this.opLock.withLock(
      session.id,
      async () => {
        if (session.state === 'DISCONNECTED') {
          throw new TransferError('Session is disconnected', 404)
        }
        const startSeq = session.lastSeq
        const startAt = Date.now()
        session.write(command.endsWith('\n') || command.endsWith('\r') ? command : command + '\n')
        // 慢输出间隙会进 IDLE；exec 必须等到 prompt（WAITING_INPUT）或断开
        const { state, timedOut } = await session.waitForStable(timeoutMs, { acceptIdle: false })
        const { text } = this.history(session.id, startSeq, 10_000)
        return {
          state,
          output: text,
          durationMs: Date.now() - startAt,
          timedOut,
        }
      },
      'This session is performing another operation; try again later',
      'exec',
    )
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

  /**
   * 彻底删除会话记录（含历史输出）。
   * 若仍在活跃则先关闭。供 Web 端在携带有效 token 时调用。
   */
  remove(sessionId: string): boolean {
    const live = this.sessions.get(sessionId)
    if (live) {
      live.close('Deleted from the Web UI')
    }
    const row = db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get()
    if (!row && !live) return false
    db.delete(schema.historyChunks).where(eq(schema.historyChunks.sessionId, sessionId)).run()
    db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run()
    this.fileTransfer.clearSession(sessionId)
    this.remoteEdit.clearSession(sessionId)
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
