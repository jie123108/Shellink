import type { FastifyRequest, FastifyReply } from 'fastify'
import type { IncomingMessage } from 'node:http'
import { config } from '../config.js'

/** Determine whether an address is a local loopback address. */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false
  // IPv4-mapped IPv6, for example ::ffff:127.0.0.1.
  const a = addr.replace(/^::ffff:/i, '').toLowerCase()
  return a === '127.0.0.1' || a === '::1'
}

/** Determine whether a Host header names the local machine, optionally with a port. */
export function isLocalHostHeader(host: string | undefined | null): boolean {
  if (!host) return false
  // Remove the port; IPv6 literals have the form [::1]:7070.
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    hostname = end >= 0 ? hostname.slice(1, end) : hostname
  } else {
    hostname = hostname.split(':')[0] ?? hostname
  }
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

/**
 * Whether a request qualifies as local and can bypass the token.
 * Both the TCP peer and Host header must identify the local machine.
 *
 * Nginx / reverse-proxy note: the backend typically sees peer `127.0.0.1` while
 * `Host` is the public name (e.g. `shellink.example.com`). That is NOT local —
 * sensitive ops still require a token. `X-Forwarded-For` / `X-Real-IP` are ignored
 * so clients cannot spoof locality through the proxy.
 */
export function isLocalRequest(req: FastifyRequest | IncomingMessage): boolean {
  const remote =
    'ip' in req && typeof req.ip === 'string' ? req.ip : req.socket?.remoteAddress
  if (!isLoopbackAddress(remote)) return false
  const host = req.headers.host
  return isLocalHostHeader(host)
}

export function checkToken(token: string | undefined): boolean {
  return !!token && token === config.token
}

/** Extract a Bearer token from request headers. */
export function extractBearerToken(req: FastifyRequest | IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  return header.startsWith('Bearer ') ? header.slice(7) : undefined
}

/**
 * Authentication: local requests can omit a token; remote requests require a valid Bearer token.
 */
export async function authGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isLocalRequest(req)) return
  if (!checkToken(extractBearerToken(req))) {
    reply.code(401).send({ error: 'Unauthorized: invalid Bearer token' })
  }
}

/**
 * Whether sensitive operations (session record delete/purge) need a Bearer token.
 * Default: local requests skip; remote requests require a token.
 * Override with `SHELLINK_REQUIRE_TOKEN_FOR_SENSITIVE_OPS`.
 */
export function resolveSensitiveOpsRequireToken(
  isLocal: boolean,
  force: boolean | undefined = config.requireTokenForSensitiveOps,
): boolean {
  if (force !== undefined) return force
  return !isLocal
}

export function sensitiveOpsRequireToken(req: FastifyRequest | IncomingMessage): boolean {
  return resolveSensitiveOpsRequireToken(isLocalRequest(req))
}

/**
 * Require a valid Bearer token for sensitive operations when the policy says so.
 * Local requests skip by default (unless forced via env).
 */
export async function requireToken(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (!sensitiveOpsRequireToken(req)) return true
  if (checkToken(extractBearerToken(req))) return true
  reply.code(401).send({ error: 'Unauthorized: deleting a session record requires a valid Bearer token' })
  return false
}
