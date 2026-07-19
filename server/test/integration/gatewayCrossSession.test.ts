import { describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import { buildApp } from '../../src/app.js'
import { setupWsGateway } from '../../src/ws/gateway.js'
import { TestClient, waitForState } from '../helpers/client.js'
import { resetDb } from '../helpers/resetDb.js'
import { sleep } from '../helpers/wait.js'

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

async function createBashSession(client: TestClient, name: string) {
  const profile = await client.createProfile({
    name,
    connectType: 'command',
    command: "bash --norc --noprofile -c 'export PS1=\"$ \"; exec bash --norc --noprofile'",
      promptRegex: '[$#]\\s*$',
  })
  const sid = ((await client.createSession((profile.json as { id: string }).id)).json as { id: string }).id
  await waitForState(client, sid, ['WAITING_INPUT'], 20_000)
  return sid
}

describe('WS gateway cross-session isolation', () => {
  it('does not leak state/mode/closed events from another session, and ignores messages for a gone session', async () => {
    resetDb()
    const app: FastifyInstance = await buildApp({ logger: false, skipMarkStale: true })
    await app.listen({ port: 0, host: '127.0.0.1' })
    setupWsGateway(app.server)
    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const client = new TestClient({ kind: 'http', baseUrl: `http://127.0.0.1:${port}` }, 'test-token')

    const sidA = await createBashSession(client, 'gw-cross-a')
    const sidB = await createBashSession(client, 'gw-cross-b')

    const msgsA: Array<{ type: string; state?: string; mode?: string; reason?: string }> = []
    const wsA = await openWs(`ws://127.0.0.1:${port}/shellink/ws/sessions/${sidA}?token=test-token`)
    wsA.on('message', (buf) => msgsA.push(JSON.parse(buf.toString())))
    await sleep(50)
    msgsA.length = 0 // drop the initial replay/status frames

    // Session B's mode/state/close events must not reach A's socket.
    await client.setMode(sidB, 'MANUAL')
    await sleep(100)
    expect(msgsA.some((m) => m.type === 'mode')).toBe(false)

    await client.closeSession(sidB)
    await sleep(200)
    expect(msgsA.some((m) => m.type === 'closed')).toBe(false)
    expect(msgsA.some((m) => m.type === 'state')).toBe(false)

    // A's own mode/close events (matching branch) should still arrive.
    await client.setMode(sidA, 'MANUAL')
    await sleep(100)
    expect(msgsA.some((m) => m.type === 'mode')).toBe(true)

    await client.closeSession(sidA)
    await sleep(200)
    expect(msgsA.some((m) => m.type === 'closed')).toBe(true)
    await client.removeRecord(sidA)

    // The underlying session record is gone now; further ws input/resize
    // messages must hit the "session not found" early return without throwing.
    expect(() => wsA.send(JSON.stringify({ type: 'input', data: 'echo hi\n' }))).not.toThrow()
    expect(() => wsA.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))).not.toThrow()
    await sleep(100)

          wsA.close()
          resetDb()
          await app.close()
        }, 45_000)

        it('reports DISCONNECTED/AUTO defaults for a terminal socket on an unknown session id', async () => {
          resetDb()
          const app: FastifyInstance = await buildApp({ logger: false, skipMarkStale: true })
          await app.listen({ port: 0, host: '127.0.0.1' })
          setupWsGateway(app.server)
          const addr = app.server.address()
          const port = typeof addr === 'object' && addr ? addr.port : 0

          // The server sends the initial replay/status frames as soon as the
          // upgrade completes, which can race the client's own 'open' handler.
          // Attach the message listener before waiting for 'open' so nothing is missed.
          const msgs: Array<{ type: string; state?: string; mode?: string; data?: string }> = []
          const ws = await new Promise<WebSocket>((resolve, reject) => {
            const socket = new WebSocket(
              `ws://127.0.0.1:${port}/shellink/ws/sessions/does-not-exist?token=test-token`,
            )
            socket.on('message', (buf) => msgs.push(JSON.parse(buf.toString())))
            socket.once('open', () => resolve(socket))
            socket.once('error', reject)
          })
          await sleep(80)

          const replay = msgs.find((m) => m.type === 'replay')
          const status = msgs.find((m) => m.type === 'status')
          expect(replay?.data).toBe('')
          expect(status?.state).toBe('DISCONNECTED')
          expect(status?.mode).toBe('AUTO')

          // Messages against a session that never existed should hit the early
          // "session not found" return without throwing.
          ws.send(JSON.stringify({ type: 'input', data: 'echo hi\n' }))
          ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
          await sleep(50)

          ws.close()
          resetDb()
          await app.close()
        })
      })
