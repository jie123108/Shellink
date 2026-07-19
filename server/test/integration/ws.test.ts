import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { setupWsGateway } from '../../src/ws/gateway.js'
import { TestClient, waitForState } from '../helpers/client.js'
import { resetDb } from '../helpers/resetDb.js'

function openWs(
  url: string,
  onMessage: (data: string) => void,
  timeoutMs = 5_000,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    // Attach before open so we never miss the immediate replay/status frames
    ws.on('message', (buf) => onMessage(buf.toString()))
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`WebSocket open timeout: ${url}`))
    }, timeoutMs)
    ws.once('open', () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

describe('websocket gateway', () => {
  let app: FastifyInstance
  let baseUrl: string
  let wsBase: string
  let client: TestClient

  beforeAll(async () => {
    resetDb()
    app = await buildApp({ logger: false, skipMarkStale: true })
    await app.listen({ port: 0, host: '127.0.0.1' })
    setupWsGateway(app.server)
    const addr = app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    baseUrl = `http://127.0.0.1:${port}`
    wsBase = `ws://127.0.0.1:${port}`
    client = new TestClient({ kind: 'http', baseUrl }, 'test-token')
  })

  afterAll(async () => {
    resetDb()
    await app.close()
  })

  it('replays history and receives live data', async () => {
    const profile = await client.createProfile({
      name: 'ws-bash',
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

    const termMsgs: Array<{ type: string; data?: string; state?: string }> = []
    const termWs = await openWs(`${wsBase}/shellink/ws/sessions/${sid}?token=test-token`, (raw) => {
      termMsgs.push(JSON.parse(raw))
    })

    const evWs = await openWs(`${wsBase}/shellink/ws/events?token=test-token`, () => {})

    await new Promise((r) => setTimeout(r, 50))
    expect(termMsgs.some((m) => m.type === 'replay')).toBe(true)
    expect(termMsgs.some((m) => m.type === 'status')).toBe(true)

    await client.exec(sid, 'echo ws-live')
    await new Promise((r) => setTimeout(r, 400))
    expect(termMsgs.some((m) => m.type === 'data' && (m.data ?? '').includes('ws-live'))).toBe(true)

    await client.setMode(sid, 'MANUAL')
    termWs.send(JSON.stringify({ type: 'input', data: 'echo from-ws\n' }))
    await new Promise((r) => setTimeout(r, 500))

    await client.closeSession(sid)
    await new Promise((r) => setTimeout(r, 200))

    termWs.close()
    evWs.close()
  }, 45_000)
})
