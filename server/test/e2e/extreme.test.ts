import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { setupWsGateway } from '../../src/ws/gateway.js'
import { config } from '../../src/config.js'
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

describe.skipIf(!hasDocker)('e2e extreme scenarios', () => {
  let app: FastifyInstance
  let client: TestClient
  let sid: string

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
      name: 'extreme-ssh',
      connectType: 'ssh',
      host: '127.0.0.1',
      port: 2222,
      username: 'testuser',
      authType: 'password',
      password: 'testpass',
      promptRegex: '[$#]\\s*$',
    })
    sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string }).id
    await waitForState(client, sid, ['WAITING_INPUT'], 45_000)
  }, 300_000)

  afterAll(async () => {
    if (sid) await client.closeSession(sid).catch(() => {})
    resetDb()
    await app.close()
    composeDown()
  })

  it('exec emits 10000 lines of continuous output', async () => {
    const exec = await client.exec(
      sid,
      'i=1; while [ "$i" -le 10000 ]; do echo "line-$i"; i=$((i+1)); done',
      120_000,
    )
    expect(exec.status).toBe(200)
    const body = exec.json as { timedOut: boolean; output: string }
    expect(body.timedOut).toBe(false)
    expect(body.output).toContain('line-1')
    expect(body.output).toContain('line-10000')
    const count = (body.output.match(/^line-\d+$/gm) ?? []).length
    expect(count).toBeGreaterThanOrEqual(9000)
  }, 180_000)

  it('continuous output times out, Ctrl+C recovers, history grew', async () => {
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
    const stateBefore = await client.getState(sid)
    const seqBefore = (stateBefore.json as { lastSeq: number }).lastSeq ?? 0

    // Flood faster than silenceThreshold so waitForStable must time out
    const flood = await client.exec(sid, 'yes extreme-line', 2_000)
    expect((flood.json as { timedOut: boolean }).timedOut).toBe(true)
    expect((flood.json as { output: string }).output).toContain('extreme-line')

    await client.input(sid, '\u0003', false)
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)

    const stateAfter = await client.getState(sid)
    const seqAfter = (stateAfter.json as { lastSeq: number }).lastSeq ?? 0
    expect(seqAfter).toBeGreaterThan(seqBefore)
  }, 90_000)

  it('upload and download 5MB file', async () => {
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
    const size = 5_000_000
    const data = crypto.randomBytes(size)
    const sha = crypto.createHash('sha256').update(data).digest('hex')
    const remote = `/tmp/sp-5mb-${crypto.randomBytes(3).toString('hex')}.bin`

    const up = await client.upload(sid, remote, data, { sha256: sha, timeoutMs: 120_000 })
    expect(up.status).toBe(200)
    expect((up.json as { size: number }).size).toBe(size)
    expect((up.json as { sha256: string }).sha256).toBe(sha)

    const down = await client.download(sid, remote, 120_000)
    expect(down.status).toBe(200)
    expect(down.body.length).toBe(size)
    expect(crypto.createHash('sha256').update(down.body).digest('hex')).toBe(sha)

    await client.exec(sid, `rm -f ${remote}`, 15_000)
  }, 180_000)

  it('rejects upload over transferMaxBytes', async () => {
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
    const over = Buffer.alloc(config.transferMaxBytes + 1, 1)
    const up = await client.upload(sid, '/tmp/sp-over.bin', over, { timeoutMs: 30_000 })
    expect(up.status).toBe(413)
  }, 60_000)

  it('upload download path with spaces and unicode', async () => {
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
    const data = Buffer.from('unicode-path-ok\n')
    const remote = `/tmp/sp space 测试-${crypto.randomBytes(2).toString('hex')}.txt`
    const up = await client.upload(sid, remote, data, { timeoutMs: 60_000 })
    expect(up.status).toBe(200)
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
    const down = await client.download(sid, remote, 60_000)
    expect(down.status, down.body.toString('utf8')).toBe(200)
    expect(down.body.toString()).toBe(data.toString())
    await client.exec(sid, `rm -f -- ${JSON.stringify(remote)}`, 10_000)
  }, 90_000)

  it('rapid sequential exec stays consistent', async () => {
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
    for (let i = 0; i < 10; i++) {
      const r = await client.exec(sid, `echo rapid-${i}`)
      expect(r.status).toBe(200)
      expect((r.json as { output: string }).output).toContain(`rapid-${i}`)
    }
  }, 90_000)
})
