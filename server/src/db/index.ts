import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import * as schema from './schema.js'

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })

const runningOnBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
let sqlite: any
let db: any

if (runningOnBun) {
  const { Database } = await import('bun:sqlite')
  const { drizzle } = await import('drizzle-orm/bun-sqlite')
  sqlite = new Database(config.dbPath)
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA synchronous = NORMAL')
  db = drizzle(sqlite, { schema })
} else {
  const { default: Database } = await import('better-sqlite3')
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  sqlite = new Database(config.dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  db = drizzle(sqlite, { schema })
}

function tableHasColumn(table: string, column: string): boolean {
  const sql = `PRAGMA table_info(${table})`
  const rows = (runningOnBun
    ? sqlite.query(sql).all()
    : sqlite.prepare(sql).all()) as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

sqlite.exec(`
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unique_id TEXT,
  connect_type TEXT NOT NULL DEFAULT 'ssh',
  command TEXT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'password',
  encrypted_password TEXT,
  encrypted_private_key TEXT,
  encrypted_passphrase TEXT,
  term TEXT NOT NULL DEFAULT 'xterm-256color',
  cols INTEGER NOT NULL DEFAULT 160,
  rows INTEGER NOT NULL DEFAULT 42,
  prompt_regex TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_unique_id ON profiles(unique_id) WHERE unique_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  target TEXT NOT NULL,
  state TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'AUTO',
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  close_reason TEXT,
  exit_code INTEGER
);

CREATE TABLE IF NOT EXISTS history_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  direction TEXT NOT NULL,
  data_raw TEXT NOT NULL,
  data_plain TEXT NOT NULL,
  internal INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_session_seq ON history_chunks(session_id, seq);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
`)

// Idempotent upgrade for databases created before the internal column existed.
if (!tableHasColumn('history_chunks', 'internal')) {
  sqlite.exec('ALTER TABLE history_chunks ADD COLUMN internal INTEGER NOT NULL DEFAULT 0')
}

export { db, schema }

export function closeDatabase(): void {
  try { sqlite.close() } catch { /* already closed */ }
}
