import type { FastifyInstance } from 'fastify'
import { webAssets } from '../generated/webAssets.js'

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
}

export function registerWebUiRoutes(app: FastifyInstance): void {
  app.get('/ui', async (_req, reply) => reply.redirect('/shellink/ui/'))
  app.get('/ui/', async (_req, reply) => sendAsset(reply, '/index.html'))
  app.get('/ui/assets/*', async (req, reply) => {
    return sendAsset(reply, assetPathname(req.url))
  })
  app.get('/ui/*', async (req, reply) => {
    const pathname = assetPathname(req.url)
    return sendAsset(reply, webAssets[pathname] ? pathname : '/index.html')
  })
}

function assetPathname(url: string): string {
  const pathname = new URL(url, 'http://shellink').pathname
  return pathname.slice('/shellink/ui'.length)
}

function sendAsset(reply: { code: (status: number) => any; type: (value: string) => any; header: (name: string, value: string) => any; send: (value: Buffer) => any }, pathname: string) {
  const encoded = webAssets[pathname]
  if (!encoded) return reply.code(404).send(Buffer.from('Not Found'))
  const ext = pathname.slice(pathname.lastIndexOf('.')).toLowerCase()
  const cacheControl = pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  return reply.type(contentTypes[ext] ?? 'application/octet-stream').header('Cache-Control', cacheControl).send(Buffer.from(encoded, 'base64'))
}
