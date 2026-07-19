import type { FastifyInstance, FastifyReply } from 'fastify'
import { AppError } from '@shellink/protocol'
import { db, schema } from '../db/index.js'
import { bus } from '../core/events.js'
import { webhookService } from '../services/WebhookService.js'
import { webhookInboxService } from '../services/WebhookInboxService.js'

function dispatch(eventType: string, payload: Record<string, unknown>): void {
  for (const hook of db.select().from(schema.webhooks).all()) {
    if (hook.events.length > 0 && !hook.events.includes(eventType)) continue
    fetch(hook.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: eventType, ...payload, at: Date.now() }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error) => console.warn(`[webhook] Delivery failed for ${hook.url}: ${error instanceof Error ? error.message : String(error)}`))
  }
}

let dispatcherStarted = false
export function startWebhookDispatcher(): void {
  if (dispatcherStarted) return
  dispatcherStarted = true
  bus.on('session.state', (e) => dispatch('state', { sessionId: e.sessionId, state: e.state, prevState: e.prevState }))
  bus.on('session.closed', (e) => dispatch('closed', { sessionId: e.sessionId, reason: e.reason, exitCode: e.exitCode }))
  bus.on('session.loginExternal', (e) => dispatch('loginExternal', { sessionId: e.sessionId, hint: e.hint }))
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AppError) return reply.code(error.status).send({ error: error.message, details: error.details })
  throw error
}

export function registerWebhookRoutes(app: FastifyInstance): void {
  app.post('/webhook/callback', async (req, reply) => {
    const message = webhookInboxService.receive(req.body)
    bus.emit('webhook.received', message)
    return reply.code(202).send({ ok: true, id: message.id })
  })

  app.get('/api/webhooks', async () => webhookService.list())
  app.post('/api/webhooks', async (req, reply) => {
    try { return reply.code(201).send(webhookService.create(req.body)) } catch (error) { return sendError(reply, error) }
  })
  app.delete('/api/webhooks/:id', async (req, reply) => {
    webhookService.delete((req.params as { id: string }).id)
    return reply.code(204).send()
  })
  app.get('/api/webhook-messages', async () => webhookInboxService.list())
  app.delete('/api/webhook-messages', async (_req, reply) => {
    webhookInboxService.clear()
    return reply.code(204).send()
  })
}
