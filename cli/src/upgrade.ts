import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { VERSION } from '@shellink/protocol'
import { connectDaemon, ensureDaemon } from './daemon.js'
import { resolveCliLocale, type CliLocale } from './i18n.js'
import type { ProgressReporter } from './progress.js'

const REPO = 'jie123108/Shellink'
const GITHUB_API = `https://api.github.com/repos/${REPO}`
const GITHUB_RELEASE = `https://github.com/${REPO}/releases/download`
const RELEASES_URL = `https://github.com/${REPO}/releases`
const MAX_ATTEMPTS = 3
const CONNECT_TIMEOUT_MS = 30_000
const STALL_TIMEOUT_MS = 60_000

type UpgradeStage = 'release metadata' | 'SHA256SUMS.txt' | 'binary'

export class DownloadError extends Error {
  constructor(
    readonly kind: 'http' | 'connect-timeout' | 'stalled' | 'truncated' | 'checksum' | 'network',
    message: string,
    readonly status?: number,
    readonly headers?: Headers,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export class UpgradeError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message)
    this.name = 'UpgradeError'
  }
}

export type UpgradeResult = {
  current: string
  target: string
  upToDate: boolean
  updated: boolean
  checkOnly: boolean
  asset?: string
  path?: string
  restarted: boolean
  downloadedBytes?: number
  durationMs?: number
  attempts?: number
}

export type UpgradeOptions = {
  checkOnly?: boolean
  targetVersion?: string
  yes?: boolean
  currentVersion?: string
  isBunBinary?: boolean
  execPath?: string
  platform?: NodeJS.Platform
  arch?: string
  fetchImpl?: typeof fetch
  confirm?: (message: string) => Promise<boolean>
  isTty?: boolean
  restartDaemon?: () => Promise<boolean>
  locale?: CliLocale
  progress?: ProgressReporter
  connectTimeoutMs?: number
  stallTimeoutMs?: number
  retryDelayMs?: number
}

type DownloadOptions = {
  tag: string
  assetName: string
  destDir: string
  fetchImpl?: typeof fetch
  currentVersion?: string
  locale?: CliLocale
  progress?: ProgressReporter
  connectTimeoutMs?: number
  stallTimeoutMs?: number
  retryDelayMs?: number
}

function userAgent(version: string): string {
  return `shellink/${version}`
}

function text(locale: CliLocale): Record<string, string> {
  return locale === 'zh-CN'
    ? {
        downloading: '正在下载',
        retry: '下载失败，将在 {delay}s 后进行第 {attempt}/{max} 次重试：{reason}',
        timeout: '连接超时',
        stalled: '下载停滞',
        truncated: '下载不完整',
        checksum: '校验和不匹配',
        network: '网络连接失败',
        http: 'HTTP {status} {statusText}',
        failed: '下载 {stage} 失败（已尝试 {attempts} 次）',
        url: '地址',
        hintProxy: '网络较慢或连接被中断。设置代理后重试：export HTTPS_PROXY=http://127.0.0.1:7890',
        hintDns: '请检查网络和 DNS 配置；必要时设置 HTTPS_PROXY 后重试。',
        hintTls: 'TLS 证书校验失败。请检查代理设置和系统时间。',
        hintNotFound: '指定版本或发布资产不存在。运行 shellink upgrade --check，或查看 {releases}。',
        hintRateLimit: 'GitHub API 请求受限。可使用 shellink upgrade --version TAG 绕过 latest API 查询。',
        hintServer: 'GitHub 服务暂时异常，已自动重试。请稍后重试。',
        hintChecksum: '文件可能被截断或被中间设备修改。请检查网络后重试。',
      }
    : {
        downloading: 'Downloading',
        retry: 'Download failed; retrying {attempt}/{max} in {delay}s: {reason}',
        timeout: 'connection timed out',
        stalled: 'download stalled',
        truncated: 'download was incomplete',
        checksum: 'checksum mismatch',
        network: 'network connection failed',
        http: 'HTTP {status} {statusText}',
        failed: 'Failed to download {stage} after {attempts} attempts',
        url: 'URL',
        hintProxy: 'The network is slow or the connection was interrupted. Configure a proxy and retry: export HTTPS_PROXY=http://127.0.0.1:7890',
        hintDns: 'Check the network and DNS configuration; configure HTTPS_PROXY if necessary.',
        hintTls: 'TLS certificate verification failed. Check the proxy configuration and system clock.',
        hintNotFound: 'The requested release tag or asset does not exist. Run shellink upgrade --check, or see {releases}.',
        hintRateLimit: 'GitHub API rate limit reached. Use shellink upgrade --version TAG to skip the latest-release API lookup.',
        hintServer: 'GitHub is temporarily unavailable and was retried. Please try again later.',
        hintChecksum: 'The file may have been truncated or modified in transit. Check the network and retry.',
      }
}

