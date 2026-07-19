import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function parseMasterKey(hex: string | undefined): Buffer {
  if (!hex) {
    console.warn('[Shellink] Warning: SHELLINK_MASTER_KEY is not set. Credentials will use an insecure default key. Set a 32-byte hex master key in production.')
    return crypto.createHash('sha256').update('shellink-insecure-default-key').digest()
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('SHELLINK_MASTER_KEY must be a 32-byte hex string (64 hex characters)')
  return Buffer.from(hex, 'hex')
}

function defaultDataHome(): string {
  if (process.env.SHELLINK_HOME) return path.resolve(process.env.SHELLINK_HOME)
  if (process.env.SHELLINK_DB) return path.dirname(path.resolve(process.env.SHELLINK_DB))
  return path.join(os.homedir(), '.Shellink')
}

function defaultSocketPath(): string {
  if (process.env.SHELLINK_SOCKET) return path.resolve(process.env.SHELLINK_SOCKET)
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  if (process.platform === 'darwin') return path.join(process.env.TMPDIR ?? os.tmpdir(), `shellink-${uid}`, 'shellink.sock')
  if (process.env.XDG_RUNTIME_DIR) return path.join(process.env.XDG_RUNTIME_DIR, 'shellink', 'shellink.sock')
  return path.join('/tmp', `shellink-${uid}`, 'shellink.sock')
}

export function loadMasterKey(home: string, envHex = process.env.SHELLINK_MASTER_KEY): Buffer {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const keyPath = path.join(home, 'master.key')
  const envKey = envHex ? parseMasterKey(envHex) : undefined
  if (fs.existsSync(keyPath)) {
    const stat = fs.statSync(keyPath)
    if ((stat.mode & 0o777) !== 0o600) throw new Error(`${keyPath} permissions must be 0600`)
    const stored = parseMasterKey(fs.readFileSync(keyPath, 'utf8').trim())
    if (envKey && !crypto.timingSafeEqual(stored, envKey)) throw new Error('SHELLINK_MASTER_KEY does not match the existing master.key')
    return stored
  }
  const key = envKey ?? crypto.randomBytes(32)
  fs.writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
  return key
}

/** Parse a tri-state boolean env var: unset → undefined, otherwise true/false. */
export function parseOptionalBool(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined || raw === '') return undefined
  const v = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  throw new Error(`${name} must be a boolean (true/false)`)
}

const dataHome = defaultDataHome()
const socketPath = defaultSocketPath()
const maxFrameBytes = Number(process.env.SHELLINK_MAX_FRAME_BYTES ?? 16 * 1024 * 1024)
const transferMaxBytes = Number(process.env.SHELLINK_TRANSFER_MAX_BYTES ?? 6_291_456)
if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024) throw new Error('SHELLINK_MAX_FRAME_BYTES is invalid')
if (!Number.isSafeInteger(transferMaxBytes) || transferMaxBytes < 0 || transferMaxBytes > maxFrameBytes) throw new Error('The file transfer limit cannot exceed the socket frame limit')

export const config = {
  dataHome,
  socketPath,
  logPath: path.resolve(process.env.SHELLINK_LOG ?? path.join(dataHome, 'shellink.log')),
  pidPath: path.join(dataHome, 'shellink.pid'),
  port: Number(process.env.SHELLINK_PORT ?? 7070),
  host: process.env.SHELLINK_HOST ?? '127.0.0.1',
  httpEnabled: !['0', 'false', 'no'].includes((process.env.SHELLINK_HTTP_ENABLED ?? 'true').toLowerCase()),
  token: process.env.SHELLINK_TOKEN ?? 'change-me',
  /**
   * Force whether sensitive ops (session record delete/purge) require a Bearer token.
   * `undefined` = derive from whether the request is local.
   */
  requireTokenForSensitiveOps: parseOptionalBool(
    process.env.SHELLINK_REQUIRE_TOKEN_FOR_SENSITIVE_OPS,
    'SHELLINK_REQUIRE_TOKEN_FOR_SENSITIVE_OPS',
  ),
  masterKey: loadMasterKey(dataHome),
  dbPath: path.resolve(process.env.SHELLINK_DB ?? path.join(dataHome, 'shellink.db')),
  maxFrameBytes,
  socketMaxQueueBytes: Number(process.env.SHELLINK_SOCKET_MAX_QUEUE_BYTES ?? 4 * 1024 * 1024),
  silenceThresholdMs: Number(process.env.SHELLINK_SILENCE_MS ?? 800),
  execDefaultTimeoutMs: Number(process.env.SHELLINK_EXEC_TIMEOUT_MS ?? 30_000),
  transferMaxBytes,
  transferTimeoutMs: Number(process.env.SHELLINK_TRANSFER_TIMEOUT_MS ?? 120_000),
  editTimeoutMs: Number(process.env.SHELLINK_EDIT_TIMEOUT_MS ?? 60_000),
  sshReadyTimeoutMs: Number(process.env.SHELLINK_SSH_READY_TIMEOUT_MS ?? 30_000),
}

export function webUiUrl(): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
  return `http://${host}:${config.port}/shellink/ui/`
}
