import { eq } from 'drizzle-orm'
import { AppError, RpcErrorCode, sessionCreateSchema, sessionDownloadStartSchema, sessionEditStartSchema, sessionExecCancelSchema, sessionExecSchema, sessionExecStartSchema, sessionExecStatusSchema, sessionHistorySchema, sessionInputSchema, sessionModeSchema, sessionRecordsPurgeSchema, sessionUploadStartSchema } from '@shellink/protocol'
import { config } from '../config.js'
import { collapseBase64Payloads } from '../core/collapseBase64.js'
import { sessionManager } from '../core/SessionManager.js'
import { db, schema } from '../db/index.js'
import { asAppError } from './errors.js'

export class SessionService {
  list() { return sessionManager.list() }

  create(input: unknown) {
    const parsed = sessionCreateSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    const profile = db.select().from(schema.profiles).where(eq(schema.profiles.id, parsed.data.profileId)).get()
    if (!profile) throw new AppError(RpcErrorCode.NOT_FOUND, 'Profile not found', 404)
    const session = sessionManager.create(profile, parsed.data)
    return { id: session.id, state: session.state, mode: session.mode, target: profile.connectType === 'command' ? (profile.command ?? '') : `${profile.username}@${profile.host}:${profile.port}` }
  }

  state(id: string) {
    const live = sessionManager.get(id)
    if (live) return { id, state: live.state, mode: live.mode, lastSeq: live.lastSeq, recentOutput: live.recentOutput(), active: true }
    const row = db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get()
    if (!row) throw new AppError(RpcErrorCode.NOT_FOUND, 'Session not found', 404)
    return { id, state: 'DISCONNECTED', mode: row.mode, closeReason: row.closeReason, exitCode: row.exitCode, active: false }
  }

  history(input: unknown) {
    const parsed = sessionHistorySchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    this.assertRecord(parsed.data.id)
    const result = sessionManager.history(parsed.data.id, parsed.data.since, parsed.data.limit)
    return { cursor: result.cursor, text: collapseBase64Payloads(result.text) }
  }

  rawHistory(id: string) { this.assertRecord(id); return sessionManager.rawHistory(id) }

  input(input: unknown) {
    const parsed = sessionInputSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    const session = this.live(parsed.data.id)
    try {
      if (parsed.data.manual) {
        if (session.mode !== 'MANUAL') throw new AppError(RpcErrorCode.CONFLICT, 'Session is not in MANUAL mode', 409)
        session.write(parsed.data.text)
        return { ok: true, state: session.state, lastSeq: session.lastSeq }
      }
      sessionManager.writeInput(session, parsed.data.text, parsed.data.appendNewline)
      return { ok: true, state: session.state, lastSeq: session.lastSeq }
    } catch (error) { throw asAppError(error) }
  }

  async exec(input: unknown) {
    const parsed = sessionExecSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    try { return await sessionManager.exec(this.live(parsed.data.id), parsed.data.command, parsed.data.timeoutMs ?? config.execDefaultTimeoutMs) }
    catch (error) { throw asAppError(error) }
  }

  execStart(input: unknown) {
    const parsed = sessionExecStartSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    try { return sessionManager.execStart(this.live(parsed.data.id), parsed.data.command, parsed.data.timeoutMs ?? config.execDefaultTimeoutMs) }
    catch (error) { throw asAppError(error) }
  }

  async execStatus(input: unknown) {
    const parsed = sessionExecStatusSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    try { return await sessionManager.execStatus(parsed.data.jobId, parsed.data.since, parsed.data.waitMs) }
    catch (error) { throw asAppError(error) }
  }

  async execCancel(input: unknown) {
    const parsed = sessionExecCancelSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    try { return await sessionManager.execCancel(parsed.data.jobId) }
    catch (error) { throw asAppError(error) }
  }

