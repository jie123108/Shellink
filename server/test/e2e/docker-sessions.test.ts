import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { setupWsGateway } from '../../src/ws/gateway.js'
import type { FastifyInstance } from 'fastify'
import { TestClient, waitForState } from '../helpers/client.js'
import { resetDb } from '../helpers/resetDb.js'
import { runSharedOps } from './shared-ops.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.resolve(__dirname, '../fixtures')
const keyPath = path.join(fixturesDir, 'keys/id_ed25519')
const expectDir = path.join(fixturesDir, 'expect')

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
    cwd: path.resolve(__dirname, '../..'),
    stdio: 'inherit',
  })
}

function composeDown(): void {
  try {
    execSync('docker compose -f test/docker/docker-compose.yml down -v', {
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'ignore',
    })
  } catch {
    // ignore
  }
}

const hasDocker = dockerAvailable()

describe.skipIf(!hasDocker)('e2e docker sessions', () => {
  let app: FastifyInstance
  let baseUrl: string
  let client: TestClient

  beforeAll(async () => {
    composeUp()
    resetDb()
    app = await buildApp({ logger: false, skipMarkStale: true })
    await app.listen({ port: 0, host: '127.0.0.1' })
    setupWsGateway(app.server)
    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    baseUrl = `http://127.0.0.1:${port}`
    client = new TestClient({ kind: 'http', baseUrl }, 'test-token')
  }, 300_000)

  afterAll(async () => {
    resetDb()
    await app.close()
    composeDown()
  })

  it('SSH password direct to target', async () => {
    const profile = await client.createProfile({
      name: 'ssh-pass',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 2222,
      username: 'testuser',
      authType: 'password',
      password: 'testpass',
      promptRegex: '[$#]\\s*$',
    })
    expect(profile.status).toBe(201)
    const sid = (
      await client.createSession((profile.json as { id: string }).id)
    ).json as { id: string }
    await waitForState(client, sid.id, ['WAITING_INPUT'], 45_000)
    await runSharedOps(client, sid.id)
    await client.closeSession(sid.id)
  }, 120_000)

  it('SSH key direct to target', async () => {
    const privateKey = fs.readFileSync(keyPath, 'utf8')
    const profile = await client.createProfile({
      name: 'ssh-key',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 2222,
      username: 'testuser',
      authType: 'key',
      privateKey,
      promptRegex: '[$#]\\s*$',
    })
    expect(profile.status).toBe(201)
    const sid = (
      await client.createSession((profile.json as { id: string }).id)
    ).json as { id: string }
    await waitForState(client, sid.id, ['WAITING_INPUT'], 45_000)
    const exec = await client.exec(sid.id, 'echo key-ok')
    expect((exec.json as { output: string }).output).toContain('key-ok')
    await client.closeSession(sid.id)
  }, 90_000)

  it('expect jump menu to target', async () => {
    const exp = path.join(expectDir, 'jump-menu.exp')
    const profile = await client.createProfile({
      name: 'jump-menu',
      connectType: 'command',
      command: `expect ${exp} 127.0.0.1 2223`,
      promptRegex: '[$#]\\s*$',
    })
    expect(profile.status).toBe(201)
    const sid = (
      await client.createSession((profile.json as { id: string }).id)
    ).json as { id: string }
    await waitForState(client, sid.id, ['WAITING_INPUT'], 60_000)
    await runSharedOps(client, sid.id)
    await client.closeSession(sid.id)
  }, 180_000)

  it('expect jump OTP with simulated user input', async () => {
    const exp = path.join(expectDir, 'jump-otp.exp')
    const profile = await client.createProfile({
      name: 'jump-otp',
      connectType: 'command',
      command: `expect ${exp} 127.0.0.1 2223`,
      password: 'testpass',
      promptRegex: '[$#]\\s*$',
    })
    expect(profile.status).toBe(201)
    const sid = (
      await client.createSession((profile.json as { id: string }).id)
    ).json as { id: string }

    await waitForState(client, sid.id, ['CONNECTING'], 30_000)
    const start = Date.now()
    while (Date.now() - start < 30_000) {
      const h = await client.history(sid.id, 0)
      if ((h.json as { text: string }).text.includes('OTP:')) break
      await new Promise((r) => setTimeout(r, 200))
    }
    await client.input(sid.id, '123456')
    await waitForState(client, sid.id, ['WAITING_INPUT'], 60_000)
    const exec = await client.exec(sid.id, 'echo otp-jump-ok')
    expect((exec.json as { output: string }).output).toContain('otp-jump-ok')
    await client.closeSession(sid.id)
  }, 180_000)

  it('expect jump secondary password then target password', async () => {
    const exp = path.join(expectDir, 'jump-password.exp')
    const profile = await client.createProfile({
      name: 'jump-pw',
      connectType: 'command',
      command: `expect ${exp} 127.0.0.1 2223`,
      promptRegex: '[$#]\\s*$',
    })
    expect(profile.status).toBe(201)
    const sid = (
      await client.createSession((profile.json as { id: string }).id)
    ).json as { id: string }
    await waitForState(client, sid.id, ['WAITING_INPUT'], 60_000)
    const exec = await client.exec(sid.id, 'echo jump-pw-ok')
    expect((exec.json as { output: string }).output).toContain('jump-pw-ok')
    await client.closeSession(sid.id)
  }, 180_000)

  it('docker exec into local-ct', async () => {
    const profile = await client.createProfile({
      name: 'docker-exec',
      connectType: 'command',
      command: 'docker exec -it shellink-test-local-ct env PS1="$ " bash --norc --noprofile',
      promptRegex: '[$#]\\s*$',
    })
    expect(profile.status).toBe(201)
    const sid = (
      await client.createSession((profile.json as { id: string }).id)
    ).json as { id: string }
    await waitForState(client, sid.id, ['WAITING_INPUT'], 45_000)
    await runSharedOps(client, sid.id)
    await client.closeSession(sid.id)
  }, 180_000)
})
