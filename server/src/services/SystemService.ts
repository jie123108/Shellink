import { GIT_COMMIT, PROTOCOL_VERSION, RPC_METHODS, VERSION } from '@shellink/protocol'
import { config, webUiUrl } from '../config.js'
import { sessionManager } from '../core/SessionManager.js'

export class SystemService {
  constructor(private readonly requestStop: () => void = () => {}) {}

  hello() {
    return {
      serviceVersion: VERSION,
      serviceCommit: GIT_COMMIT,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: RPC_METHODS,
    }
  }
  ping() { return { pong: true, at: Date.now() } }
  status() {
    const sessions = sessionManager.list()
    return {
      version: VERSION,
      commit: GIT_COMMIT,
      protocolVersion: PROTOCOL_VERSION,
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      socketPath: config.socketPath,
      httpEnabled: config.httpEnabled,
      httpUrl: config.httpEnabled ? `http://${config.host}:${config.port}` : null,
      webui: config.httpEnabled ? { url: webUiUrl() } : null,
      activeSessions: sessions.filter((item) => item.active).length,
    }
  }
  stop() { setImmediate(this.requestStop); return { stopping: true } }
}
