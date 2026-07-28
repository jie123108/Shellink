import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn as spawnProcess, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { BaseSession, type BaseSessionConfig } from './BaseSession.js'

interface PtyLike {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number | null }) => void): void
}

/**
 * Bun-compiled binary has no node-pty ioctl resize; ExpectPty/PipeProcess rely on
 * COLUMNS + stty. Keep the local PTY wide by default so long shell lines (upload
 * printf, exec commands) are not wrap-truncated or lost on narrow PTYs.
 */
const BUN_PTY_DEFAULT_COLS = 2000

class PipeProcess implements PtyLike {
  private readonly child: ChildProcessWithoutNullStreams

  constructor(command: string, config: { term: string; cols: number; rows: number }) {
    const cols = Math.max(config.cols, BUN_PTY_DEFAULT_COLS)
    this.child = spawnProcess('/bin/sh', ['-lc', command], {
      env: { ...process.env, TERM: config.term, COLUMNS: String(cols), LINES: String(config.rows) },
      cwd: os.homedir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  }

  write(data: string): void { this.child.stdin.write(data) }
  resize(_cols: number, _rows: number): void { /* Bun executable cannot embed node-pty's native resize ioctl */ }
  kill(): void { this.child.kill() }
  onData(listener: (data: string) => void): void {
    this.child.stdout.on('data', (data) => listener(Buffer.from(data).toString()))
    this.child.stderr.on('data', (data) => listener(Buffer.from(data).toString()))
  }
  onExit(listener: (event: { exitCode: number | null }) => void): void {
    this.child.once('exit', (exitCode) => listener({ exitCode }))
    this.child.once('error', () => listener({ exitCode: null }))
  }
}

class ExpectPty implements PtyLike {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly controlDir: string
  private readonly slavePathFile: string
  private desiredSize: { cols: number; rows: number } | null = null
  private resizeTimer: NodeJS.Timeout | null = null
  private exited = false

  constructor(command: string, config: { term: string; cols: number; rows: number }) {
    const cols = Math.max(config.cols, BUN_PTY_DEFAULT_COLS)
    this.controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellink-expect-'))
    this.slavePathFile = path.join(this.controlDir, 'slave-path')
    const script = [
      'set timeout -1',
      'set command $env(SHELLINK_COMMAND)',
      'spawn -noecho /bin/sh -lc $command',
      'set slave_file $env(SHELLINK_SLAVE_FILE)',
      'set f [open $slave_file w]',
      'puts $f $spawn_out(slave,name)',
      'close $f',
      'stty rows $env(LINES) columns $env(COLUMNS) < $spawn_out(slave,name)',
      'interact',
      'catch wait result',
      'exit [lindex $result 3]',
    ].join('; ')
    this.child = spawnProcess('expect', ['-c', script], {
      env: {
        ...process.env,
        SHELLINK_COMMAND: command,
        SHELLINK_SLAVE_FILE: this.slavePathFile,
        TERM: config.term,
        COLUMNS: String(cols),
        LINES: String(config.rows),
      },
      cwd: os.homedir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // Ensure the expect slave wins even if spawn raced the stty line.
    this.desiredSize = { cols, rows: config.rows }
    this.applyResizeOrRetry()
  }

  write(data: string): void { this.child.stdin.write(data) }
  resize(cols: number, rows: number): void {
    this.desiredSize = { cols, rows }
    this.applyResizeOrRetry()
  }
  kill(): void { this.child.kill() }
  onData(listener: (data: string) => void): void {
    this.child.stdout.on('data', (data) => listener(Buffer.from(data).toString()))
    this.child.stderr.on('data', (data) => listener(Buffer.from(data).toString()))
  }
  onExit(listener: (event: { exitCode: number | null }) => void): void {
    this.child.once('exit', (exitCode) => {
      this.exited = true
      this.cleanup()
      listener({ exitCode })
    })
    this.child.once('error', () => {
      this.exited = true
      this.cleanup()
      listener({ exitCode: null })
    })
  }

  private applyResizeOrRetry(): void {
    if (this.exited || !this.desiredSize) return
    const slavePath = this.readSlavePath()
    if (slavePath) {
      const size = this.desiredSize
      const flag = process.platform === 'darwin' || process.platform === 'freebsd' ? '-f' : '-F'
      const result = spawnSync('/bin/stty', [flag, slavePath, 'rows', String(size.rows), 'columns', String(size.cols)], {
        stdio: 'ignore',
      })
      if (result.status === 0) return
    }
    if (this.resizeTimer) return
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null
      this.applyResizeOrRetry()
    }, 25)
    this.resizeTimer.unref()
  }

  private readSlavePath(): string | null {
    try {
      const pathName = fs.readFileSync(this.slavePathFile, 'utf8').trim()
      return pathName || null
    } catch {
      return null
    }
  }

  private cleanup(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer)
    this.resizeTimer = null
    try { fs.rmSync(this.controlDir, { recursive: true, force: true }) } catch {}
  }
}

function hasExecutable(name: string): boolean {
  const paths = (process.env.PATH ?? '').split(path.delimiter)
  return paths.some((directory) => {
    try { fs.accessSync(path.join(directory, name), fs.constants.X_OK); return true } catch { return false }
  })
}

// The npm node-pty prebuilt spawn-helper may lack its executable bit, causing posix_spawnp failures.
function ensureSpawnHelperExecutable(): void {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return
  try {
    const require = createRequire(import.meta.url)
    const base = path.dirname(require.resolve('node-pty/package.json'))
    for (const p of [
      path.join(base, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      path.join(base, 'build', 'Release', 'spawn-helper'),
    ]) {
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755)
    }
  } catch {
    // Ignore: only macOS and Linux need this adjustment.
  }
}
ensureSpawnHelperExecutable()

export interface LocalPtySessionConfig extends BaseSessionConfig {
  /** Command executed in a local PTY through a login shell, such as an expect script. */
  command: string
}

/** Command session that runs an expect/sh-style command in the server process and reuses BaseSession output handling. */
export class LocalPtySession extends BaseSession {
  readonly cfg: LocalPtySessionConfig

