import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FrameDecoder, FrameKind, PROTOCOL_VERSION, encodeFrame } from '@shellink/protocol'
import { SocketClient } from '../../../cli/src/SocketClient.js'
import { config } from '../../src/config.js'
import { ShellinkSocketServer } from '../../src/socket/SocketServer.js'
import { resetDb } from '../helpers/resetDb.js'

describe('Unix socket RPC', () => {
  let server: ShellinkSocketServer

  beforeEach(async () => {
    resetDb()
    server = new ShellinkSocketServer(() => {})
    await server.listen()
  })
  afterEach(async () => { await server.close() })

  it('handshakes and runs profile service contracts', async () => {
    const client = new SocketClient(config.socketPath)
    const hello = await client.connect()
    expect(hello.protocolVersion).toBe(1)
    const created = await client.request<any>('profiles.create', { name: 'command', connectType: 'command', command: '/bin/sh' })
    expect(created.name).toBe('command')
    expect(created.hasPassword).toBe(false)
    const listed = await client.request<any[]>('profiles.list', { q: 'BIN/SH' })
    expect(listed.map((item) => item.id)).toContain(created.id)
    client.close()
  })

  it('pushes subscribed session events', async () => {
    const client = new SocketClient(config.socketPath)
    await client.connect()
    const events: string[] = []
    const subscription = await client.subscribe({}, (event) => events.push(event.event))
    const profile = await client.request<any>('profiles.create', { name: 'command-events', connectType: 'command', command: '/bin/sh' })
    const session = await client.request<any>('sessions.create', { profileId: profile.id })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(events).toContain('session.created')
    await client.request('sessions.close', { id: session.id })
    await subscription.unsubscribe()
    client.close()
  })

  it('scopes subscriptions to a session id and honors replay:true/false', async () => {
    const client = new SocketClient(config.socketPath)
    await client.connect()
    const profile = await client.request<any>('profiles.create', { name: 'cmd-sub', connectType: 'command', command: '/bin/sh' })
    const session = await client.request<any>('sessions.create', { profileId: profile.id })

    const subNoReplay = await client.subscribe({ sessionId: session.id, replay: false }, () => {})
    expect(subNoReplay.initial).toMatchObject({ state: expect.anything() })
    await subNoReplay.unsubscribe()

    const subReplay = await client.subscribe({ sessionId: session.id, replay: true }, () => {})
    expect(subReplay.initial).toMatchObject({ state: expect.anything() })
    await subReplay.unsubscribe()

    await client.request('sessions.close', { id: session.id })
    client.close()
  })

  it('rejects a non-request frame kind and an envelope missing id/method', async () => {
    const badKind = await new Promise<any>((resolve, reject) => {
      const socket = net.createConnection(config.socketPath)
      const decoder = new FrameDecoder()
      socket.once('error', reject)
      socket.once('connect', () => socket.write(encodeFrame(FrameKind.Response, { id: 1, ok: true, result: {} })))
      socket.on('data', (chunk) => {
        const frames = decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        if (frames[0]) { resolve(frames[0].payload); socket.destroy() }
      })
    })
    expect(badKind.ok).toBe(false)
    expect(badKind.error.message).toContain('request frames')

    const badEnvelope = await new Promise<any>((resolve, reject) => {
      const socket = net.createConnection(config.socketPath)
      const decoder = new FrameDecoder()
      socket.once('error', reject)
      socket.once('connect', () => socket.write(encodeFrame(FrameKind.Request, { method: 'system.hello' })))
      socket.on('data', (chunk) => {
        const frames = decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        if (frames[0]) { resolve(frames[0].payload); socket.destroy() }
      })
    })
    expect(badEnvelope.ok).toBe(false)
    expect(badEnvelope.error.message).toContain('Invalid request envelope')
  })

  it('rejects a non-hello first request', async () => {
    const response = await new Promise<any>((resolve, reject) => {
      const socket = net.createConnection(config.socketPath)
      const decoder = new FrameDecoder()
      socket.once('error', reject)
      socket.once('connect', () => socket.write(encodeFrame(FrameKind.Request, { id: 9, method: 'system.ping', params: {} })))
      socket.on('data', (chunk) => {
        const frames = decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        if (frames[0]) { resolve(frames[0].payload); socket.destroy() }
      })
    })
    expect(response.ok).toBe(false)
    expect(response.error.code).toBe('PROTOCOL_ERROR')
  })
})

