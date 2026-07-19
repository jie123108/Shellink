import crypto from 'node:crypto'
import { and, eq, ne } from 'drizzle-orm'
import { AppError, RpcErrorCode, profileCreateSchema, profileUpdateSchema } from '@shellink/protocol'
import { db, schema } from '../db/index.js'
import { encryptSecret } from '../db/crypto.js'
import type { ProfileRow } from '../db/schema.js'

function validateTarget(profile: { connectType: 'ssh' | 'command'; command?: string | null; host: string; username: string }): void {
  if (profile.connectType === 'command' && !profile.command?.trim()) {
    throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Command profiles require a command', 400)
  }
  if (profile.connectType === 'ssh' && (!profile.host || !profile.username)) {
    throw new AppError(RpcErrorCode.INVALID_REQUEST, !profile.host ? 'SSH profiles require a host' : 'SSH profiles require a username', 400)
  }
}

function targetOf(row: ProfileRow): string {
  return row.connectType === 'command' ? (row.command ?? '') : `${row.username}@${row.host}:${row.port}`
}

/** Normalize optional uniqueId: trim, treat empty as null. */
function normalizeUniqueId(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function assertUniqueIdAvailable(uniqueId: string | null | undefined, excludeId?: string): void {
  if (!uniqueId) return
  const conflict = excludeId
    ? db.select().from(schema.profiles).where(and(eq(schema.profiles.uniqueId, uniqueId), ne(schema.profiles.id, excludeId))).get()
    : db.select().from(schema.profiles).where(eq(schema.profiles.uniqueId, uniqueId)).get()
  if (conflict) {
    throw new AppError(RpcErrorCode.CONFLICT, `Profile uniqueId already in use: ${uniqueId}`, 409)
  }
}

export function publicProfile(row: ProfileRow) {
  return {
    id: row.id, name: row.name, uniqueId: row.uniqueId ?? null, connectType: row.connectType, command: row.command,
    host: row.host, port: row.port, username: row.username, authType: row.authType,
    hasPassword: !!row.encryptedPassword, hasPrivateKey: !!row.encryptedPrivateKey,
    hasPassphrase: !!row.encryptedPassphrase, term: row.term, cols: row.cols, rows: row.rows,
    promptRegex: row.promptRegex, createdAt: row.createdAt, updatedAt: row.updatedAt,
  }
}

export class ProfileService {
  list(params: unknown = {}) {
    const q = typeof params === 'object' && params !== null && 'q' in params && typeof params.q === 'string' ? params.q.trim().toLowerCase() : ''
    let rows = db.select().from(schema.profiles).all() as ProfileRow[]
    if (q) {
      rows = rows.filter((row) =>
        row.name.toLowerCase().includes(q)
        || targetOf(row).toLowerCase().includes(q)
        || (row.uniqueId?.toLowerCase().includes(q) ?? false),
      )
    }
    return rows.map(publicProfile)
  }

  get(id: string) {
    const row = db.select().from(schema.profiles).where(eq(schema.profiles.id, id)).get()
    if (!row) throw new AppError(RpcErrorCode.NOT_FOUND, 'Profile not found', 404)
    return publicProfile(row)
  }

  create(input: unknown) {
    const parsed = profileCreateSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    const body = parsed.data
    validateTarget(body)
    const uniqueId = normalizeUniqueId(body.uniqueId) ?? null
    assertUniqueIdAvailable(uniqueId)
    const id = crypto.randomUUID()
    const now = Date.now()
    db.insert(schema.profiles).values({
      id, name: body.name, uniqueId, connectType: body.connectType, command: body.command ?? null,
      host: body.host, port: body.port, username: body.username, authType: body.authType,
      encryptedPassword: body.password ? encryptSecret(body.password) : null,
      encryptedPrivateKey: body.privateKey ? encryptSecret(body.privateKey) : null,
      encryptedPassphrase: body.passphrase ? encryptSecret(body.passphrase) : null,
      term: body.term, cols: body.cols, rows: body.rows, promptRegex: body.promptRegex ?? null,
      createdAt: now, updatedAt: now,
    }).run()
    return this.get(id)
  }

  update(id: string, input: unknown) {
    const existing = db.select().from(schema.profiles).where(eq(schema.profiles.id, id)).get()
    if (!existing) throw new AppError(RpcErrorCode.NOT_FOUND, 'Profile not found', 404)
    const parsed = profileUpdateSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    const body = parsed.data
    const merged = {
      connectType: body.connectType ?? existing.connectType,
      command: body.command !== undefined ? body.command : existing.command,
      host: body.host ?? existing.host,
      username: body.username ?? existing.username,
    }
    validateTarget(merged)
    const uniqueId = body.uniqueId !== undefined
      ? (normalizeUniqueId(body.uniqueId) ?? null)
      : existing.uniqueId
    if (body.uniqueId !== undefined) assertUniqueIdAvailable(uniqueId, id)
    db.update(schema.profiles).set({
      name: body.name ?? existing.name, uniqueId: uniqueId ?? null,
      connectType: merged.connectType, command: merged.command,
      host: merged.host, port: body.port ?? existing.port, username: merged.username,
      authType: body.authType ?? existing.authType,
      encryptedPassword: body.password !== undefined ? (body.password ? encryptSecret(body.password) : null) : existing.encryptedPassword,
      encryptedPrivateKey: body.privateKey !== undefined ? (body.privateKey ? encryptSecret(body.privateKey) : null) : existing.encryptedPrivateKey,
      encryptedPassphrase: body.passphrase !== undefined ? (body.passphrase ? encryptSecret(body.passphrase) : null) : existing.encryptedPassphrase,
      term: body.term ?? existing.term, cols: body.cols ?? existing.cols, rows: body.rows ?? existing.rows,
      promptRegex: body.promptRegex !== undefined ? body.promptRegex : existing.promptRegex,
      updatedAt: Date.now(),
    }).where(eq(schema.profiles.id, id)).run()
    return this.get(id)
  }

  delete(id: string): void {
    db.delete(schema.profiles).where(eq(schema.profiles.id, id)).run()
  }
}

export const profileService = new ProfileService()
