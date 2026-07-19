import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { config, loadMasterKey, webUiUrl } from '../../src/config.js'

describe('loadMasterKey', () => {
  it('creates a new random key when none exists and there is no env override', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellink-key-'))
    const key = loadMasterKey(home, undefined)
    expect(key).toHaveLength(32)
    expect(fs.existsSync(path.join(home, 'master.key'))).toBe(true)
  })

  it('reuses an existing key and accepts a matching env override', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellink-key-'))
    const hex = 'a'.repeat(64)
    const first = loadMasterKey(home, hex)
    const second = loadMasterKey(home, hex)
    expect(second).toEqual(first)
  })

  it('throws when the stored key does not match the env override', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellink-key-'))
    loadMasterKey(home, 'a'.repeat(64))
    expect(() => loadMasterKey(home, 'b'.repeat(64))).toThrow(/does not match/)
  })

  it('throws when master.key has the wrong permissions', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellink-key-'))
    loadMasterKey(home, 'a'.repeat(64))
    fs.chmodSync(path.join(home, 'master.key'), 0o644)
    expect(() => loadMasterKey(home, 'a'.repeat(64))).toThrow(/permissions must be 0600/)
  })
})

describe('defaultDataHome and defaultSocketPath fallbacks', () => {
  it('falls back to ~/.Shellink when SHELLINK_HOME and SHELLINK_DB are unset', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shellink-fakehome-'))
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome)
    const savedHome = process.env.SHELLINK_HOME
    const savedDb = process.env.SHELLINK_DB
    const savedSocket = process.env.SHELLINK_SOCKET
    delete process.env.SHELLINK_HOME
    delete process.env.SHELLINK_DB
    process.env.SHELLINK_SOCKET = path.join(fakeHome, 'shellink.sock')
    vi.resetModules()
    try {
      const mod = await import('../../src/config.js')
      expect(mod.config.dataHome).toBe(path.join(fakeHome, '.Shellink'))
    } finally {
      homedirSpy.mockRestore()
      if (savedHome === undefined) delete process.env.SHELLINK_HOME
      else process.env.SHELLINK_HOME = savedHome
      if (savedDb === undefined) delete process.env.SHELLINK_DB
      else process.env.SHELLINK_DB = savedDb
      if (savedSocket === undefined) delete process.env.SHELLINK_SOCKET
      else process.env.SHELLINK_SOCKET = savedSocket
      vi.resetModules()
      fs.rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('uses XDG_RUNTIME_DIR on non-darwin platforms when SHELLINK_SOCKET is unset', async () => {
    const savedSocket = process.env.SHELLINK_SOCKET
    const savedXdg = process.env.XDG_RUNTIME_DIR
    delete process.env.SHELLINK_SOCKET
    process.env.XDG_RUNTIME_DIR = '/run/user/1000'
    const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    vi.resetModules()
    try {
      const mod = await import('../../src/config.js')
      expect(mod.config.socketPath).toBe(path.join('/run/user/1000', 'shellink', 'shellink.sock'))
    } finally {
      Object.defineProperty(process, 'platform', platformDesc)
      if (savedSocket === undefined) delete process.env.SHELLINK_SOCKET
      else process.env.SHELLINK_SOCKET = savedSocket
      if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = savedXdg
      vi.resetModules()
    }
  })

  it('falls back to /tmp/shellink-<uid> on non-darwin platforms without XDG_RUNTIME_DIR', async () => {
    const savedSocket = process.env.SHELLINK_SOCKET
    const savedXdg = process.env.XDG_RUNTIME_DIR
    delete process.env.SHELLINK_SOCKET
    delete process.env.XDG_RUNTIME_DIR
    const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    vi.resetModules()
    try {
      const mod = await import('../../src/config.js')
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0
      expect(mod.config.socketPath).toBe(path.join('/tmp', `shellink-${uid}`, 'shellink.sock'))
    } finally {
      Object.defineProperty(process, 'platform', platformDesc)
      if (savedSocket === undefined) delete process.env.SHELLINK_SOCKET
      else process.env.SHELLINK_SOCKET = savedSocket
      if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = savedXdg
      vi.resetModules()
    }
  })
})

describe('config defaults when optional env vars are unset', () => {
  it('uses documented defaults for SHELLINK_HOME and the exported config object', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shellink-envhome-'))
    const explicitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shellink-explicithome-'))
    const keys = [
      'SHELLINK_HOME',
      'SHELLINK_PORT',
      'SHELLINK_HOST',
      'SHELLINK_TOKEN',
      'SHELLINK_SILENCE_MS',
      'SHELLINK_EXEC_TIMEOUT_MS',
      'SHELLINK_TRANSFER_TIMEOUT_MS',
      'SHELLINK_EDIT_TIMEOUT_MS',
      'SHELLINK_SSH_READY_TIMEOUT_MS',
      'SHELLINK_SOCKET',
    ] as const
    const saved: Partial<Record<(typeof keys)[number], string>> = {}
    for (const k of keys) saved[k] = process.env[k]
    for (const k of keys) delete process.env[k]
    process.env.SHELLINK_HOME = explicitHome
    process.env.SHELLINK_SOCKET = path.join(fakeHome, 'shellink.sock')
    vi.resetModules()
    try {
      const mod = await import('../../src/config.js')
      // SHELLINK_HOME set: defaultDataHome() takes the explicit-home branch.
      expect(mod.config.dataHome).toBe(path.resolve(explicitHome))
      // All other optional vars unset: exercise every `??` default branch.
      expect(mod.config.port).toBe(7070)
      expect(mod.config.host).toBe('127.0.0.1')
      expect(mod.config.token).toBe('change-me')
      expect(mod.config.silenceThresholdMs).toBe(800)
      expect(mod.config.execDefaultTimeoutMs).toBe(30_000)
      expect(mod.config.transferTimeoutMs).toBe(120_000)
      expect(mod.config.editTimeoutMs).toBe(60_000)
      expect(mod.config.sshReadyTimeoutMs).toBe(30_000)
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      vi.resetModules()
      fs.rmSync(fakeHome, { recursive: true, force: true })
      fs.rmSync(explicitHome, { recursive: true, force: true })
    }
  })

  it('uses the real darwin socket path fallback when SHELLINK_SOCKET is unset', async () => {
    if (process.platform !== 'darwin') return
    const savedSocket = process.env.SHELLINK_SOCKET
    delete process.env.SHELLINK_SOCKET
    vi.resetModules()
    try {
      const mod = await import('../../src/config.js')
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0
      expect(mod.config.socketPath).toBe(
        path.join(process.env.TMPDIR ?? os.tmpdir(), `shellink-${uid}`, 'shellink.sock'),
      )
    } finally {
      if (savedSocket === undefined) delete process.env.SHELLINK_SOCKET
      else process.env.SHELLINK_SOCKET = savedSocket
      vi.resetModules()
    }
  })
})

describe('webUiUrl', () => {
  it('normalizes 0.0.0.0 and :: to a loopback address', () => {
    const original = config.host
    try {
      config.host = '0.0.0.0'
      expect(webUiUrl()).toContain('127.0.0.1')
      config.host = '::'
      expect(webUiUrl()).toContain('127.0.0.1')
    } finally {
      config.host = original
    }
  })
})
