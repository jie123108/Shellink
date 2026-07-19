import { i18n } from './i18n'

const TOKEN_KEY = 'shellink_token'
export const HTTP_API_PREFIX = '/shellink/api'
export const WS_PREFIX = '/shellink/ws'
export const UI_PREFIX = '/shellink/ui'

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

/** Whether the browser uses a local address, matching the server's token exemption. */
export function isLocalBrowserHost(): boolean {
  const h = window.location.hostname.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
}

export interface SensitiveOpsAuth {
  /** When true, permanent delete/purge requires a Bearer token. */
  requireToken: boolean
}

let sensitiveOpsAuthCache: SensitiveOpsAuth | null = null

/**
 * Ask the server whether sensitive ops need a token for this client.
 * Falls back to browser-local heuristics if the probe fails.
 */
export async function getSensitiveOpsAuth(force = false): Promise<SensitiveOpsAuth> {
  if (!force && sensitiveOpsAuthCache) return sensitiveOpsAuthCache
  try {
    const res = await fetch(`${HTTP_API_PREFIX}/auth/sensitive-ops`)
    if (!res.ok) throw new Error(`status ${res.status}`)
    const data = (await res.json()) as { requireToken?: unknown }
    sensitiveOpsAuthCache = { requireToken: !!data.requireToken }
    return sensitiveOpsAuthCache
  } catch {
    return { requireToken: !isLocalBrowserHost() }
  }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function handleAuth(res: Response): Promise<void> {
  if (res.status === 401) {
    clearToken()
    if (!isLocalBrowserHost() && !window.location.pathname.startsWith(`${UI_PREFIX}/login`)) {
      const redirect = encodeURIComponent(window.location.pathname + window.location.search)
      window.location.href = `${UI_PREFIX}/login?redirect=${redirect}`
    }
    throw new ApiError(401, i18n.global.t('api.unauthorized'))
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}))
  return (data as { error?: string }).error ?? i18n.global.t('api.requestFailed', { status: res.status })
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = getToken()
  const res = await fetch(`${HTTP_API_PREFIX}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  await handleAuth(res)
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string }).error ?? i18n.global.t('api.requestFailed', { status: res.status }))
  }
  return data as T
}

export interface DownloadFileResult {
  data: ArrayBuffer
  filename: string
  size: number
  sha256: string
  path: string
}

export interface UploadFileResult {
  ok: boolean
  remotePath: string
  size: number
  sha256: string
  codec: string
  durationMs: number
}

/** Download a remote file; the response body contains raw bytes. */
export async function downloadSessionFile(
  sessionId: string,
  remotePath: string,
): Promise<DownloadFileResult> {
  const token = getToken()
  const qs = new URLSearchParams({ path: remotePath })
  const res = await fetch(`${HTTP_API_PREFIX}/sessions/${sessionId}/download?${qs}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  await handleAuth(res)
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorMessage(res))
  }
  const cd = res.headers.get('Content-Disposition') ?? ''
  const m = /filename="([^"]+)"/.exec(cd)
  const filename = m?.[1] || remotePath.split('/').pop() || 'download'
  return {
    data: await res.arrayBuffer(),
    filename,
    size: Number(res.headers.get('X-Shellink-Size') ?? 0),
    sha256: res.headers.get('X-Shellink-SHA256') ?? '',
    path: res.headers.get('X-Shellink-Path') ?? remotePath,
  }
}

/** Upload a local file to the remote host using the multipart `file` field. */
export async function uploadSessionFile(
  sessionId: string,
  remotePath: string,
  file: File,
): Promise<UploadFileResult> {
  const token = getToken()
  const qs = new URLSearchParams({ path: remotePath })
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${HTTP_API_PREFIX}/sessions/${sessionId}/upload?${qs}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  })
  await handleAuth(res)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string }).error ?? i18n.global.t('api.requestFailed', { status: res.status }))
  }
  return data as UploadFileResult
}

export function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const token = getToken()
  const qs = token ? `?token=${encodeURIComponent(token)}` : ''
  return `${proto}://${window.location.host}${WS_PREFIX}${path}${qs}`
}

// ---------- Types ----------

export interface SessionSummary {
  id: string
  profileId: string
  profileName: string
  target: string
  state: string
  mode: string
  createdAt: number
  closedAt: number | null
  closeReason: string | null
  active: boolean
}

export interface WebhookMessage {
  id: string
  receivedAt: number
  data: unknown
}

export interface Profile {
  id: string
  name: string
  /** Optional business unique key (host/IP or external Guid). */
  uniqueId: string | null
  connectType: 'ssh' | 'command'
  command: string | null
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  hasPassword: boolean
  hasPrivateKey: boolean
  hasPassphrase: boolean
  term: string
  cols: number
  rows: number
  promptRegex: string | null
  createdAt: number
  updatedAt: number
}