  uploadStart(input: unknown) {
    const parsed = sessionUploadStartSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    if (Buffer.from(parsed.data.data).length > config.transferMaxBytes) throw new AppError(RpcErrorCode.PAYLOAD_TOO_LARGE, `File is too large (${Buffer.from(parsed.data.data).length} bytes); limit is ${config.transferMaxBytes} bytes`, 413)
    try { return sessionManager.uploadStart(this.live(parsed.data.id), parsed.data.path, Buffer.from(parsed.data.data), { timeoutMs: parsed.data.timeoutMs, expectedSha256: parsed.data.sha256 }) }
    catch (error) { throw asAppError(error) }
  }

  downloadStart(input: unknown) {
    const parsed = sessionDownloadStartSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    try { return sessionManager.downloadStart(this.live(parsed.data.id), parsed.data.path, parsed.data.output, parsed.data.timeoutMs ?? config.transferTimeoutMs) }
    catch (error) { throw asAppError(error) }
  }

  editStart(input: unknown) {
    const parsed = sessionEditStartSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    try { return sessionManager.editStart(this.live(parsed.data.id), parsed.data.path, parsed.data.edits, parsed.data.timeoutMs ?? config.editTimeoutMs) }
    catch (error) { throw asAppError(error) }
  }

  async download(id: string, remotePath: string, timeoutMs = config.transferTimeoutMs) {
    try { return await sessionManager.download(this.live(id), remotePath, timeoutMs) }
    catch (error) { throw asAppError(error, 'Download failed') }
  }

  async upload(id: string, remotePath: string, data: Buffer, opts: { timeoutMs?: number; expectedSha256?: string } = {}) {
    if (data.length > config.transferMaxBytes) throw new AppError(RpcErrorCode.PAYLOAD_TOO_LARGE, `File is too large (${data.length} bytes); limit is ${config.transferMaxBytes} bytes`, 413)
    try { return await sessionManager.upload(this.live(id), remotePath, data, opts) }
    catch (error) { throw asAppError(error, 'Upload failed') }
  }

  async edit(id: string, remotePath: string, edits: Array<{ oldText: string; newText: string }>, timeoutMs = config.editTimeoutMs) {
    try { return await sessionManager.edit(this.live(id), remotePath, edits, timeoutMs) }
    catch (error) { throw asAppError(error, 'Edit failed') }
  }

  mode(input: unknown) {
    const parsed = sessionModeSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    const session = this.live(parsed.data.id)
    session.setMode(parsed.data.mode)
    return { ok: true, mode: session.mode }
  }

  terminalInput(id: string, data: string): void {
    const session = this.live(id)
    const allowed = session.mode === 'MANUAL' || session.state === 'CONNECTING' || (session.mode === 'AUTO' && session.state === 'WAITING_INPUT')
    if (!allowed) throw new AppError(RpcErrorCode.CONFLICT, 'The current session state does not accept input', 409)
    if (session.mode === 'MANUAL' || session.state === 'CONNECTING') session.write(data)
    else sessionManager.writeInput(session, data, false)
  }

  resize(id: string, cols: number, rows: number): void {
    this.live(id).resize(cols, rows)
  }

  close(id: string) {
    const session = sessionManager.get(id)
    if (session) { session.close('Close requested'); return { ok: true } }
    this.assertRecord(id)
    return { ok: true, note: 'Session is already disconnected' }
  }

  removeRecord(id: string) {
    if (!sessionManager.remove(id)) throw new AppError(RpcErrorCode.NOT_FOUND, 'Session not found', 404)
    return { ok: true }
  }

  removeClosedRecords(input: unknown) {
    const parsed = sessionRecordsPurgeSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    const deleted = sessionManager.removeClosedRecords(parsed.data.olderThan)
    return { ok: true, deleted }
  }

  private live(id: string) {
    const session = sessionManager.get(id)
    if (!session) throw new AppError(RpcErrorCode.NOT_FOUND, 'Session not found or disconnected', 404)
    return session
  }

  private assertRecord(id: string): void {
    if (!db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.id, id)).get()) {
      throw new AppError(RpcErrorCode.NOT_FOUND, 'Session not found', 404)
    }
  }
}

export const sessionService = new SessionService()
