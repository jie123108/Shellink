import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /**
   * Optional business unique key for upsert matching (e.g. host/IP locally, or an
   * external Guid from iTerm2). Distinct from the internal UUID primary key.
   */
  uniqueId: text('unique_id'),
  /** Connection type: ssh is a direct ssh2 connection; command runs a server-side command. */
  connectType: text('connect_type', { enum: ['ssh', 'command'] }).notNull().default('ssh'),
  /** Original command for command profiles. */
  command: text('command'),
  /** Empty string for command profiles. */
  host: text('host').notNull(),
  port: integer('port').notNull().default(22),
  username: text('username').notNull(),
  authType: text('auth_type', { enum: ['password', 'key'] }).notNull().default('password'),
  /** AES-GCM encrypted password. */
  encryptedPassword: text('encrypted_password'),
  /** AES-GCM encrypted private key. */
  encryptedPrivateKey: text('encrypted_private_key'),
  /** AES-GCM encrypted private-key passphrase. */
  encryptedPassphrase: text('encrypted_passphrase'),
  term: text('term').notNull().default('xterm-256color'),
  cols: integer('cols').notNull().default(160),
  rows: integer('rows').notNull().default(42),
  /** Optional custom shell prompt regex overriding the built-in rule. */
  promptRegex: text('prompt_regex'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  profileName: text('profile_name').notNull(),
  target: text('target').notNull(),
  state: text('state', {
    enum: ['CONNECTING', 'OUTPUTTING', 'IDLE', 'WAITING_INPUT', 'DISCONNECTED'],
  }).notNull(),
  mode: text('mode', { enum: ['AUTO', 'MANUAL'] }).notNull().default('AUTO'),
  cols: integer('cols').notNull(),
  rows: integer('rows').notNull(),
  createdAt: integer('created_at').notNull(),
  closedAt: integer('closed_at'),
  closeReason: text('close_reason'),
  exitCode: integer('exit_code'),
})

export const historyChunks = sqliteTable('history_chunks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  /** Monotonically increasing sequence number used as an incremental-read cursor. */
  seq: integer('seq').notNull(),
  /** Direction: output is terminal output; input is data written to the terminal. */
  direction: text('direction', { enum: ['output', 'input'] }).notNull(),
  /** Raw data including ANSI sequences for Web replay. */
  dataRaw: text('data_raw').notNull(),
  /** ANSI-stripped plain text for AI consumption. */
  dataPlain: text('data_plain').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const webhooks = sqliteTable('webhooks', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  /** JSON event-type array; an empty array means all events. */
  events: text('events', { mode: 'json' }).$type<string[]>().notNull().default([]),
  createdAt: integer('created_at').notNull(),
})

export type ProfileRow = typeof profiles.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type HistoryChunkRow = typeof historyChunks.$inferSelect
export type WebhookRow = typeof webhooks.$inferSelect
