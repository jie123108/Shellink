import type { FastifyInstance } from 'fastify'
import { sensitiveOpsRequireToken } from './auth.js'

export function registerAuthRoutes(app: FastifyInstance): void {
  /** Public: whether the caller must set a token for sensitive ops (delete/purge). */
  app.get('/api/auth/sensitive-ops', async (req) => ({
    requireToken: sensitiveOpsRequireToken(req),
  }))
}