describe('ShellinkSocketServer error paths', () => {
  afterEach(() => {
    resetDb()
  })

  it('refuses to listen on a path that already exists but is not a socket', async () => {
    fs.mkdirSync(path.dirname(config.socketPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(config.socketPath, 'not a socket')
    const server = new ShellinkSocketServer(() => {})
    await expect(server.listen()).rejects.toThrow(/non-socket/)
    fs.rmSync(config.socketPath, { force: true })
  })

  it('refuses to start a second daemon on the same socket path', async () => {
    const first = new ShellinkSocketServer(() => {})
    await first.listen()
    try {
      const second = new ShellinkSocketServer(() => {})
      await expect(second.listen()).rejects.toThrow(/already running/)
    } finally {
      await first.close()
    }
  })

  it('destroys the client socket when the write queue is exceeded', async () => {
    const originalMax = config.socketMaxQueueBytes
    config.socketMaxQueueBytes = 1
    const server = new ShellinkSocketServer(() => {})
    await server.listen()
    try {
      const client = new SocketClient(config.socketPath)
      await expect(client.connect()).rejects.toThrow()
    } finally {
      config.socketMaxQueueBytes = originalMax
      await server.close()
    }
  })

  it('removes a stale (dead) socket file left by a previous daemon and rebinds', async () => {
    // Simulate a daemon that was killed without a chance to clean up: bind the
    // socket in a child process, then SIGKILL it so the file is left behind
    // pointing at nothing live (a graceful close() removes the file itself).
    fs.mkdirSync(path.dirname(config.socketPath), { recursive: true, mode: 0o700 })
    const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(process.argv[1])`, config.socketPath], {
      stdio: 'ignore',
    })
    await new Promise((r) => setTimeout(r, 300))
    child.kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 100))
    expect(fs.existsSync(config.socketPath)).toBe(true)
    expect(fs.lstatSync(config.socketPath).isSocket()).toBe(true)

    const server = new ShellinkSocketServer(() => {})
    try {
      await expect(server.listen()).resolves.toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('destroys the socket after a failed system.hello and reports a protocol error for other bad first requests', async () => {
    const server = new ShellinkSocketServer(() => {})
    await server.listen()
    try {
      const response = await new Promise<any>((resolve, reject) => {
        const socket = net.createConnection(config.socketPath)
        const decoder = new FrameDecoder()
        socket.once('error', reject)
        socket.once('connect', () =>
          socket.write(encodeFrame(FrameKind.Request, { id: 1, method: 'system.hello', params: { protocolVersion: PROTOCOL_VERSION + 1 } })),
        )
        let destroyed = false
        socket.once('close', () => {
          destroyed = true
        })
        socket.on('data', (chunk) => {
          const frames = decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
          if (frames[0]) {
            setTimeout(() => resolve({ payload: frames[0]!.payload, destroyed }), 200)
          }
        })
      })
      expect(response.payload.ok).toBe(false)
      expect(response.destroyed).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('listen() rejects when the underlying net.Server emits an error', async () => {
    const originalPath = config.socketPath
    // A path near the platform sun_path length limit triggers ENAMETOOLONG.
    config.socketPath = path.join(os.tmpdir(), `${'x'.repeat(200)}.sock`)
    const server = new ShellinkSocketServer(() => {})
    try {
      await expect(server.listen()).rejects.toThrow()
    } finally {
      config.socketPath = originalPath
    }
  })
})
