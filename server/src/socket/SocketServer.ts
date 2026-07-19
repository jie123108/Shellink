import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { AppError, FrameDecoder, FrameKind, ProtocolError, RpcErrorCode, encodeFrame, type RpcEvent, type RpcRequest, type RpcResponse } from '@shellink/protocol'
import { config } from '../config.js'
import { sessionService } from '../services/SessionService.js'
import { SystemService } from '../services/SystemService.js'
import { RpcDispatcher, eventBus, subscriptionEventNames, type SubscriptionEventName, type SubscriptionSink } from './RpcDispatcher.js'

interface Subscription { cleanup: () => void }

async function socketIsLive(socketPath: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection(socketPath)
    const finish = (live: boolean) => { socket.destroy(); resolve(live) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(300, () => finish(false))
  })
}

export class ShellinkSocketServer {
  private readonly server = net.createServer((socket) => this.handle(socket))
  private readonly connections = new Set<net.Socket>()
  private inode: number | null = null
  private dispatcher: RpcDispatcher

  constructor(requestStop: () => void) {
    this.dispatcher = new RpcDispatcher(new SystemService(requestStop))
  }

  async listen(): Promise<void> {
    const dir = path.dirname(config.socketPath)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
    if (fs.existsSync(config.socketPath)) {
      const stat = fs.lstatSync(config.socketPath)
      if (!stat.isSocket()) throw new Error(`Refusing to remove a non-socket path: ${config.socketPath}`)
      if (await socketIsLive(config.socketPath)) throw new Error('Shellink daemon is already running')
      fs.unlinkSync(config.socketPath)
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off('listening', onListening); reject(error) }
      const onListening = () => { this.server.off('error', onError); resolve() }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(config.socketPath)
    })
    fs.chmodSync(config.socketPath, 0o600)
    this.inode = fs.lstatSync(config.socketPath).ino
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      setTimeout(() => {
        for (const socket of this.connections) socket.destroy()
      }, 100).unref()
    })
    try {
      const stat = fs.lstatSync(config.socketPath)
      if (stat.isSocket() && stat.ino === this.inode) fs.unlinkSync(config.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private handle(socket: net.Socket): void {
    this.connections.add(socket)
    const decoder = new FrameDecoder(config.maxFrameBytes)
    let helloComplete = false
    let closing = false
    const subscriptions = new Map<string, Subscription>()

    const send = (kind: FrameKind, payload: unknown): boolean => {
      if (socket.destroyed || closing) return false
      const frame = encodeFrame(kind, payload, config.maxFrameBytes)
      if (socket.writableLength + frame.length > config.socketMaxQueueBytes) {
        closing = true
        socket.destroy(new Error('socket client write queue exceeded'))
        return false
      }
      socket.write(frame)
      return true
    }

    const sink: SubscriptionSink = {
      addSubscription: (sessionId, replay) => {
        const subscriptionId = crypto.randomUUID()
        const handlers: Array<[SubscriptionEventName, (event: any) => void]> = []
        for (const name of subscriptionEventNames) {
          const handler = (data: any) => {
            if (sessionId && data.sessionId !== sessionId) return
            if (name === 'session.data' && data.direction !== 'output') return
            const event: RpcEvent = { subscriptionId, event: name, data }
            if (typeof data.seq === 'number') event.seq = data.seq
            send(FrameKind.Event, event)
          }
          eventBus().on(name, handler)
          handlers.push([name, handler])
        }
        const cleanup = () => { for (const [name, handler] of handlers) eventBus().off(name, handler) }
        subscriptions.set(subscriptionId, { cleanup })
        let initial: unknown = { sessions: sessionService.list() }
        if (sessionId) initial = { state: sessionService.state(sessionId), replay: replay ? sessionService.rawHistory(sessionId) : undefined }
        return { subscriptionId, initial }
      },
      removeSubscription: (id) => {
        const subscription = subscriptions.get(id)
        if (!subscription) return false
        subscription.cleanup(); subscriptions.delete(id); return true
      },
    }

    socket.on('data', (chunk) => {
      try {
        for (const frame of decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) {
          if (frame.kind !== FrameKind.Request) throw new ProtocolError('Client may only send request frames')
          const request = frame.payload as Partial<RpcRequest>
          if ((typeof request.id !== 'string' && typeof request.id !== 'number') || typeof request.method !== 'string') throw new ProtocolError('Invalid request envelope')
          if (!helloComplete && request.method !== 'system.hello') throw new ProtocolError('First request must be system.hello')
          void this.dispatcher.dispatch(request.method, request.params, sink).then((result) => {
            if (request.method === 'system.hello') helloComplete = true
            send(FrameKind.Response, { id: request.id!, ok: true, result } satisfies RpcResponse)
          }).catch((error) => {
            const appError = error instanceof AppError ? error : new AppError(RpcErrorCode.INTERNAL_ERROR, error instanceof Error ? error.message : 'Internal error', 500)
            send(FrameKind.Response, { id: request.id!, ok: false, error: appError.toJSON() } satisfies RpcResponse)
            if (request.method === 'system.hello') setImmediate(() => socket.destroy())
          })
        }
      } catch (error) {
        const appError = new AppError(RpcErrorCode.PROTOCOL_ERROR, error instanceof Error ? error.message : 'Protocol error', 400)
        send(FrameKind.Response, { id: 0, ok: false, error: appError.toJSON() })
        setImmediate(() => socket.destroy())
      }
    })
    socket.on('end', () => { try { decoder.finish() } catch { socket.destroy() } })
    socket.on('error', () => {})
    socket.on('close', () => {
      this.connections.delete(socket)
      for (const subscription of subscriptions.values()) subscription.cleanup()
      subscriptions.clear()
    })
  }
}