function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`))
}

export function normalizeTag(version: string): string {
  const trimmed = version.trim()
  if (!trimmed) throw new UpgradeError('version tag must not be empty', 2)
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`
}

export function stripVersionPrefix(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag
}

export function compareVersions(a: string, b: string): number {
  const pa = stripVersionPrefix(a).split(/[-+]/)[0]!.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = stripVersionPrefix(b).split(/[-+]/)[0]!.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(pa.length, pb.length); index++) {
    const left = pa[index] ?? 0
    const right = pb[index] ?? 0
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

export function detectAssetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform === 'win32') throw new UpgradeError('Windows is not supported by prebuilt Shellink binaries. Build from source instead (see repository README).', 2)
  const osName = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined
  if (!osName) throw new UpgradeError(`unsupported OS: ${platform} (supported: macOS, Linux)`, 2)
  const archName = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : undefined
  if (!archName) throw new UpgradeError(`unsupported architecture: ${arch} (supported: x64, arm64)`, 2)
  return `shellink-${osName}-${archName}`
}

export function detectInstallTarget(options: { isBunBinary?: boolean; execPath?: string } = {}): string {
  const isBun = options.isBunBinary ?? typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
  if (!isBun) throw new UpgradeError('shellink upgrade only supports the standalone binary install. Re-run install.sh, or rebuild from source.', 2)
  const execPath = options.execPath ?? process.execPath
  try {
    return fs.realpathSync(execPath)
  } catch (error) {
    throw new UpgradeError(`cannot resolve binary path ${execPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof DownloadError)) return true
  return error.kind === 'network' || error.kind === 'connect-timeout' || error.kind === 'stalled'
    || (error.kind === 'http' && (error.status === 429 || (error.status !== undefined && error.status >= 500)))
}

function errorReason(error: unknown, locale: CliLocale): string {
  const messages = text(locale)
  if (!(error instanceof DownloadError)) return error instanceof Error ? error.message : messages.network
  if (error.kind === 'http') return interpolate(messages.http, { status: error.status ?? 0, statusText: error.message })
  return messages[error.kind] ?? error.message
}

function errorHint(error: unknown, locale: CliLocale): string {
  const messages = text(locale)
  if (error instanceof DownloadError) {
    if (error.kind === 'http') {
      if (error.status === 404) return interpolate(messages.hintNotFound, { releases: RELEASES_URL })
      if ((error.status === 403 || error.status === 429) && error.headers?.get('x-ratelimit-remaining') === '0') return messages.hintRateLimit
      if (error.status !== undefined && error.status >= 500) return messages.hintServer
    }
    if (error.kind === 'checksum' || error.kind === 'truncated') return messages.hintChecksum
    if (error.kind === 'connect-timeout' || error.kind === 'stalled') return messages.hintProxy
  }
  const source = String((error as { cause?: unknown })?.cause ?? error)
  if (/ENOTFOUND|EAI_AGAIN/i.test(source)) return messages.hintDns
  if (/CERT_|UNABLE_TO_VERIFY|TLS/i.test(source)) return messages.hintTls
  return messages.hintProxy
}

export function describeDownloadError(error: unknown, options: {
  stage: UpgradeStage
  url: string
  attempts: number
  locale: CliLocale
}): UpgradeError {
  const messages = text(options.locale)
  return new UpgradeError([
    interpolate(messages.failed, { stage: options.stage, attempts: options.attempts }),
    `  ${messages.url}: ${options.url}`,
    `  ${errorReason(error, options.locale)}`,
    `  ${errorHint(error, options.locale)}`,
  ].join('\n'))
}

async function fetchWithRetry(options: {
  url: string
  stage: UpgradeStage
  fetchImpl: typeof fetch
  headers: Record<string, string>
  locale: CliLocale
  progress?: ProgressReporter
  connectTimeoutMs: number
  retryDelayMs: number
}): Promise<{ response: Response; attempts: number }> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('connect-timeout')), options.connectTimeoutMs)
    try {
      const response = await options.fetchImpl(options.url, { headers: options.headers, signal: controller.signal })
      if (!response.ok) throw new DownloadError('http', response.statusText, response.status, response.headers)
      return { response, attempts: attempt }
    } catch (error) {
      lastError = error instanceof DownloadError
        ? error
        : new DownloadError((error as { message?: string })?.message === 'connect-timeout' ? 'connect-timeout' : 'network', error instanceof Error ? error.message : String(error), undefined, undefined, error)
      if (!isRetryable(lastError) || attempt === MAX_ATTEMPTS) break
      const delay = options.retryDelayMs * 2 ** (attempt - 1)
      options.progress?.retry(interpolate(text(options.locale).retry, {
        attempt: attempt + 1, max: MAX_ATTEMPTS, delay: Math.ceil(delay / 1000), reason: errorReason(lastError, options.locale),
      }))
      await sleep(delay)
    } finally {
      clearTimeout(timer)
    }
  }
  throw describeDownloadError(lastError, { stage: options.stage, url: options.url, attempts: MAX_ATTEMPTS, locale: options.locale })
}

export async function resolveReleaseTag(
  targetVersion: string | undefined,
  fetchImpl: typeof fetch = fetch,
  currentVersion: string = VERSION,
  options: Pick<UpgradeOptions, 'locale' | 'progress' | 'connectTimeoutMs' | 'retryDelayMs'> = {},
): Promise<string> {
  if (targetVersion !== undefined) return normalizeTag(targetVersion)
  const locale = options.locale ?? resolveCliLocale()
  const url = `${GITHUB_API}/releases/latest`
  const { response } = await fetchWithRetry({
    url, stage: 'release metadata', fetchImpl, locale, progress: options.progress,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': userAgent(currentVersion) },
    connectTimeoutMs: options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    retryDelayMs: options.retryDelayMs ?? 1000,
  })
  const body = await response.json() as { tag_name?: unknown }
  if (typeof body.tag_name !== 'string' || !body.tag_name) throw new UpgradeError('could not resolve latest release tag from GitHub API')
  return normalizeTag(body.tag_name)
}

export function expectedChecksum(sumsText: string, assetName: string): string {
  for (const line of sumsText.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+(?:\*|\.\/)?(.+)$/)
    if (match?.[2]?.replace(/^\.\//, '') === assetName) return match[1]!.toLowerCase()
  }
  throw new UpgradeError(`checksum for ${assetName} not found in SHA256SUMS.txt`)
}

async function streamToFile(response: Response, destination: string, options: {
  label: string
  progress?: ProgressReporter
  stallTimeoutMs: number
}): Promise<{ bytes: number; sha256: string; durationMs: number }> {
  if (!response.body) throw new DownloadError('network', 'response body is empty')
  const totalHeader = response.headers.get('content-length')
  const total = totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : undefined
  const hash = crypto.createHash('sha256')
  const reader = response.body.getReader()
  const startedAt = Date.now()
  let received = 0
  const fd = fs.openSync(destination, 'w', 0o755)
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DownloadError('stalled', 'no data received')), options.stallTimeoutMs)
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
      if (result.done) break
      const chunk = Buffer.from(result.value)
      hash.update(chunk)
      fs.writeSync(fd, chunk)
      received += chunk.length
      options.progress?.update({ label: options.label, received, total, startedAt })
    }
  } finally {
    fs.closeSync(fd)
  }
  if (total !== undefined && received < total) throw new DownloadError('truncated', `expected ${total} bytes but received ${received}`)
  const durationMs = Date.now() - startedAt
  options.progress?.finish({ label: options.label, received, total, startedAt })
  return { bytes: received, sha256: hash.digest('hex'), durationMs }
}

export async function downloadAndVerify(options: DownloadOptions): Promise<{
  binaryPath: string
  sha256: string
  downloadedBytes: number
  durationMs: number
  attempts: number
}> {
  const fetchImpl = options.fetchImpl ?? fetch
  const currentVersion = options.currentVersion ?? VERSION
  const locale = options.locale ?? resolveCliLocale()
  const headers = { 'User-Agent': userAgent(currentVersion) }
  const base = `${GITHUB_RELEASE}/${options.tag}`
  const retryOptions = { fetchImpl, headers, locale, progress: options.progress, connectTimeoutMs: options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, retryDelayMs: options.retryDelayMs ?? 1000 }
  const sumsUrl = `${base}/SHA256SUMS.txt`
  const sums = await fetchWithRetry({ ...retryOptions, url: sumsUrl, stage: 'SHA256SUMS.txt' })
  const expected = expectedChecksum(await sums.response.text(), options.assetName)
  const assetUrl = `${base}/${options.assetName}`
  fs.mkdirSync(options.destDir, { recursive: true })
  const binaryPath = path.join(options.destDir, options.assetName)
  let lastError: unknown
  let attempts = 0
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const asset = await fetchWithRetry({ ...retryOptions, url: assetUrl, stage: 'binary' })
      attempts += asset.attempts
      const streamed = await streamToFile(asset.response, binaryPath, {
        label: `${text(locale).downloading} ${options.assetName}`,
        progress: options.progress,
        stallTimeoutMs: options.stallTimeoutMs ?? STALL_TIMEOUT_MS,
      })
      if (streamed.sha256 !== expected) throw new DownloadError('checksum', `expected ${expected}, got ${streamed.sha256}`)
      return { binaryPath, sha256: streamed.sha256, downloadedBytes: streamed.bytes, durationMs: streamed.durationMs, attempts: sums.attempts + attempts }
    } catch (error) {
      lastError = error
      try { fs.unlinkSync(binaryPath) } catch { /* ignore */ }
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS) break
      const delay = (options.retryDelayMs ?? 1000) * 2 ** (attempt - 1)
      options.progress?.retry(interpolate(text(locale).retry, {
        attempt: attempt + 1, max: MAX_ATTEMPTS, delay: Math.ceil(delay / 1000), reason: errorReason(error, locale),
      }))
      await sleep(delay)
    }
  }
  if (lastError instanceof UpgradeError) throw lastError
  throw describeDownloadError(lastError, { stage: 'binary', url: assetUrl, attempts: Math.max(1, attempts), locale })
}

export function installBinary(sourcePath: string, destPath: string): void {
  const destDir = path.dirname(destPath)
  try {
    fs.mkdirSync(destDir, { recursive: true })
    const temporary = path.join(destDir, `.shellink-upgrade-${process.pid}-${Date.now()}.tmp`)
    fs.copyFileSync(sourcePath, temporary)
    fs.chmodSync(temporary, 0o755)
    fs.renameSync(temporary, destPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/EACCES|EPERM|permission/i.test(message)) throw new UpgradeError(`cannot write ${destPath} (permission denied). Re-run with sudo, for example: sudo sh install.sh --dir /usr/local/bin`)
    throw new UpgradeError(`cannot write ${destPath}: ${message}`)
  }
}

async function defaultConfirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${message} [y/N] `, resolve))
    return /^\s*y(es)?\s*$/i.test(answer)
  } finally {
    rl.close()
  }
}

