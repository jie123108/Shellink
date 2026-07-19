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

describe.skipIf(!hasDocker)('e2e failure modes', () => {
  let app: FastifyInstance
  let client: TestClient

  beforeAll(async () => {
    composeUp()
    resetDb()
    app = await buildApp({ logger: false, skipMarkStale: true })
    await app.listen({ port: 0, host: '127.0.0.1' })
    setupWsGateway(app.server)
    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    client = new TestClient({ kind: 'http', baseUrl: `http://127.0.0.1:${port}` }, 'test-token')
  }, 300_000)

  afterAll(async () => {
    resetDb()
    await app.close()
    composeDown()
  })

  it('connection refused to closed port', async () => {
    const profile = await client.createProfile({
      name: 'refuse',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 1,
      username: 'testuser',
      authType: 'password',
      password: 'x',
    })
    const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string })
      .id
    await waitForState(client, sid, ['DISCONNECTED'], 15_000)
    const st = await client.getState(sid)
    expect((st.json as { active: boolean }).active).toBe(false)
  }, 30_000)

  it('SSH handshake hang until readyTimeout', async () => {
    const profile = await client.createProfile({
      name: 'hang',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 2224,
      username: 'testuser',
      authType: 'password',
      password: 'x',
    })
    const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string })
      .id
    // briefly CONNECTING
    await waitForState(client, sid, ['CONNECTING', 'DISCONNECTED'], 2_000).catch(() => {})
    await waitForState(client, sid, ['DISCONNECTED'], 12_000)
  }, 30_000)

  it('wrong password disconnects', async () => {
    const profile = await client.createProfile({
      name: 'bad-pass',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 2222,
      username: 'testuser',
      authType: 'password',
      password: 'wrong-password-xyz',
    })
    const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string })
      .id
    await waitForState(client, sid, ['DISCONNECTED'], 20_000)
  }, 30_000)

  it('target restart mid-session disconnects', async () => {
    const profile = await client.createProfile({
      name: 'restart',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 2222,
      username: 'testuser',
      authType: 'password',
      password: 'testpass',
      promptRegex: '[$#]\\s*$',
    })
    const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string })
      .id
    await waitForState(client, sid, ['WAITING_INPUT'], 45_000)

    // start a long sleep then restart target
    void client.exec(sid, 'sleep 30', 5_000)
    await new Promise((r) => setTimeout(r, 300))
    execSync('docker restart shellink-test-target', { stdio: 'ignore' })
    await waitForState(client, sid, ['DISCONNECTED'], 30_000)

    const again = await client.exec(sid, 'echo no')
    expect(again.status).toBe(404)

    // wait for target healthy again for later tests
    execSync('docker compose -f test/docker/docker-compose.yml up -d --wait target', {
      cwd: serverRoot,
      stdio: 'ignore',
    })
  }, 90_000)

  it('exec python syntax error returns output and WAITING_INPUT', async () => {
    const profile = await client.createProfile({
      name: 'py-err',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 2222,
      username: 'testuser',
      authType: 'password',
      password: 'testpass',
      promptRegex: '[$#]\\s*$',
    })
    const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string })
      .id
    await waitForState(client, sid, ['WAITING_INPUT'], 45_000)

    const exec = await client.exec(sid, "python3 -c 'def('")
    expect(exec.status).toBe(200)
    const body = exec.json as { timedOut: boolean; output: string; state: string }
    expect(body.timedOut).toBe(false)
    expect(body.output.toLowerCase()).toMatch(/syntax|error|traceback/)
    expect(['WAITING_INPUT', 'IDLE']).toContain(body.state)

    await client.closeSession(sid)
  }, 60_000)

  it('exec nonzero exit still returns to stable state', async () => {
    const profile = await client.createProfile({
      name: 'false-cmd',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 2222,
      username: 'testuser',
      authType: 'password',
      password: 'testpass',
      promptRegex: '[$#]\\s*$',
    })
    const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string })
      .id
    await waitForState(client, sid, ['WAITING_INPUT'], 45_000)

    const exec = await client.exec(sid, 'false; echo after-false')
    expect(exec.status).toBe(200)
    const body = exec.json as { timedOut: boolean; output: string }
    expect(body.timedOut).toBe(false)
    expect(body.output).toContain('after-false')

    await client.closeSession(sid)
  }, 60_000)

  it('long command times out then Ctrl+C recovers', async () => {
    const profile = await client.createProfile({
      name: 'sleep-to',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 2222,
      username: 'testuser',
      authType: 'password',
      password: 'testpass',
      promptRegex: '[$#]\\s*$',
    })
    const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string })
      .id
    await waitForState(client, sid, ['WAITING_INPUT'], 45_000)

    // Flood output faster than silenceThreshold so waitForStable must time out
    const exec = await client.exec(sid, 'yes tick', 2_000)
    expect(exec.status).toBe(200)
    expect((exec.json as { timedOut: boolean }).timedOut).toBe(true)

    await client.input(sid, '\u0003', false)
    await waitForState(client, sid, ['WAITING_INPUT'], 15_000)

    const ok = await client.exec(sid, 'echo recovered')
    expect((ok.json as { output: string }).output).toContain('recovered')
    await client.closeSession(sid)
  }, 60_000)

  it('local command that exits immediately disconnects', async () => {
    const profile = await client.createProfile({
      name: 'local-fail',
      connectType: 'command',
      command: 'false'    })
    const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string })
      .id
    await waitForState(client, sid, ['DISCONNECTED'], 10_000)
  }, 20_000)
})
