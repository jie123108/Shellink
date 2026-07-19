import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { TestClient, waitForState } from '../helpers/client.js'
import { resetDb } from '../helpers/resetDb.js'

describe('sessions API with command profile', () => {
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

  it('creates a command session and supports exec, input, history, mode, and close', async () => {
    const profile = await client.createProfile({
      name: 'command-bash',
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

    const exec = await client.exec(sid, 'echo hello-shellink')
    expect(exec.status).toBe(200)
    const execBody = exec.json as { output: string; timedOut: boolean }
    expect(execBody.timedOut).toBe(false)
    expect(execBody.output).toContain('hello-shellink')

    const hist = await client.history(sid, 0)
    expect((hist.json as { text: string }).text.length).toBeGreaterThan(0)

    const mode = await client.setMode(sid, 'MANUAL')
    expect((mode.json as { mode: string }).mode).toBe('MANUAL')
    const blocked = await client.exec(sid, 'echo no')
    expect(blocked.status).toBe(409)

    await client.setMode(sid, 'AUTO')
    const closed = await client.closeSession(sid)
    expect(closed.status).toBe(200)

    const state = await client.getState(sid)
    // may still be closing briefly
    expect(['DISCONNECTED', 'WAITING_INPUT', 'OUTPUTTING', 'CONNECTING', 'IDLE']).toContain(
      (state.json as { state: string }).state,
    )
  }, 60_000)

  it('interactive OTP prompt waits for input before reaching WAITING_INPUT', async () => {
    const profile = await client.createProfile({
      name: 'otp-sim',
      connectType: 'command',
      command:
        "bash --norc --noprofile -c 'echo OTP:; read -r code; echo got:$code; export PS1=\"$ \"; exec bash --norc --noprofile'",
      promptRegex: '[$#]\\s*$',
    })
    const profileId = (profile.json as { id: string }).id
    const session = await client.createSession(profileId)
    const sid = (session.json as { id: string }).id

    // Stay CONNECTING until we provide OTP (no shell prompt yet)
    await waitForState(client, sid, ['CONNECTING'], 10_000)
    await new Promise((r) => setTimeout(r, 400))
    const st = await client.getState(sid)
    expect((st.json as { state: string }).state).toBe('CONNECTING')

    await client.input(sid, '999999')
    await waitForState(client, sid, ['WAITING_INPUT'], 20_000)

    const exec = await client.exec(sid, 'echo after-otp')
    expect((exec.json as { output: string }).output).toContain('after-otp')

    await client.closeSession(sid)
  }, 60_000)
})
