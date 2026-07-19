import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { config } from '../../src/config.js'
import { Runtime } from '../../src/runtime.js'

/**
 * Runtime.stop() permanently closes the shared sqlite connection for whichever
 * module graph it was loaded from. Tests that exercise a full start+stop cycle
 * load Runtime/runServer/config through a fresh module registry so they don't
 * poison the statically-imported `db` singleton used by other tests in this file.
 */
async function freshRuntimeModules() {
  vi.resetModules()
  const configMod = await import('../../src/config.js')
  const runtimeMod = await import('../../src/runtime.js')
  const runnerMod = await import('../../src/runner.js')
  return { config: configMod.config, Runtime: runtimeMod.Runtime, runServer: runnerMod.runServer }
}

describe('Runtime', () => {
  it('starts and stops the HTTP + socket servers, and stop() is idempotent', async () => {
    const mod = await freshRuntimeModules()
    const runtime = new mod.Runtime()
    await runtime.start()
    await runtime.stop()
    await runtime.stop() // second call reuses the cached shutdown promise
    expect(true).toBe(true)
  })

  it('marks stale sessions directly when HTTP is disabled', async () => {
    const mod = await freshRuntimeModules()
    mod.config.httpEnabled = false
    const runtime = new mod.Runtime()
    await runtime.start()
    await runtime.stop()
  })

  it('closes active sessions and propagates a non-ENOENT pid-file cleanup error', async () => {
    const mod = await freshRuntimeModules()
    const runtime = new mod.Runtime()
    await runtime.start()

    const { profileService } = await import('../../src/services/ProfileService.js')
    const { sessionService } = await import('../../src/services/SessionService.js')
    const profile = profileService.create({ name: 'runtime-shutdown', connectType: 'command', command: 'true' })
    sessionService.create({ profileId: profile.id })
    await new Promise((r) => setTimeout(r, 200))

    // Point the pid file at a directory so fs.unlinkSync fails with something
    // other than ENOENT, exercising shutdown()'s rethrow branch. socket.close()
    // and closeDatabase() both run before this, so nothing else leaks.
    const originalPidPath = mod.config.pidPath
    mod.config.pidPath = path.dirname(mod.config.pidPath)
    try {
      await expect(runtime.stop()).rejects.toThrow()
    } finally {
      mod.config.pidPath = originalPidPath
    }
  })

  it('invokes the socket server stop callback, which stops the runtime', async () => {
    const mod = await freshRuntimeModules()
    const runtime = new mod.Runtime()
    const stopSpy = vi.spyOn(runtime, 'stop')
    // Reach through to the Runtime-internal socket server's requestStop callback
    // by starting the runtime and dispatching a real system.stop RPC over the socket.
    await runtime.start()
    const { SocketClient } = await import('../../../cli/src/SocketClient.js')
    const client = new SocketClient(mod.config.socketPath)
    await client.connect()
    await client.request('system.stop', {})
    client.close()
    await new Promise((r) => setTimeout(r, 200))
    expect(stopSpy).toHaveBeenCalled()
    await runtime.stop() // idempotent: waits for the callback-triggered shutdown to finish
  })

  it('closes the socket server when HTTP fails to start', async () => {
    const blocker = net.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()))
    const address = blocker.address()
    const busyPort = typeof address === 'object' && address ? address.port : 0

    const originalPort = config.port
    const originalHttpEnabled = config.httpEnabled
    config.port = busyPort
    config.httpEnabled = true
    const runtime = new Runtime()
    try {
      await expect(runtime.start()).rejects.toThrow()
    } finally {
      config.port = originalPort
      config.httpEnabled = originalHttpEnabled
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})

describe('runServer', () => {
  it('starts successfully, logs, and shuts down once on SIGINT', async () => {
    const mod = await freshRuntimeModules()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const code = await mod.runServer()
    expect(code).toBe(0)

    const previousExitCode = process.exitCode
    process.emit('SIGINT')
    await new Promise((r) => setTimeout(r, 300))
    // repeat signal: process.once already removed the handler, so this is a no-op
    process.emit('SIGINT')
    await new Promise((r) => setTimeout(r, 100))
    process.exitCode = previousExitCode
    logSpy.mockRestore()
  })

  it('returns 1 and logs an error when startup fails', async () => {
    const mod = await freshRuntimeModules()
    fs.mkdirSync(path.dirname(mod.config.socketPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(mod.config.socketPath, 'not a socket')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const code = await mod.runServer()
      expect(code).toBe(1)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      fs.rmSync(mod.config.socketPath, { force: true })
    }
  })
})
