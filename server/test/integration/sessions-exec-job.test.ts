import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { TestClient, waitForState } from '../helpers/client.js'
import { resetDb } from '../helpers/resetDb.js'

async function createReadySession(client: TestClient): Promise<string> {
  const profile = await client.createProfile({
    name: `exec-job-${Date.now()}`,
    connectType: 'command',
    command: "bash --norc --noprofile -c 'export PS1=\"$ \"; exec bash --norc --noprofile'",
    promptRegex: '[$#]\\s*$',
  })
  expect(profile.status).toBe(201)
  const profileId = (profile.json as { id: string }).id
  const session = await client.createSession(profileId)
  expect(session.status).toBe(201)
  const sid = (session.json as { id: string }).id
  await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
  return sid
}

describe('sessions exec job model', () => {
  let app: FastifyInstance
  let client: TestClient

  beforeEach(async () => {
    resetDb()
    app = await buildApp({ logger: false, skipMarkStale: true })
    client = new TestClient({ kind: 'inject', app }, 'test-token')
  })

  afterEach(async () => {
    resetDb()
    await app.close()
  })

  it('detach → poll → DONE with incremental output', async () => {
    const sid = await createReadySession(client)
    const start = await client.execStart(sid, 'echo job-hello; sleep 0.3; echo job-bye')
    expect(start.status).toBe(200)
    const startBody = start.json as { jobId: string; status: string; startSeq: number }
    expect(startBody.jobId).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{8}$/)
    expect(startBody.status).toBe('RUNNING')

    let cursor = startBody.startSeq
    let done = false
    let lastOutput = ''
    const deadline = Date.now() + 20_000
    while (!done && Date.now() < deadline) {
      const status = await client.execStatus(sid, startBody.jobId, cursor, 2000)
      expect(status.status).toBe(200)
      const body = status.json as {
        job: { status: string }
        output: string
        cursor: number
        done: boolean
      }
      lastOutput += body.output
      cursor = body.cursor
      done = body.done
      if (!done) expect(['RUNNING', 'TIMED_OUT']).toContain(body.job.status)
    }
    expect(done).toBe(true)
    expect(lastOutput).toContain('job-hello')
    expect(lastOutput).toContain('job-bye')

    await client.closeSession(sid)
  }, 60_000)

  it('sync exec timeout returns jobId and cursor for polling', async () => {
    const sid = await createReadySession(client)
    const exec = await client.exec(sid, 'sleep 5; echo late', 1000)
    expect(exec.status).toBe(200)
    const body = exec.json as {
      jobId: string
      status: string
      timedOut: boolean
      cursor: number
      startSeq: number
    }
    expect(body.timedOut).toBe(true)
    expect(body.status).toBe('TIMED_OUT')
    expect(body.jobId).toBeTruthy()
    expect(body.cursor).toBeGreaterThanOrEqual(body.startSeq)

    // Poll until the sleep finishes
    let cursor = body.startSeq
    let done = false
    let output = ''
    const deadline = Date.now() + 20_000
    while (!done && Date.now() < deadline) {
      const status = await client.execStatus(sid, body.jobId, cursor, 2000)
      const st = status.json as { job: { status: string }; output: string; cursor: number; done: boolean }
      output += st.output
      cursor = st.cursor
      done = st.done
    }
    expect(done).toBe(true)
    expect(output).toContain('late')

    await client.closeSession(sid)
  }, 60_000)

  it('409 while a job is active includes the job id', async () => {
    const sid = await createReadySession(client)
    const start = await client.execStart(sid, 'sleep 8; echo done')
    const jobId = (start.json as { jobId: string }).jobId

    // Retry briefly until the runner has acquired the opLock
    let message = ''
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const conflict = await client.exec(sid, 'echo should-fail', 1000)
      expect(conflict.status).toBe(409)
      message = String((conflict.json as { error?: string }).error ?? '')
      if (message.includes(jobId)) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(message).toContain(jobId)
    expect(message).toMatch(/exec-status|exec-cancel/)

    await client.execCancel(sid, jobId)
    // Wait for session to recover after Ctrl+C
    await waitForState(client, sid, ['WAITING_INPUT', 'IDLE'], 15_000).catch(() => {})
    await client.closeSession(sid)
  }, 60_000)

  it('exec-cancel marks the job CANCELED', async () => {
    const sid = await createReadySession(client)
    const start = await client.execStart(sid, 'sleep 30')
    const jobId = (start.json as { jobId: string }).jobId
    await new Promise((r) => setTimeout(r, 200))

    const canceled = await client.execCancel(sid, jobId)
    expect(canceled.status).toBe(200)
    expect((canceled.json as { status: string }).status).toBe('CANCELED')

    const status = await client.execStatus(sid, jobId, 0, 0)
    expect((status.json as { job: { status: string }; done: boolean }).done).toBe(true)
    expect((status.json as { job: { status: string } }).job.status).toBe('CANCELED')

    await waitForState(client, sid, ['WAITING_INPUT', 'IDLE', 'DISCONNECTED'], 15_000).catch(() => {})
    await client.closeSession(sid)
  }, 60_000)

  it('returns 404 for unknown job id', async () => {
    const sid = await createReadySession(client)
    const status = await client.execStatus(sid, 'notajob1', 0, 0)
    expect(status.status).toBe(404)
    const cancel = await client.execCancel(sid, 'notajob1')
    expect(cancel.status).toBe(404)
    await client.closeSession(sid)
  }, 60_000)
})
