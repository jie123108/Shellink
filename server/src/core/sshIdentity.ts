import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** OpenSSH 默认尝试的私钥文件名（顺序与 ssh 一致） */
const DEFAULT_IDENTITY_NAMES = [
  'id_rsa',
  'id_ecdsa',
  'id_ecdsa_sk',
  'id_ed25519',
  'id_ed25519_sk',
  'id_dsa',
] as const

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2))
  }
  return p
}

/** 读取私钥文件；非私钥或不可读时返回 undefined */
export function readPrivateKeyFile(keyPath: string): string | undefined {
  try {
    const content = fs.readFileSync(expandHome(keyPath), 'utf8')
    return content.includes('PRIVATE KEY') ? content : undefined
  } catch {
    return undefined
  }
}

/** 通过 `ssh -G` 解析该目标实际会用到的 IdentityFile 列表（含 Host * 默认） */
function identityFilesFromSshConfig(host: string, username?: string): string[] {
  try {
    const target = username ? `${username}@${host}` : host
    const stdout = execFileSync('ssh', ['-G', target], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const files: string[] = []
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^identityfile\s+(.+)$/i.exec(line.trim())
      if (m?.[1]) files.push(m[1].trim())
    }
    return files
  } catch {
    return []
  }
}

function defaultIdentityPaths(): string[] {
  const home = path.join(os.homedir(), '.ssh')
  return DEFAULT_IDENTITY_NAMES.map((name) => path.join(home, name))
}

/**
 * 解析可用于 SSH 的私钥内容。
 * 优先级：显式 keyPath → ssh -G IdentityFile → ~/.ssh 默认私钥。
 */
export function resolveSshPrivateKey(opts: {
  host: string
  username?: string
  keyPath?: string
}): { content: string; path: string } | undefined {
  const candidates: string[] = []
  if (opts.keyPath) candidates.push(opts.keyPath)
  candidates.push(...identityFilesFromSshConfig(opts.host, opts.username))
  candidates.push(...defaultIdentityPaths())

  const seen = new Set<string>()
  for (const raw of candidates) {
    const abs = path.resolve(expandHome(raw))
    if (seen.has(abs)) continue
    seen.add(abs)
    const content = readPrivateKeyFile(abs)
    if (content) return { content, path: abs }
  }
  return undefined
}
