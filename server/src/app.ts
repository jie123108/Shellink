import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { config } from './config.js'
import { authGuard } from './api/auth.js'
import { registerAuthRoutes } from './api/authRoutes.js'
import { registerProfileRoutes } from './api/profiles.js'
import { registerSessionRoutes } from './api/sessions.js'
import { registerWebhookRoutes, startWebhookDispatcher } from './api/webhooks.js'
import { registerAgentDocRoutes } from './api/agentDoc.js'
import { registerWebUiRoutes } from './api/webUi.js'
import { sessionManager } from './core/SessionManager.js'

/** Policy probe used by the Web UI before a token is set; must stay unauthenticated. */
const PUBLIC_API_PATHS = new Set(['/shellink/api/auth/sensitive-ops'])

export interface BuildAppOptions {
  /** Fastify logger level; tests typically use `false` */
  logger?: boolean | { level: string }
  /** Skip marking stale sessions (useful in tests) */
  skipMarkStale?: boolean
}

/**
 * Assemble the Fastify app (routes, hooks, webhook dispatcher) without listening.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === undefined ? { level: 'info' } : opts.logger,
  })

  await app.register(cors, { origin: true })
  await app.register(multipart, {
    limits: {
      fileSize: config.transferMaxBytes,
      files: 1,
    },
  })

  app.addHook('onRequest', async (req, reply) => {
    const path = (req.url.split('?')[0] ?? '')
    if (path.startsWith('/shellink/api/') && !PUBLIC_API_PATHS.has(path)) {
      await authGuard(req, reply)
    }
  })

  await app.register(async (shellink) => {
    shellink.get('/healthz', async () => ({ ok: true, name: 'Shellink' }))
    registerAuthRoutes(shellink)
    registerProfileRoutes(shellink)
    registerSessionRoutes(shellink)
    registerWebhookRoutes(shellink)
    registerAgentDocRoutes(shellink)
    registerWebUiRoutes(shellink)
  }, { prefix: '/shellink' })
  startWebhookDispatcher()

  if (!opts.skipMarkStale) {
    sessionManager.markStaleSessions()
  }

  return app
}