export async function restartDaemonIfRunning(): Promise<boolean> {
  const current = await connectDaemon()
  if (!current) return false
  try {
    await current.request('system.stop')
  } finally {
    current.close()
  }
  await sleep(300)
  const restarted = await ensureDaemon()
  restarted.close()
  return true
}

export async function runUpgrade(options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const currentVersion = options.currentVersion ?? VERSION
  const locale = options.locale ?? resolveCliLocale()
  const destPath = detectInstallTarget({ isBunBinary: options.isBunBinary, execPath: options.execPath })
  const target = await resolveReleaseTag(options.targetVersion, options.fetchImpl, currentVersion, options)
  const upToDate = compareVersions(currentVersion, target) === 0
  const asset = detectAssetName(options.platform, options.arch)
  if (options.checkOnly || upToDate) {
    return { current: stripVersionPrefix(currentVersion), target: stripVersionPrefix(target), upToDate, updated: false, checkOnly: options.checkOnly === true, asset, path: destPath, restarted: false }
  }
  const isTty = options.isTty ?? Boolean(process.stdin.isTTY && process.stderr.isTTY)
  if (!options.yes) {
    if (!isTty) throw new UpgradeError('non-interactive upgrade requires --yes', 2)
    if (!await (options.confirm ?? defaultConfirm)(`Upgrade Shellink ${stripVersionPrefix(currentVersion)} → ${stripVersionPrefix(target)}?`)) throw new UpgradeError('upgrade cancelled', 2)
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellink-upgrade-'))
  let downloaded: Awaited<ReturnType<typeof downloadAndVerify>>
  try {
    downloaded = await downloadAndVerify({ tag: target, assetName: asset, destDir: tmpDir, currentVersion, ...options, locale })
    installBinary(downloaded.binaryPath, destPath)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
  const restarted = await (options.restartDaemon ?? restartDaemonIfRunning)()
  return {
    current: stripVersionPrefix(currentVersion), target: stripVersionPrefix(target), upToDate: false, updated: true, checkOnly: false,
    asset, path: destPath, restarted, downloadedBytes: downloaded.downloadedBytes, durationMs: downloaded.durationMs, attempts: downloaded.attempts,
  }
}

export function formatUpgradeResult(result: UpgradeResult): string {
  if (result.checkOnly) return result.upToDate ? `Shellink ${result.current} is up to date (target ${result.target}).` : `Update available: ${result.current} → ${result.target}. Run: shellink upgrade`
  if (result.upToDate) return `Shellink ${result.current} is already up to date.`
  return `Upgraded Shellink ${result.current} → ${result.target} (${result.path}).${result.restarted ? ' Daemon restarted.' : ''}`
}
