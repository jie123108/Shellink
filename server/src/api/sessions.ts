import type { FastifyInstance, FastifyReply } from 'fastify'
import { AppError, RpcErrorCode } from '@shellink/protocol'
import { config } from '../config.js'
import { sessionManager } from '../core/SessionManager.js'
import { sessionService } from '../services/SessionService.js'
import { requireToken } from './auth.js'

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AppError) return reply.code(error.status).send({ error: error.message, details: error.details })
  throw error
}

function timeout(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1000 || value > 600_000) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'timeoutMs must be between 1000 and 600000', 400)
  return value
}

export function registerSessionRoutes(app: FastifyInstance): void {
  app.get('/api/sessions', async () => sessionService.list())
  app.post('/api/sessions', async (req, reply) => {
    try { return reply.code(201).send(sessionService.create(req.body)) } catch (error) { return sendError(reply, error) }
  })
  app.get('/api/sessions/:id/state', async (req, reply) => {
    try { return sessionService.state((req.params as { id: string }).id) } catch (error) { return sendError(reply, error) }
  })
  app.get('/api/sessions/:id/history', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const query = req.query as { since?: string; limit?: string }
    try {
      const since = query.since ? Number(query.since) : 0
      const limit = query.limit ? Number(query.limit) : 2000
      return sessionService.history({ id, since, limit })
    } catch (error) { return sendError(reply, error) }
  })
  app.post('/api/sessions/:id/input', async (req, reply) => {
    try { return sessionService.input({ id: (req.params as { id: string }).id, ...(req.body as object) }) } catch (error) { return sendError(reply, error) }
  })
  app.post('/api/sessions/:id/exec', async (req, reply) => {
    try { return await sessionService.exec({ id: (req.params as { id: string }).id, ...(req.body as object) }) } catch (error) { return sendError(reply, error) }
  })
  app.get('/api/sessions/:id/download', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const query = req.query as { path?: string; timeoutMs?: string }
    if (!query.path?.trim()) return reply.code(400).send({ error: 'Missing query parameter: path' })
    try {
      const result = await sessionService.download(id, query.path, timeout(query.timeoutMs, config.transferTimeoutMs))
      const filename = sessionManager.fileTransfer.basenameForDisposition(result.remotePath)
      return reply.header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Content-Length', String(result.size)).header('X-Shellink-Path', encodeURIComponent(result.remotePath))
        .header('X-Shellink-Size', String(result.size)).header('X-Shellink-SHA256', result.sha256)
        .header('X-Shellink-Codec', result.codec).header('X-Shellink-Duration-Ms', String(result.durationMs)).send(result.data)
    } catch (error) { return sendError(reply, error) }
  })
  app.post('/api/sessions/:id/upload', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const query = req.query as { path?: string; timeoutMs?: string; sha256?: string }
    if (!query.path?.trim()) return reply.code(400).send({ error: 'Missing query parameter: path' })
    try {
      const file = await req.file()
      if (!file) return reply.code(400).send({ error: 'Missing multipart field: file' })
      const result = await sessionService.upload(id, query.path, await file.toBuffer(), { timeoutMs: timeout(query.timeoutMs, config.transferTimeoutMs), expectedSha256: query.sha256?.trim() || undefined })
      return { ok: true, ...result }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (/file size|Request file too large|FST_REQ_FILE_TOO_LARGE/i.test(message)) return reply.code(413).send({ error: `File is too large; limit is ${config.transferMaxBytes} bytes` })
      return sendError(reply, error)
    }
  })
  app.post('/api/sessions/:id/edit', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const body = req.body as { path?: string; edits?: Array<{ oldText: string; newText: string }>; timeoutMs?: number }
    if (!body.path || !Array.isArray(body.edits) || body.edits.length === 0) return reply.code(400).send({ error: 'Invalid parameters' })
    try { return await sessionService.edit(id, body.path, body.edits, body.timeoutMs) } catch (error) { return sendError(reply, error) }
  })
  app.post('/api/sessions/:id/mode', async (req, reply) => {
    try { return sessionService.mode({ id: (req.params as { id: string }).id, ...(req.body as object) }) } catch (error) { return sendError(reply, error) }
  })
  // Static path before /:id so "records" is not captured as a session id.
  app.delete('/api/sessions/records', async (req, reply) => {
    if (!(await requireToken(req, reply))) return
    const olderThan = (req.query as { olderThan?: string }).olderThan
    try { return sessionService.removeClosedRecords({ olderThan }) } catch (error) { return sendError(reply, error) }
  })
  app.delete('/api/sessions/:id', async (req, reply) => {
    try { return sessionService.close((req.params as { id: string }).id) } catch (error) { return sendError(reply, error) }
  })
  app.delete('/api/sessions/:id/record', async (req, reply) => {
    if (!(await requireToken(req, reply))) return
    try { return sessionService.removeRecord((req.params as { id: string }).id) } catch (error) { return sendError(reply, error) }
  })
}
