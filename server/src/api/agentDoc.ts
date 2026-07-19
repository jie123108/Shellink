import { AGENT_DOC } from '@shellink/protocol'
import type { FastifyInstance } from 'fastify'

const HTTP_COMPATIBILITY = `## HTTP compatibility

Existing REST and WebSocket clients remain supported under \`/shellink/api/*\` and \`/shellink/ws/*\`. HTTP defaults to 127.0.0.1 and must be explicitly configured for LAN access. New local Agent integrations should use the CLI.

Profile compatibility mappings: \`POST /shellink/api/profiles\` creates a Profile and \`PUT /shellink/api/profiles/{id}\` updates one. Session, file transfer, webhook, and WebSocket paths retain their existing request and response formats.
`

function buildDoc(): string {
  return `${AGENT_DOC.trimEnd()}\n\n${HTTP_COMPATIBILITY}`
}

export function registerAgentDocRoutes(app: FastifyInstance): void {
  const handler = async (_request: unknown, reply: { type: (value: string) => { send: (value: string) => unknown } }) => reply.type('text/markdown; charset=utf-8').send(buildDoc())
  app.get('/agent.md', handler)
  app.get('/llms.txt', handler)
}
