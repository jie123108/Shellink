import type { FastifyInstance, FastifyReply } from 'fastify'
import { AppError } from '@shellink/protocol'
import { profileService } from '../services/ProfileService.js'

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AppError) return reply.code(error.status).send({ error: error.message, details: error.details })
  throw error
}

export function registerProfileRoutes(app: FastifyInstance): void {
  app.get('/api/profiles', async (req) => profileService.list(req.query))
  app.get('/api/profiles/:id', async (req, reply) => {
    try { return profileService.get((req.params as { id: string }).id) } catch (error) { return sendError(reply, error) }
  })
  app.post('/api/profiles', async (req, reply) => {
    try { return reply.code(201).send(profileService.create(req.body)) } catch (error) { return sendError(reply, error) }
  })
  app.put('/api/profiles/:id', async (req, reply) => {
    try { return profileService.update((req.params as { id: string }).id, req.body) } catch (error) { return sendError(reply, error) }
  })
  app.delete('/api/profiles/:id', async (req, reply) => {
    profileService.delete((req.params as { id: string }).id)
    return reply.code(204).send()
  })
}
