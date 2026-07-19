import type { FastifyInstance } from 'fastify'

export interface ProfileBody {
  name: string
  connectType?: 'ssh' | 'command'
  command?: string | null
  host?: string
  port?: number
  username?: string
  authType?: 'password' | 'key'
  password?: string
  privateKey?: string
  passphrase?: string
  term?: string
  cols?: number
  rows?: number
  promptRegex?: string | null
}

/**
 * REST client over Fastify inject or HTTP base URL.
 * Used by integration (inject) and e2e (real HTTP) without AI.
 */
export class TestClient {
  constructor(
    private readonly mode: { kind: 'inject'; app: FastifyInstance } | { kind: 'http'; baseUrl: string },
    private readonly token?: string,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(extra ?? {}) }
    if (this.token) h.authorization = `Bearer ${this.token}`
    return h
  }

  private async request(
    method: string,
    url: string,
    opts: {
      body?: unknown
      headers?: Record<string, string>
      rawBody?: Buffer | string
      contentType?: string
    } = {},
  ): Promise<{ status: number; json: unknown; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
    if (this.mode.kind === 'inject') {
      const headers = this.headers(opts.headers)
      if (opts.body !== undefined && !opts.rawBody) {
        headers['content-type'] = opts.contentType ?? 'application/json'
      } else if (opts.contentType) {
        headers['content-type'] = opts.contentType
      }
      const res = await this.mode.app.inject({
        method: method as 'GET',
        url,
        headers,
        payload: opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      })
      let json: unknown = null
      const ct = res.headers['content-type']
      if (typeof ct === 'string' && ct.includes('application/json') && res.body) {
        try {
          json = JSON.parse(res.body)
        } catch {
          json = null
        }
      } else if (res.body && method !== 'GET') {
        try {
          json = JSON.parse(res.body)
        } catch {
          json = null
        }
      }
      return {
        status: res.statusCode,
        json,
        headers: res.headers as Record<string, string | string[] | undefined>,
        body: Buffer.from(res.rawPayload ?? res.body ?? ''),
      }
    }

    const headers = this.headers(opts.headers)
    let body: BodyInit | undefined
    if (opts.rawBody) {
      body = opts.rawBody
      if (opts.contentType) headers['content-type'] = opts.contentType
    } else if (opts.body !== undefined) {
      headers['content-type'] = opts.contentType ?? 'application/json'
      body = JSON.stringify(opts.body)
    }
    const res = await fetch(`${this.mode.baseUrl}${url}`, { method, headers, body })
    const buf = Buffer.from(await res.arrayBuffer())
    let json: unknown = null
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/json') && buf.length) {
      try {
        json = JSON.parse(buf.toString('utf8'))
      } catch {
        json = null
      }
    }
    const hdrs: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      hdrs[k] = v
    })
    return { status: res.status, json, headers: hdrs, body: buf }
  }

  async healthz() {
    return this.request('GET', '/shellink/healthz')
  }

  async createProfile(body: ProfileBody) {
    return this.request('POST', '/shellink/api/profiles', { body })
  }

  async getProfile(id: string) {
    return this.request('GET', `/shellink/api/profiles/${id}`)
  }

  async listProfiles(q?: string) {
    return this.request('GET', q ? `/shellink/api/profiles?q=${encodeURIComponent(q)}` : '/shellink/api/profiles')
  }

  async updateProfile(id: string, body: Partial<ProfileBody>) {
    return this.request('PUT', `/shellink/api/profiles/${id}`, { body })
  }

  async deleteProfile(id: string) {
    return this.request('DELETE', `/shellink/api/profiles/${id}`)
  }

  async createSession(profileId: string, opts?: { cols?: number; rows?: number }) {
    return this.request('POST', '/shellink/api/sessions', { body: { profileId, ...opts } })
  }

  async getState(id: string) {
    return this.request('GET', `/shellink/api/sessions/${id}/state`)
  }

  async history(id: string, since = 0) {
    return this.request('GET', `/shellink/api/sessions/${id}/history?since=${since}`)
  }

  async input(id: string, text: string, appendNewline = true) {
    return this.request('POST', `/shellink/api/sessions/${id}/input`, { body: { text, appendNewline } })
  }

  async exec(id: string, command: string, timeoutMs?: number) {
    return this.request('POST', `/shellink/api/sessions/${id}/exec`, {
      body: { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
    })
  }

  async setMode(id: string, mode: 'AUTO' | 'MANUAL') {
    return this.request('POST', `/shellink/api/sessions/${id}/mode`, { body: { mode } })
  }

  async closeSession(id: string) {
    return this.request('DELETE', `/shellink/api/sessions/${id}`)
  }

  async removeRecord(id: string) {
    return this.request('DELETE', `/shellink/api/sessions/${id}/record`)
  }

  async purgeClosedRecords(olderThan: '24h' | '7d' | 'all') {
    return this.request('DELETE', `/shellink/api/sessions/records?olderThan=${encodeURIComponent(olderThan)}`)
  }

  async download(id: string, remotePath: string, timeoutMs?: number) {
    const q = new URLSearchParams({ path: remotePath })
    if (timeoutMs !== undefined) q.set('timeoutMs', String(timeoutMs))
    return this.request('GET', `/shellink/api/sessions/${id}/download?${q}`)
  }

  async upload(id: string, remotePath: string, data: Buffer, opts?: { sha256?: string; timeoutMs?: number }) {
    if (this.mode.kind === 'http') {
      const form = new FormData()
      form.append('file', new Blob([data]), 'upload.bin')
      const q = new URLSearchParams({ path: remotePath })
      if (opts?.sha256) q.set('sha256', opts.sha256)
      if (opts?.timeoutMs) q.set('timeoutMs', String(opts.timeoutMs))
      const headers = this.headers()
      const res = await fetch(`${this.mode.baseUrl}/shellink/api/sessions/${id}/upload?${q}`, {
        method: 'POST',
        headers,
        body: form,
      })
      const buf = Buffer.from(await res.arrayBuffer())
      let json: unknown = null
      try {
        json = JSON.parse(buf.toString('utf8'))
      } catch {
        json = null
      }
      return { status: res.status, json, headers: {}, body: buf }
    }

    // Fastify inject multipart: build a simple multipart body
    const boundary = '----ShellinkTestBoundary'
    const filename = 'upload.bin'
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    const tail = `\r\n--${boundary}--\r\n`
    const rawBody = Buffer.concat([Buffer.from(head), data, Buffer.from(tail)])
    const q = new URLSearchParams({ path: remotePath })
    if (opts?.sha256) q.set('sha256', opts.sha256)
    if (opts?.timeoutMs) q.set('timeoutMs', String(opts.timeoutMs))
    return this.request('POST', `/shellink/api/sessions/${id}/upload?${q}`, {
      rawBody,
      contentType: `multipart/form-data; boundary=${boundary}`,
    })
  }

  async edit(
    id: string,
    remotePath: string,
    edits: Array<{ oldText: string; newText: string }>,
    timeoutMs?: number,
  ) {
    return this.request('POST', `/shellink/api/sessions/${id}/edit`, {
      body: { path: remotePath, edits, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
    })
  }

  async createWebhook(url: string, events: string[] = []) {
    return this.request('POST', '/shellink/api/webhooks', { body: { url, events } })
  }

  async listWebhooks() {
    return this.request('GET', '/shellink/api/webhooks')
  }

  async deleteWebhook(id: string) {
    return this.request('DELETE', `/shellink/api/webhooks/${id}`)
  }

  async receiveWebhook(body: unknown) {
    return this.request('POST', '/shellink/webhook/callback', { body })
  }

  async listWebhookMessages() {
    return this.request('GET', '/shellink/api/webhook-messages')
  }

  async clearWebhookMessages() {
    return this.request('DELETE', '/shellink/api/webhook-messages')
  }

  async agentMd() {
    return this.request('GET', '/shellink/agent.md')
  }
}

export async function waitForState(
  client: TestClient,
  sessionId: string,
  states: string[],
  timeoutMs = 30_000,
): Promise<{ state: string; recentOutput?: string }> {
  const start = Date.now()
  let last: { state: string; recentOutput?: string } = { state: 'UNKNOWN' }
  while (Date.now() - start < timeoutMs) {
    const res = await client.getState(sessionId)
    const body = res.json as { state?: string; recentOutput?: string }
    last = { state: body.state ?? 'UNKNOWN', recentOutput: body.recentOutput }
    if (body.state && states.includes(body.state)) return last
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(
    `waitForState(${states.join('|')}) timed out; last=${last.state} output=${(last.recentOutput ?? '').slice(-200)}`,
  )
}
