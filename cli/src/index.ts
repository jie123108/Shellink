#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGENT_DOC, AGENT_DOC_JSON, AppError, GIT_COMMIT, PROTOCOL_VERSION, RpcErrorCode, VERSION } from '@shellink/protocol'
import { connectDaemon, ensureDaemon, readLogTail, runForeground } from './daemon.js'
import { runTui } from './tui.js'
import { formatHelp } from './help.js'
import { resolveCliLocale, t } from './i18n.js'
import { UpgradeError, formatUpgradeResult, runUpgrade } from './upgrade.js'
import { createProgressReporter } from './progress.js'

const locale = resolveCliLocale()
// `version` is intentionally not boolean so `shellink upgrade --version TAG` works;
// bare `--version` / `-V` still become true when no value follows.
const BOOLEAN_FLAGS = new Set(['json', 'help', 'no-newline', 'yes', 'check', 'detach', 'include-internal'])

type Flags = Record<string, string | boolean>

class UsageError extends Error {}

/** @internal exported for tests */
export function parse(argv: string[]): { words: string[]; flags: Flags } {
  const words: string[] = []
  const flags: Flags = {}
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!
    if (value === '-h') { flags.help = true; continue }
    if (value === '-V') { flags.version = true; continue }
    if (!value.startsWith('--')) { words.push(value); continue }
    const [name, inline] = value.slice(2).split('=', 2)
    if (!name) throw new UsageError(t(locale, 'invalidOption', { value }))
    if (inline !== undefined) flags[name] = inline
    else if (!BOOLEAN_FLAGS.has(name) && argv[index + 1] && !argv[index + 1]!.startsWith('-')) flags[name] = argv[++index]!
    else flags[name] = true
  }
  return { words, flags }
}

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new UsageError(t(locale, 'missing', { label }))
  return value
}

