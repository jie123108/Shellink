import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { bus } from '../../src/core/events.js'
import { LocalPtySession } from '../../src/core/LocalPtySession.js'
import { sleep } from '../helpers/wait.js'

const hasExpect = (process.env.PATH ?? '').split(path.delimiter).some((directory) => {
  try { fs.accessSync(path.join(directory, 'expect'), fs.constants.X_OK); return true } catch { return false }
})

describe('LocalPtySession', () => {
  it('runs a short command and closes', async () => {
    const s = new LocalPtySession({
      id: 'pty1',
      profileId: 'p',
      profileName: 't',
      term: 'xterm',
      cols: 80,
      rows: 24,
      command: "printf 'hello-pty\\n'; sleep 0.2",
    })
    s.connect()
    await sleep(500)
    expect(s.recentOutput()).toContain('hello-pty')
    // process should exit
    await sleep(500)
    expect(s.state).toBe('DISCONNECTED')
  })

  it('write and resize on interactive bash', async () => {
    const s = new LocalPtySession({
      id: 'pty2',
      profileId: 'p',
      profileName: 't',
      term: 'xterm',
      cols: 80,
      rows: 24,
      promptRegex: '[$#]\\s*$',
      command: "bash --norc --noprofile -c 'export PS1=\"$ \"; exec bash --norc --noprofile'",
    })
    s.connect()
    await sleep(400)
    s.resize(100, 30)
    s.write('echo pty-ok\n')
    await sleep(400)
    expect(s.recentOutput()).toContain('pty-ok')
    s.close('done')
    await sleep(600)
    expect(s.state).toBe('DISCONNECTED')
  })

  it.runIf(hasExpect)('provides a correctly sized TTY in the Bun command fallback', async () => {
    const runtime = globalThis as typeof globalThis & { Bun?: unknown }
    const previous = runtime.Bun
    runtime.Bun = {}
    try {
      const s = new LocalPtySession({
        id: 'pty-bun',
        profileId: 'p',
        profileName: 'bun-command',
        term: 'xterm-256color',
        cols: 80,
        rows: 24,
      command: "bash --norc --noprofile -c 'test -t 0 && { printf tty-ok-; stty size; } || printf no-tty; exec bash --norc --noprofile'",
      })
      s.connect()
      await sleep(600)
      expect(s.recentOutput()).toContain('tty-ok-24 80')
      expect(s.recentOutput()).not.toContain('no-tty')
      s.resize(100, 30)
      s.write('stty size\n')
      await sleep(300)
      expect(s.recentOutput()).toContain('30 100')
    } finally {
      if (previous === undefined) delete runtime.Bun
      else runtime.Bun = previous
    }
  })

  it('falls back to a pipe-based process when expect is unavailable in the Bun path', async () => {
    const runtime = globalThis as typeof globalThis & { Bun?: unknown }
    const previousBun = runtime.Bun
    const previousPath = process.env.PATH
    runtime.Bun = {}
    process.env.PATH = ''
    try {
      const s = new LocalPtySession({
        id: 'pty-pipe',
        profileId: 'p',
        profileName: 'pipe',
        term: 'xterm',
        cols: 80,
        rows: 24,
      command: "printf 'pipe-ok\\n'",
      })
      s.connect()
      await sleep(500)
      expect(s.recentOutput()).toContain('pipe-ok')
      expect(() => s.resize(100, 30)).not.toThrow()
      s.close('bye')
      await sleep(700)
      expect(s.state).toBe('DISCONNECTED')
    } finally {
      process.env.PATH = previousPath
      if (previousBun === undefined) delete runtime.Bun
      else runtime.Bun = previousBun
    }
  })

  it.runIf(hasExpect)('reports a synchronous start failure', async () => {
    const runtime = globalThis as typeof globalThis & { Bun?: unknown }
    const previousBun = runtime.Bun
    runtime.Bun = {}
    const mkdtemp = vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => {
      throw new Error('disk full')
    })
    let closedReason = ''
    const onClosed = (e: { sessionId: string; reason: string }) => {
      if (e.sessionId === 'pty-start-fail') closedReason = e.reason
    }
    bus.on('session.closed', onClosed)
    try {
      const s = new LocalPtySession({
        id: 'pty-start-fail',
        profileId: 'p',
        profileName: 'fail',
        term: 'xterm',
        cols: 80,
        rows: 24,
      command: 'true',
      })
      s.connect()
      await sleep(200)
      expect(s.state).toBe('DISCONNECTED')
      expect(closedReason).toContain('Command failed to start')
    } finally {
      bus.off('session.closed', onClosed)
      mkdtemp.mockRestore()
      if (previousBun === undefined) delete runtime.Bun
      else runtime.Bun = previousBun
    }
  })
})
