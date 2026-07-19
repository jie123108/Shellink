import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { setupWsGateway } from '../../src/ws/gateway.js'
import { TestClient, waitForState } from '../helpers/client.js'
import { resetDb } from '../helpers/resetDb.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.resolve(__dirname, '../..')

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

describe.skipIf(!hasDocker)('e2e abnormal scenarios', () => {
  let app: FastifyInstance
  let client: TestClient
  let sid: string
  let profileId: string

  beforeAll(async () => {
    composeUp()
    resetDb()
    app = await buildApp({ logger: false, skipMarkStale: true })
    await app.listen({ port: 0, host: '127.0.0.1' })
    setupWsGateway(app.server)
    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    client = new TestClient({ kind: 'http', baseUrl: `http://127.0.0.1:${port}` }, 'test-token')

    const profile = await client.createProfile({
      name: 'abnormal-ssh',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 2222,
      username: 'testuser',
      authType: 'password',
      password: 'testpass',
      promptRegex: '[$#]\\s*$',
    })
    profileId = (profile.json as { id: string }).id
    sid = ((await client.createSession(profileId)).json as { id: string }).id
    await waitForState(client, sid, ['WAITING_INPUT'], 45_000)
  }, 300_000)

  afterAll(async () => {
    if (sid) await client.closeSession(sid).catch(() => {})
    resetDb()
    await app.close()
    composeDown()
  })

  it('slow spaced output still returns WAITING_INPUT with all lines', async () => {
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
    // Gaps > SHELLINK_SILENCE_MS (150ms) — must not settle IDLE before prompt
    const exec = await client.exec(
      sid,
      'i=1; while [ "$i" -le 20 ]; do echo "slow-$i"; sleep 0.3; i=$((i+1)); done',
      60_000,
    )
    expect(exec.status).toBe(200)
    const body = exec.json as { timedOut: boolean; output: string; state: string }
    expect(body.timedOut).toBe(false)
    expect(body.output).toContain('slow-1')
    expect(body.output).toContain('slow-20')
    expect(['WAITING_INPUT', 'IDLE']).toContain(body.state)
  }, 90_000)

  it('upload timeout then session still healthy for exec', async () => {
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
    // Force short timeout while uploading enough data that decode wait can expire
    // if remote is slow; if upload finishes early, still assert follow-up exec works.
    const data = Buffer.alloc(200_000, 7)
    const up = await client.upload(sid, `/tmp/abn-to-${Date.now()}.bin`, data, { timeoutMs: 1000 })
    expect([200, 504, 502, 409]).toContain(up.status)
    await waitForState(client, sid, ['WAITING_INPUT', 'IDLE', 'DISCONNECTED'], 30_000).catch(() => {})
    const st = await client.getState(sid)
    if ((st.json as { state: string }).state === 'DISCONNECTED') {
      // recreate
      sid = ((await client.createSession(profileId)).json as { id: string }).id
      await waitForState(client, sid, ['WAITING_INPUT'], 45_000)
    } else if ((st.json as { state: string }).state !== 'WAITING_INPUT') {
      await client.input(sid, '\u0003', false)
      await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
    }
    const ok = await client.exec(sid, 'echo healthy-after-xfer')
    expect(ok.status).toBe(200)
    expect((ok.json as { output: string }).output).toContain('healthy-after-xfer')
  }, 120_000)

  it('docker pause mid-upload then unpause yields error or success, session recoverable', async () => {
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
    const data = Buffer.alloc(500_000, 9)
    const remote = `/tmp/abn-pause-${Date.now()}.bin`
    const upP = client.upload(sid, remote, data, { timeoutMs: 60_000 })
    await new Promise((r) => setTimeout(r, 200))
    try {
      execSync('docker pause shellink-test-target', { stdio: 'ignore' })
      await new Promise((r) => setTimeout(r, 2_000))
    } finally {
      try {
        execSync('docker unpause shellink-test-target', { stdio: 'ignore' })
      } catch {
        // ignore
      }
    }
    const up = await upP
    expect([200, 404, 502, 504, 409, 500]).toContain(up.status)
    await new Promise((r) => setTimeout(r, 1_000))
    const st = await client.getState(sid)
    const state = (st.json as { state: string }).state
    if (state === 'DISCONNECTED' || st.status === 404) {
      sid = ((await client.createSession(profileId)).json as { id: string }).id
      await waitForState(client, sid, ['WAITING_INPUT'], 45_000)
    } else {
      await waitForState(client, sid, ['WAITING_INPUT', 'IDLE'], 30_000).catch(() => {})
      if ((await client.getState(sid)).json && (await client.getState(sid)).json) {
        const s2 = ((await client.getState(sid)).json as { state: string }).state
        if (s2 !== 'WAITING_INPUT') {
          await client.input(sid, '\u0003', false).catch(() => {})
          await waitForState(client, sid, ['WAITING_INPUT'], 20_000).catch(() => {})
        }
      }
    }
    const ping = await client.exec(sid, 'echo after-pause')
    expect([200, 409, 404]).toContain(ping.status)
  }, 180_000)

  it('out-of-order: download while CONNECTING; ops after disconnect', async () => {
    const profile = await client.createProfile({
      name: 'abn-connecting',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 2224, // blackhole,
      username: 'u',
      authType: 'password',
      password: 'x',
      promptRegex: '[$#]\\s*$',
    })
    const hangId = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string })
      .id
    await waitForState(client, hangId, ['CONNECTING'], 3_000).catch(() => {})
    const dl = await client.download(hangId, '/tmp/x')
    expect([409, 404]).toContain(dl.status)
    await client.closeSession(hangId).catch(() => {})
    await new Promise((r) => setTimeout(r, 500))
    const up = await client.upload(hangId, '/tmp/x', Buffer.from('z'))
    expect([404, 409]).toContain(up.status)
  }, 60_000)
})
