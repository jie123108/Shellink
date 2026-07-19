import { z } from 'zod'

export const profileCreateSchema = z.object({
  name: z.string().min(1),
  /** Optional business unique key (host/IP or external Guid). Distinct from internal id. */
  uniqueId: z.string().min(1).nullable().optional(),
  connectType: z.enum(['ssh', 'command']).default('ssh'),
  command: z.string().nullable().optional(),
  host: z.string().default(''),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().default(''),
  authType: z.enum(['password', 'key']).default('password'),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  term: z.string().default('xterm-256color'),
  cols: z.number().int().min(20).max(500).default(160),
  rows: z.number().int().min(5).max(200).default(42),
  promptRegex: z.string().nullable().optional(),
})

export const profileUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  /** Set a business unique key, or null to clear it. */
  uniqueId: z.string().min(1).nullable().optional(),
  connectType: z.enum(['ssh', 'command']).optional(),
  command: z.string().nullable().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().optional(),
  authType: z.enum(['password', 'key']).optional(),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  term: z.string().optional(),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(200).optional(),
  promptRegex: z.string().nullable().optional(),
})
export const sessionCreateSchema = z.object({
  profileId: z.string().min(1),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(200).optional(),
})
export const sessionHistorySchema = z.object({
  id: z.string().min(1),
  since: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(10_000).default(2000),
})
export const sessionInputSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  appendNewline: z.boolean().default(true),
  manual: z.boolean().default(false),
})
export const sessionExecSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
})
export const sessionModeSchema = z.object({ id: z.string().min(1), mode: z.enum(['AUTO', 'MANUAL']) })
export const sessionResizeSchema = z.object({
  id: z.string().min(1),
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
})
export const idSchema = z.object({ id: z.string().min(1) })
/** Bulk purge scopes for closed session records (active sessions are never deleted). */
export const sessionRecordsPurgeSchema = z.object({
  olderThan: z.enum(['24h', '7d', 'all']),
})
export const webhookCreateSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(['state', 'closed', 'loginExternal'])).default([]),
})

export type ProfileCreateInput = z.input<typeof profileCreateSchema>
export type ProfileUpdateInput = z.input<typeof profileUpdateSchema>
