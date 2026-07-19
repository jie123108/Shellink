import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SocketClient } from './SocketClient.js'
import { shellinkPaths } from './paths.js'
import { resolveCliLocale, t } from './i18n.js'

function selfCommand(): { command: string; args: string[] } {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    return { command: process.execPath, args: ['server', 'run'] }
  }
  return { command: process.execPath, args: [fileURLToPath(import.meta.url), 'server', 'run'] }
}

export async function connectDaemon(): Promise<SocketClient | null> {
  const client = new SocketClient(shellinkPaths().socketPath, 1000)
  try { await client.connect(); return client } catch { client.close(); return null }
}

export async function ensureDaemon(timeoutMs = 10_000): Promise<SocketClient> {
  const current = await connectDaemon()
  if (current) return current
  startDetached()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const client = await connectDaemon()
    if (client) return client
  }
  const tail = readLogTail()
  const locale = resolveCliLocale()
  throw new Error(`${t(locale, 'daemonStartTimeout')}${tail ? `\n${t(locale, 'logTail')}\n${tail}` : ''}`)
}

export function startDetached(): number {
  const paths = shellinkPaths()
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  const fd = fs.openSync(paths.logPath, 'a', 0o600)
  const { command, args } = selfCommand()
  const child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd], env: process.env })
  child.unref(); fs.closeSync(fd)
  return child.pid ?? 0
}

export async function runForeground(): Promise<number> {
  const { runServer } = await import('@shellink/server/runner')
  return await runServer()
}

export function readLogTail(lines = 40): string {
  try { return fs.readFileSync(shellinkPaths().logPath, 'utf8').trim().split('\n').slice(-lines).join('\n') } catch { return '' }
}
