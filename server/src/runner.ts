import { config, webUiUrl } from './config.js'
import { Runtime } from './runtime.js'

export async function runServer(): Promise<number> {
  const runtime = new Runtime()
  let shuttingDown = false

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[Shellink] Received ${signal}; shutting down`)
    try { await runtime.stop(); process.exitCode = 0 }
    catch (error) { console.error('[Shellink] Shutdown failed', error); process.exitCode = 1 }
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))

  try {
    await runtime.start()
    console.log(`[Shellink] Unix socket: ${config.socketPath}`)
    if (config.httpEnabled) {
      console.log(`[Shellink] HTTP: http://${config.host}:${config.port}`)
      console.log(`[Shellink] Web UI: ${webUiUrl()}`)
    }
    return 0
  } catch (error) {
    console.error('[Shellink] Startup failed:', error instanceof Error ? error.message : error)
    return 1
  }
}
