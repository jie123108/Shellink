import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { config } from '../../src/config.js'
import { setupWsGateway } from '../../src/ws/gateway.js'
import { TestClient, waitForState } from '../helpers/client.js'
import { resetDb } from '../helpers/resetDb.js'
import {
  applyBastionNetem,
  clearBastionNetem,
  flapTargetNetwork,
  waitTargetReachableFromBastion,
} from '../helpers/netem.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.resolve(__dirname, '../..')
const expectDir = path.resolve(__dirname, '../fixtures/expect')

/** Sized for ~30s transfer budget at 100kbps with base64 overhead (~10.5s ideal). */
const TRANSFER_BYTES = 96 * 1024

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function composeUp(): void {
  execSync('docker compose -f test/docker/docker-compose.yml up -d --build --wait', {
    cwd: serverRoot,
    stdio: 'inherit',
  })
}

function composeDown(): void {
  try {
    execSync('docker compose -f test/docker/docker-compose.yml down -v', {
      cwd: serverRoot,
      stdio: 'ignore',
    })
  } catch {
    // ignore
  }
}

const hasDocker = dockerAvailable()

describe.skipIf(!hasDocker)('e2e network impairment (jump path)', () => {
  let app: FastifyInstance
  let client: TestClient
  let profileId: string
  let sid = ''

  async function openJumpSession(): Promise<string> {
    const created = await client.createSession(profileId)
    const id = (created.json as { id: string }).id
    await waitForState(client, id, ['WAITING_INPUT'], 90_000)
    return id
  }

  async function ensureJumpSession(): Promise<string> {
    if (sid) {
      try {
        await waitForState(client, sid, ['WAITING_INPUT'], 15_000)
        return sid
      } catch {
        await client.closeSession(sid).catch(() => {})
      }
    }
    sid = await openJumpSession()
    return sid
  }

  beforeAll(async () => {
    // Delay/loss/rate make PTY gaps longer than the default 150ms vitest silence.
    config.silenceThresholdMs = 2_000

    composeUp()
    waitTargetReachableFromBastion(30_000)
    resetDb()
    app = await buildApp({ logger: false, skipMarkStale: true })
    await app.listen({ port: 0, host: '127.0.0.1' })
    setupWsGateway(app.server)
    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    client = new TestClient({ kind: 'http', baseUrl: `http://127.0.0.1:${port}` }, 'test-token')

    const exp = path.join(expectDir, 'jump-menu.exp')
    const profile = await client.createProfile({
      name: 'jump-netem',
      connectType: 'command',
      command: `expect ${exp} 127.0.0.1 2223`,
      promptRegex: '[$#]\\s*$',
    })
    expect(profile.status).toBe(201)
    profileId = (profile.json as { id: string }).id
    sid = await openJumpSession()
  }, 360_000)

  afterAll(async () => {
    clearBastionNetem()
    if (sid) await client.closeSession(sid).catch(() => {})
    resetDb()
    await app.close()
    composeDown()
  })

  afterEach(async () => {
    clearBastionNetem()
    if (sid) {
      try {
        await waitForState(client, sid, ['WAITING_INPUT'], 10_000)
      } catch {
        await client.closeSession(sid).catch(() => {})
        sid = ''
      }
    }
  })

  async function assertExec(sessionId: string): Promise<void> {
    await waitForState(client, sessionId, ['WAITING_INPUT'], 20_000)
    const exec = await client.exec(sessionId, 'echo netem-ok && pwd', 20_000)
    expect(exec.status, JSON.stringify(exec.json)).toBe(200)
    const body = exec.json as { timedOut: boolean; output: string }
    expect(body.timedOut).toBe(false)
    expect(body.output).toContain('netem-ok')
  }

  async function assertUpload(sessionId: string): Promise<{ remotePath: string; payload: Buffer; sha: string }> {
    await waitForState(client, sessionId, ['WAITING_INPUT'], 20_000)
    const remotePath = `/tmp/sp-netem-${crypto.randomBytes(4).toString('hex')}.bin`
    const payload = crypto.randomBytes(TRANSFER_BYTES)
    const sha = crypto.createHash('sha256').update(payload).digest('hex')
    const up = await client.upload(sessionId, remotePath, payload, {
      sha256: sha,
      timeoutMs: 30_000,
    })
    expect(up.status, JSON.stringify(up.json)).toBe(200)
    const body = up.json as { ok: boolean; size: number }
    expect(body.ok).toBe(true)
    expect(body.size).toBe(payload.length)
    await waitForState(client, sessionId, ['WAITING_INPUT'], 20_000)
    return { remotePath, payload, sha }
  }

  async function assertDownload(
    sessionId: string,
    remotePath: string,
    payload: Buffer,
    sha: string,
  ): Promise<void> {
    await waitForState(client, sessionId, ['WAITING_INPUT'], 20_000)
    const down = await client.download(sessionId, remotePath, 30_000)
    expect(down.status, down.body.toString('utf8').slice(0, 500)).toBe(200)
    expect(down.body.equals(payload)).toBe(true)
    expect(String(down.headers['x-shellink-sha256'] ?? down.headers['X-Shellink-SHA256'])).toBe(sha)
    await client.exec(sessionId, `rm -f ${remotePath}`).catch(() => {})
    await waitForState(client, sessionId, ['WAITING_INPUT'], 20_000).catch(() => {})
  }

  describe('bastion delay 200ms', () => {
    beforeEach(() => {
      clearBastionNetem()
      applyBastionNetem({ delayMs: 200 })
    })

    it('exec succeeds', async () => {
      const id = await ensureJumpSession()
      await assertExec(id)
    }, 60_000)

    it('upload 96KiB succeeds within 30s', async () => {
      const id = await ensureJumpSession()
      const { remotePath } = await assertUpload(id)
      await client.exec(id, `rm -f ${remotePath}`).catch(() => {})
    }, 90_000)

    it('download 96KiB succeeds within 30s', async () => {
      const id = await ensureJumpSession()
      const { remotePath, payload, sha } = await assertUpload(id)
      await assertDownload(id, remotePath, payload, sha)
    }, 120_000)
  })

  describe('bastion loss 5%', () => {
    beforeEach(() => {
      clearBastionNetem()
      applyBastionNetem({ lossPercent: 5 })
    })

    it('exec succeeds', async () => {
      const id = await ensureJumpSession()
      await assertExec(id)
    }, 60_000)

    it('upload 96KiB succeeds within 30s', async () => {
      const id = await ensureJumpSession()
      const { remotePath } = await assertUpload(id)
      await client.exec(id, `rm -f ${remotePath}`).catch(() => {})
    }, 90_000)

    it('download 96KiB succeeds within 30s', async () => {
      const id = await ensureJumpSession()
      const { remotePath, payload, sha } = await assertUpload(id)
      await assertDownload(id, remotePath, payload, sha)
    }, 120_000)
  })

  describe('bastion rate 100kbit', () => {
    beforeEach(() => {
      clearBastionNetem()
      applyBastionNetem({ rateKbit: 100 })
    })

    it('exec succeeds', async () => {
      const id = await ensureJumpSession()
      await assertExec(id)
    }, 60_000)

    it('upload 96KiB succeeds within 30s', async () => {
      const id = await ensureJumpSession()
      const { remotePath } = await assertUpload(id)
      await client.exec(id, `rm -f ${remotePath}`).catch(() => {})
    }, 90_000)

    it('download 96KiB succeeds within 30s', async () => {
      // Upload without rate limit so the download itself is what we time under 100kbit.
      clearBastionNetem()
      const id = await ensureJumpSession()
      const { remotePath, payload, sha } = await assertUpload(id)
      applyBastionNetem({ rateKbit: 100 })
      await assertDownload(id, remotePath, payload, sha)
    }, 90_000)
  })

  describe('target network restart', () => {
    it('flap disconnects jump session; after recovery new session works', async () => {
      clearBastionNetem()
      const id = await ensureJumpSession()
      await assertExec(id)

      // Keep the remote side generating traffic so the outage is noticed.
      void client.exec(id, 'while true; do echo tick; sleep 0.2; done', 60_000)
      await new Promise((r) => setTimeout(r, 500))
      flapTargetNetwork({ downMs: 5_000 })

      // Direct SSH would go DISCONNECTED; jump PTY may survive on bastion after nested SSH dies.
      let disconnected = false
      try {
        await waitForState(client, id, ['DISCONNECTED'], 30_000)
        disconnected = true
      } catch {
        const st = await client.getState(id)
        const state = (st.json as { state?: string }).state ?? 'UNKNOWN'
        expect(['WAITING_INPUT', 'IDLE', 'OUTPUTTING', 'DISCONNECTED']).toContain(state)
        const again = await client.exec(id, 'echo after-flap', 10_000)
        // Target hop is gone or session is wedged — must not look like a healthy target shell.
        if (again.status === 200) {
          const out = (again.json as { output?: string }).output ?? ''
          expect(out.includes('after-flap') && !out.includes('Connection')).toBe(false)
        } else {
          expect([404, 409, 502, 504]).toContain(again.status)
        }
      }
      if (disconnected) {
        const again = await client.exec(id, 'echo no')
        expect([404, 409, 502]).toContain(again.status)
      }

      await client.closeSession(id).catch(() => {})
      waitTargetReachableFromBastion(30_000)
      sid = await openJumpSession()
      await assertExec(sid)
      const { remotePath, payload, sha } = await assertUpload(sid)
      await assertDownload(sid, remotePath, payload, sha)
    }, 300_000)
  })
})
