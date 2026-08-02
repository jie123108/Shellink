import type { Server as HttpServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { checkToken, isLocalRequest } from '../api/auth.js'
import { bus } from '../core/events.js'
import {
  collapseBase64Payloads,
  createBase64CollapseStream,
} from '../core/collapseBase64.js'
import { sessionManager } from '../core/SessionManager.js'
import { sessionService } from '../services/SessionService.js'

/**
 * WebSocket gateway:
 * - /shellink/ws/sessions/{id}?token=xxx: per-session terminal stream
 * - /shellink/ws/events?token=xxx: global session-state event stream
 */
export function setupWsGateway(server: HttpServer): void {
  const terminalWss = new WebSocketServer({ noServer: true })
  const eventsWss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const ok = isLocalRequest(req) || checkToken(url.searchParams.get('token') ?? undefined)
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const terminalMatch = url.pathname.match(/^\/shellink\/ws\/sessions\/([\w-]+)$/)
    if (terminalMatch) {
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminalConnection(ws, terminalMatch[1])
      })
      return
    }
    if (url.pathname === '/shellink/ws/events') {
      eventsWss.handleUpgrade(req, socket, head, (ws) => {
        handleEventsConnection(ws)
      })
      return
    }
    socket.destroy()
  })
}

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
}

function handleTerminalConnection(ws: WebSocket, sessionId: string): void {
  const live = sessionManager.get(sessionId)
  // Collapse large upload/download base64 payloads in the live stream.
  const liveCollapse = createBase64CollapseStream()
  // Hide transfer/edit protocol traffic from the live xterm; announce transitions only.
  let hidingInternal = false

  // Replay collapsed history before attaching the live stream.
  let replay = ''
  try { replay = collapseBase64Payloads(sessionService.rawHistory(sessionId)) } catch {}
  send(ws, { type: 'replay', data: replay })
  send(ws, {
    type: 'status',
    state: live?.state ?? 'DISCONNECTED',
    mode: live?.mode ?? 'AUTO',
  })

  const onData = (e: { sessionId: string; direction: string; raw: string; internal?: boolean }) => {
    if (e.sessionId !== sessionId || e.direction !== 'output') return
      if (e.internal) {
      if (!hidingInternal) {
        hidingInternal = true
        send(ws, { type: 'data', data: '\r\n[shellink] file transfer in progress...\r\n' })
      }
      return
    }
    if (hidingInternal) {
      hidingInternal = false
      send(ws, { type: 'data', data: '\r\n[shellink] transfer output hidden\r\n' })
    }
    const data = liveCollapse.push(e.raw)
    if (data) send(ws, { type: 'data', data })
  }
  const onState = (e: { sessionId: string; state: string }) => {
    if (e.sessionId !== sessionId) return
    send(ws, { type: 'state', state: e.state })
  }
  const onMode = (e: { sessionId: string; mode: string }) => {
    if (e.sessionId !== sessionId) return
    send(ws, { type: 'mode', mode: e.mode })
  }
  const onClosed = (e: { sessionId: string; reason: string }) => {
    if (e.sessionId !== sessionId) return
    const leftover = liveCollapse.flush()
    if (leftover) send(ws, { type: 'data', data: leftover })
    send(ws, { type: 'closed', reason: e.reason })
  }

  bus.on('session.data', onData)
  bus.on('session.state', onState)
  bus.on('session.mode', onMode)
  bus.on('session.closed', onClosed)

  ws.on('message', (buf) => {
    let msg: { type?: string; data?: string; cols?: number; rows?: number }
    try {
      msg = JSON.parse(buf.toString())
    } catch {
      return
    }
    const session = sessionManager.get(sessionId)
    if (!session) return

    if (msg.type === 'input' && typeof msg.data === 'string') {
      // MANUAL accepts human input; CONNECTING accepts OTP; AUTO+WAITING_INPUT matches REST.
      try { sessionService.terminalInput(sessionId, msg.data) } catch {}
      return
    }
    if (msg.type === 'resize' && msg.cols && msg.rows) {
      try { sessionService.resize(sessionId, msg.cols, msg.rows) } catch {}
    }
  })

  ws.on('close', () => {
    liveCollapse.flush()
    bus.off('session.data', onData)
    bus.off('session.state', onState)
    bus.off('session.mode', onMode)
    bus.off('session.closed', onClosed)
  })
}

function handleEventsConnection(ws: WebSocket): void {
  const forward = (type: string) => (e: object) => {
    send(ws, { type, ...e })
  }
  const onCreated = forward('created')
  const onState = forward('state')
  const onMode = forward('mode')
  const onClosed = forward('closed')
  const onExternal = forward('loginExternal')
  const onWebhookReceived = forward('webhookReceived')

  bus.on('session.created', onCreated)
  bus.on('session.state', onState)
  bus.on('session.mode', onMode)
  bus.on('session.closed', onClosed)
  bus.on('session.loginExternal', onExternal)
  bus.on('webhook.received', onWebhookReceived)

  ws.on('close', () => {
    bus.off('session.created', onCreated)
    bus.off('session.state', onState)
    bus.off('session.mode', onMode)
    bus.off('session.closed', onClosed)
    bus.off('session.loginExternal', onExternal)
    bus.off('webhook.received', onWebhookReceived)
  })
}
