import fs from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'
import { config } from './config.js'
import { sessionManager } from './core/SessionManager.js'
import { closeDatabase } from './db/index.js'
import { ShellinkSocketServer } from './socket/SocketServer.js'
import { setupWsGateway } from './ws/gateway.js'

export class Runtime {
  private http: FastifyInstance | null = null
  private readonly socket = new ShellinkSocketServer(() => void this.stop())
  private stopping: Promise<void> | null = null

  async start(): Promise<void> {
    await this.socket.listen()
    try {
      if (config.httpEnabled) {
        this.http = await buildApp()
        await this.http.listen({ port: config.port, host: config.host })
        setupWsGateway(this.http.server)
      } else {
        sessionManager.markStaleSessions()
      }
      fs.writeFileSync(config.pidPath, `${process.pid}\n`, { mode: 0o600 })
    } catch (error) {
      await this.socket.close()
      throw error
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = this.shutdown()
    return this.stopping
  }

  private async shutdown(): Promise<void> {
    await this.socket.close()
    if (this.http) await this.http.close()
    for (const item of sessionManager.list()) {
      if (!item.active || typeof item.id !== 'string') continue
      sessionManager.get(item.id)?.close('Shellink daemon shut down')
    }
    closeDatabase()
    try { fs.unlinkSync(config.pidPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
