import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { bus } from '../../src/core/events.js'
import { SshSession } from '../../src/core/SshSession.js'

function makeFakeClient() {
  const client = new EventEmitter() as EventEmitter & {
    connect: ReturnType<typeof vi.fn>
    shell: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  }
  client.connect = vi.fn()
  client.shell = vi.fn()
  client.end = vi.fn()
  return client
}

describe('SshSession with injected Client', () => {
  it('auto-answers password keyboard-interactive prompts', () => {
    const client = makeFakeClient()
    const session = new SshSession({
      id: 'ssh1',
      profileId: 'p',
      profileName: 't',
      term: 'xterm',
      cols: 80,
      rows: 24,
      host: 'h',
      port: 22,
      username: 'u',
      authType: 'password',
      password: 'secret',
      createClient: () => client as never,
    })
    session.connect()
    expect(client.connect).toHaveBeenCalled()

    let finished: string[] | null = null
    client.emit(
      'keyboard-interactive',
      '',
      '',
      '',
      [{ prompt: 'Password: ', echo: false }],
      (answers: string[]) => {
        finished = answers
      },
    )
    expect(finished).toEqual(['secret'])
  })

  it('waits for external OTP then finishes', () => {
    const client = makeFakeClient()
    const hints: string[] = []
    const onExt = (e: { hint: string }) => hints.push(e.hint)
    bus.on('session.loginExternal', onExt)
    try {
      const session = new SshSession({
        id: 'ssh2',
        profileId: 'p',
        profileName: 't',
        term: 'xterm',
        cols: 80,
        rows: 24,
      host: 'h',
        port: 22,
        username: 'u',
        authType: 'password',
        createClient: () => client as never,
      })
      session.connect()

      let finished: string[] | null = null
      client.emit(
        'keyboard-interactive',
        '',
        '',
        '',
        [{ prompt: 'OTP Code: ', echo: true }],
        (answers: string[]) => {
          finished = answers
        },
      )
      expect(hints[0]).toContain('OTP')
      expect(finished).toBeNull()
      session.write('123456\n')
      expect(finished).toEqual(['123456'])
    } finally {
      bus.off('session.loginExternal', onExt)
    }
  })

  it('opens shell on ready and handles data', () => {
    const client = makeFakeClient()
    const stream = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>
      end: ReturnType<typeof vi.fn>
      setWindow: ReturnType<typeof vi.fn>
      stderr?: EventEmitter
    }
    stream.write = vi.fn()
    stream.end = vi.fn()
    stream.setWindow = vi.fn()
    stream.stderr = new EventEmitter()

    client.shell.mockImplementation((_opts: unknown, cb: (err: Error | null, s: typeof stream) => void) => {
      cb(null, stream)
    })

    const session = new SshSession({
      id: 'ssh3',
      profileId: 'p',
      profileName: 't',
      term: 'xterm',
      cols: 80,
      rows: 24,
      host: 'h',
      port: 22,
      username: 'u',
      authType: 'password',
      password: 'x',
      createClient: () => client as never,
    })
    session.connect()
    client.emit('ready')
    expect(client.shell).toHaveBeenCalled()
    stream.emit('data', Buffer.from('hello\n'))
    session.write('ls\n')
    expect(stream.write).toHaveBeenCalledWith('ls\n')
    session.resize(100, 40)
    expect(stream.setWindow).toHaveBeenCalledWith(40, 100, 0, 0)
    session.close('test')
    expect(stream.end).toHaveBeenCalled()
    expect(client.end).toHaveBeenCalled()
  })

  it('handles connect error', () => {
    const client = makeFakeClient()
    const session = new SshSession({
      id: 'ssh4',
      profileId: 'p',
      profileName: 't',
      term: 'xterm',
      cols: 80,
      rows: 24,
      host: 'h',
      port: 22,
      username: 'u',
      authType: 'password',
      createClient: () => client as never,
    })
    session.connect()
    client.emit('error', new Error('ECONNREFUSED'))
    expect(session.state).toBe('DISCONNECTED')
  })

  it('closes when the shell request itself fails', () => {
    const client = makeFakeClient()
    client.shell.mockImplementation((_opts: unknown, cb: (err: Error | null, s?: never) => void) => {
      cb(new Error('permission denied'))
    })
    const session = new SshSession({
      id: 'ssh5',
      profileId: 'p',
      profileName: 't',
      term: 'xterm',
      cols: 80,
      rows: 24,
      host: 'h',
      port: 22,
      username: 'u',
      authType: 'password',
      password: 'x',
      createClient: () => client as never,
    })
    session.connect()
    client.emit('ready')
    expect(session.state).toBe('DISCONNECTED')
  })

  it('closes when the shell stream emits close', () => {
    const client = makeFakeClient()
    const stream = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>
      end: ReturnType<typeof vi.fn>
      setWindow: ReturnType<typeof vi.fn>
      stderr?: EventEmitter
    }
    stream.write = vi.fn()
    stream.end = vi.fn()
    stream.setWindow = vi.fn()
    stream.stderr = new EventEmitter()
    client.shell.mockImplementation((_opts: unknown, cb: (err: Error | null, s: typeof stream) => void) => {
      cb(null, stream)
    })
    const session = new SshSession({
      id: 'ssh6',
      profileId: 'p',
      profileName: 't',
      term: 'xterm',
      cols: 80,
      rows: 24,
      host: 'h',
      port: 22,
      username: 'u',
      authType: 'password',
      password: 'x',
      createClient: () => client as never,
    })
    session.connect()
    client.emit('ready')
    stream.emit('close', 0)
    expect(session.state).toBe('DISCONNECTED')
  })

  it('finishes immediately with no answers when there are no keyboard-interactive prompts', () => {
    const client = makeFakeClient()
    const session = new SshSession({
      id: 'ssh7',
      profileId: 'p',
      profileName: 't',
      term: 'xterm',
      cols: 80,
      rows: 24,
      host: 'h',
      port: 22,
      username: 'u',
      authType: 'password',
      createClient: () => client as never,
    })
    session.connect()
    let finished: string[] | null = null
    client.emit('keyboard-interactive', '', '', '', [], (answers: string[]) => {
      finished = answers
    })
    expect(finished).toEqual([])
  })

  it('closes on a client close event when not already closed', () => {
    const client = makeFakeClient()
    const session = new SshSession({
      id: 'ssh8',
      profileId: 'p',
      profileName: 't',
      term: 'xterm',
      cols: 80,
      rows: 24,
      host: 'h',
      port: 22,
      username: 'u',
      authType: 'password',
      createClient: () => client as never,
    })
    session.connect()
    client.emit('close')
    expect(session.state).toBe('DISCONNECTED')
  })
})