function noExtraWords(words: string[], count: number): void {
  if (words.length > count) throw new UsageError(t(locale, 'extraArguments', { arguments: words.slice(count).join(' ') }))
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function readInput(source: unknown): Promise<any> {
  const name = required(source, '--input')
  try { return JSON.parse(name === '-' ? await readStdin() : fs.readFileSync(name, 'utf8')) }
  catch (error) { throw new UsageError(t(locale, 'readJsonFailed', { message: error instanceof Error ? error.message : String(error) })) }
}

function numberFlag(value: unknown, fallback?: number): number | undefined {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new UsageError(t(locale, 'invalidNumber', { value: String(value) }))
  return parsed
}

/** CLI socket timeout = server timeout + 1s slack. Exported for tests. */
export function socketTimeoutMs(serverTimeoutMs: number): number {
  return serverTimeoutMs + 1000
}

function output(value: unknown, json: boolean): void {
  if (value === undefined) return
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) process.stdout.write(Buffer.from(value))
  else if (json) process.stdout.write(JSON.stringify(value) + '\n')
  else if (typeof value === 'string') process.stdout.write(value + (value.endsWith('\n') ? '' : '\n'))
  else process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

/**
 * Wrap a long-running RPC promise with a heartbeat written to stderr every 2s.
 * Keeps stdout clean (single JSON line) while giving hosts/users a "still progressing" signal.
 * Polls session state concurrently to include `state=<STATE>` in the heartbeat.
 */
async function withHeartbeat<T>(client: import('./SocketClient.js').SocketClient, op: string, sessionId: string | undefined, p: Promise<T>, intervalMs = 2000): Promise<T> {
  const start = Date.now()
  let timer: NodeJS.Timeout | undefined
  const tick = async (): Promise<void> => {
    let state = ''
    if (sessionId) {
      try { const s = await client.request<{ state?: string }>('sessions.state', { id: sessionId }); state = s.state ?? '' } catch { /* session may be mid-op */ }
    }
    const elapsed = Math.round((Date.now() - start) / 1000)
    process.stderr.write(`waiting ${op} ${elapsed}s${state ? ` state=${state}` : ''}\n`)
  }
  void tick()
  timer = setInterval(() => { void tick() }, intervalMs)
  try { return await p } finally { if (timer) clearInterval(timer) }
}

function printHelp(topic = 'root'): void {
  output(formatHelp(topic, locale, VERSION), false)
}

async function runTuiCommand(): Promise<void> {
  const client = await ensureDaemon()
  try { await runTui(client, locale) } finally { client.close() }
}

async function handleServer(action: string | undefined, flags: Flags): Promise<void> {
  const json = flags.json === true
  if (action === 'run') { process.exitCode = await runForeground(); return }
  if (action === 'logs') { output(readLogTail(numberFlag(flags.lines, 40)), false); return }
  if (action === 'restart') {
    const current = await connectDaemon()
    if (current) {
      await current.request('system.stop'); current.close()
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    const restarted = await ensureDaemon()
    try { output(await restarted.request('system.status'), json) } finally { restarted.close() }
    return
  }
  if (action === 'status' || action === 'stop') {
    const current = await connectDaemon()
    if (!current) { output(action === 'status' ? { running: false } : { stopping: false, running: false }, json); return }
    try { output(action === 'status' ? await current.request('system.status') : await current.request('system.stop'), json) } finally { current.close() }
    return
  }
  if (action === 'start') {
    const client = await ensureDaemon()
    try { output(await client.request('system.status'), json) } finally { client.close() }
    return
  }
  throw new UsageError(`shellink server start|status|stop|restart|logs|run (${t(locale, 'usage')})`)
}

async function handleUpgrade(flags: Flags): Promise<void> {
  if (flags.version === true) {
    throw new UsageError(t(locale, 'upgradeVersionRequiresTag'))
  }
  const targetVersion = typeof flags.version === 'string' ? flags.version : undefined
  const progress = createProgressReporter({
    stream: process.stderr,
    isTty: Boolean(process.stderr.isTTY),
    enabled: flags.json !== true,
    locale,
  })
  const result = await runUpgrade({
    checkOnly: flags.check === true,
    targetVersion,
    yes: flags.yes === true,
    locale,
    progress,
  })
  output(flags.json === true ? result : formatUpgradeResult(result), flags.json === true)
}

async function handleRpc(words: string[], flags: Flags): Promise<void> {
  const [group, action, id] = words
  const json = flags.json === true
  const client = await ensureDaemon()
  try {
    if (group === 'profile') {
      if (action === 'list') output(await client.request('profiles.list', { q: flags.query ?? flags.q }), json)
      else if (action === 'get') output(await client.request('profiles.get', { id: required(id, 'profile ID') }), json)
      else if (action === 'create') output(await client.request('profiles.create', await readInput(flags.input)), json)
      else if (action === 'update') output(await client.request('profiles.update', { id: required(id, 'profile ID'), profile: await readInput(flags.input) }), json)
      else if (action === 'delete') output(await client.request('profiles.delete', { id: required(id, 'profile ID') }), json)
      else throw new UsageError(`shellink profile list|get|create|update|delete (${t(locale, 'usage')})`)
      return
    }
    if (group === 'webhook') {
      if (action === 'list') output(await client.request('webhooks.list'), json)
      else if (action === 'create') output(await client.request('webhooks.create', await readInput(flags.input)), json)
      else if (action === 'delete') output(await client.request('webhooks.delete', { id: required(id, 'webhook ID') }), json)
      else throw new UsageError(`shellink webhook list|create|delete (${t(locale, 'usage')})`)
      return
    }
    if (group !== 'session') throw new UsageError(t(locale, 'unknownCommand', { command: group }))
    if (action === 'list') output(await client.request('sessions.list'), json)
    else if (action === 'create') output(await client.request('sessions.create', { profileId: required(flags.profile, '--profile'), cols: numberFlag(flags.cols), rows: numberFlag(flags.rows) }), json)
    else if (action === 'state') output(await client.request('sessions.state', { id: required(id, 'session ID') }), json)
    else if (action === 'history') output(await client.request('sessions.history', { id: required(id, 'session ID'), since: numberFlag(flags.since, 0), limit: numberFlag(flags.limit, 2000), includeInternal: flags['include-internal'] === true }), json)
    else if (action === 'input') output(await client.request('sessions.input', { id: required(id, 'session ID'), text: required(flags.text, '--text'), appendNewline: flags['no-newline'] !== true }), json)
    else if (action === 'exec') {
      if (flags.detach === true) {
        output(await client.request('sessions.execStart', { id: required(id, 'session ID'), command: required(flags.command, '--command'), timeoutMs: numberFlag(flags.timeout) }, socketTimeoutMs(numberFlag(flags.timeout, 20_000)!)), json)
      } else {
        const sid = required(id, 'session ID')
        output(await withHeartbeat(client, 'exec', sid, client.request('sessions.exec', { id: sid, command: required(flags.command, '--command'), timeoutMs: numberFlag(flags.timeout) }, socketTimeoutMs(numberFlag(flags.timeout, 20_000)!))), json)
      }
    }
    else if (action === 'exec-status') output(await client.request('sessions.execStatus', { jobId: required(id, 'job ID'), since: numberFlag(flags.since, 0), waitMs: numberFlag(flags.wait, 0) }, socketTimeoutMs(numberFlag(flags.wait, 0)!)), json)
    else if (action === 'exec-cancel') output(await client.request('sessions.execCancel', { jobId: required(id, 'job ID') }), json)
    else if (action === 'mode') output(await client.request('sessions.mode', { id: required(id, 'session ID'), mode: required(flags.mode, '--mode') }), json)
    else if (action === 'close') output(await client.request('sessions.close', { id: required(id, 'session ID') }), json)
    else if (action === 'remove-record') output(await client.request('sessions.removeRecord', { id: required(id, 'session ID') }), json)
    else if (action === 'download') {
      if (flags.detach === true) {
        const target = path.resolve(required(flags.output, '--output'))
        output(await client.request('sessions.downloadStart', { id: required(id, 'session ID'), path: required(flags.path, '--path'), output: target, timeoutMs: numberFlag(flags.timeout) }, socketTimeoutMs(numberFlag(flags.timeout, 120_000)!)), json)
      } else {
        const sid = required(id, 'session ID')
        const result = await withHeartbeat(client, 'download', sid, client.request<any>('sessions.download', { id: sid, path: required(flags.path, '--path'), timeoutMs: numberFlag(flags.timeout) }, socketTimeoutMs(numberFlag(flags.timeout, 120_000)!)))
        const target = required(flags.output, '--output')
        fs.writeFileSync(target, Buffer.from(result.data))
        output({ ...result, data: undefined, output: target }, json)
      }
    } else if (action === 'upload') {
      const source = required(flags.input, '--input')
      const data = fs.readFileSync(source)
      if (flags.detach === true) {
        output(await client.request('sessions.uploadStart', { id: required(id, 'session ID'), path: required(flags.path, '--path'), data, timeoutMs: numberFlag(flags.timeout), sha256: flags.sha256 }, socketTimeoutMs(numberFlag(flags.timeout, 120_000)!)), json)
      } else {
        const sid = required(id, 'session ID')
        output(await withHeartbeat(client, 'upload', sid, client.request('sessions.upload', { id: sid, path: required(flags.path, '--path'), data, timeoutMs: numberFlag(flags.timeout), sha256: flags.sha256 }, socketTimeoutMs(numberFlag(flags.timeout, 120_000)!))), json)
      }
    } else if (action === 'edit') {
      const body = await readInput(flags.input)
      const editTimeoutMs = numberFlag(flags.timeout, body.timeoutMs) ?? 25_000
      if (flags.detach === true) {
        output(await client.request('sessions.editStart', { id: required(id, 'session ID'), path: required(body.path, 'path'), edits: body.edits, timeoutMs: numberFlag(flags.timeout, body.timeoutMs) }, socketTimeoutMs(editTimeoutMs)), json)
      } else {
        const sid = required(id, 'session ID')
        output(await withHeartbeat(client, 'edit', sid, client.request('sessions.edit', { id: sid, ...body, timeoutMs: numberFlag(flags.timeout, body.timeoutMs) }, socketTimeoutMs(editTimeoutMs))), json)
      }
    } else throw new UsageError(`shellink session list|create|state|history|input|exec|exec-status|exec-cancel|download|upload|edit|mode|close|remove-record (${t(locale, 'usage')})`)
  } finally { client.close() }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { words, flags } = parse(argv)
  const [group, action] = words

  if (group === 'upgrade') {
    noExtraWords(words, 1)
    if (flags.help === true) { printHelp('upgrade'); return }
    await handleUpgrade(flags)
    return
  }
  if (flags.version === true || group === 'version') {
    output(
      flags.json === true
        ? { name: 'shellink', version: VERSION, commit: GIT_COMMIT, protocolVersion: PROTOCOL_VERSION }
        : `Shellink ${VERSION} (${GIT_COMMIT})\nProtocol ${PROTOCOL_VERSION}`,
      flags.json === true,
    )
    return
  }
  if (group === 'help') { noExtraWords(words, 2); printHelp(action); return }
  if (flags.help === true) { printHelp(group); return }
  if (!group) { printHelp(); return }
  if (group === 'cli') { noExtraWords(words, 1); await runTuiCommand(); return }
  if (group === 'agent-doc') { noExtraWords(words, 1); output(flags.json === true ? AGENT_DOC_JSON : AGENT_DOC, flags.json === true); return }
  if (group === 'server') { noExtraWords(words, 2); await handleServer(action, flags); return }
  if (!['profile', 'session', 'webhook'].includes(group)) throw new UsageError(t(locale, 'unknownCommand', { command: group }))
  await handleRpc(words, flags)
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try { return import.meta.url === pathToFileURL(path.resolve(entry)).href }
  catch { return false }
}

if (isDirectRun()) {
  main().catch((error) => {
    if (error instanceof UsageError) { console.error(error.message); process.exitCode = 2; return }
    if (error instanceof UpgradeError) { console.error(error.message); process.exitCode = error.exitCode; return }
    if (error instanceof AppError && error.status === 400) { console.error(error.message); process.exitCode = 2; return }
    if (error instanceof AppError && error.code === RpcErrorCode.METHOD_NOT_FOUND) {
      console.error(`${error.message}\nThis command requires a newer daemon. Run: shellink server restart`)
      process.exitCode = 1
      return
    }
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