  private proc: PtyLike | null = null

  constructor(cfg: LocalPtySessionConfig) {
    super(cfg)
    this.cfg = cfg
  }

  connect(): void {
    void this.start()
  }

  private async start(): Promise<void> {
    try {
      if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
        this.proc = hasExecutable('expect') ? new ExpectPty(this.cfg.command, this.cfg) : new PipeProcess(this.cfg.command, this.cfg)
      } else {
        const { spawn: ptySpawn } = await import('node-pty')
        // A login shell preserves PATH, tilde expansion, and other expected environment behavior.
        this.proc = ptySpawn('/bin/sh', ['-lc', this.cfg.command], {
          name: this.cfg.term,
          cols: this.cfg.cols,
          rows: this.cfg.rows,
          cwd: os.homedir(),
          env: { ...process.env, TERM: this.cfg.term } as Record<string, string>,
        })
      }
    } catch (err) {
      this.handleClose(`Command failed to start: ${(err as Error).message}`, null)
      return
    }
    this.proc.onData((data) => this.handleOutput(data))
    this.proc.onExit(({ exitCode }) => {
      this.handleClose('Command exited', exitCode ?? null)
    })
  }

  protected writeRaw(data: string): void {
    if (!this.proc) throw new Error('The session has not started a local process')
    this.proc.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.proc?.resize(cols, rows)
    } catch {
      // Resizing an exited process throws; ignore it.
    }
  }

  close(reason = 'Closed manually'): void {
    if (this.closed) return
    try {
      this.proc?.kill()
    } catch {
      // Already exited.
    }
    // onExit invokes handleClose; call it directly as a fallback.
    setTimeout(() => this.handleClose(reason, null), 500)
  }
}
