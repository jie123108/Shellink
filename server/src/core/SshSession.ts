import { Client, type ClientChannel } from 'ssh2'
import { config } from '../config.js'
import { bus } from './events.js'
import { BaseSession, type BaseSessionConfig } from './BaseSession.js'

export interface SshSessionConfig extends BaseSessionConfig {
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  password?: string
  passphrase?: string
  privateKey?: string
  /** Injectable ssh2 Client factory for unit tests. */
  createClient?: () => Client
}

/** SSH session using ssh2 with authentication handling and the BaseSession output pipeline. */
export class SshSession extends BaseSession {
  readonly cfg: SshSessionConfig

  private client: Client
  private stream: ClientChannel | null = null

  /** Input is routed here while keyboard-interactive authentication is pending. */
  private pendingAuth: {
    prompts: { prompt: string; echo: boolean }[]
    answers: string[]
    finish: (answers: string[]) => void
  } | null = null

  constructor(cfg: SshSessionConfig) {
    super(cfg)
    this.cfg = cfg
    this.client = cfg.createClient ? cfg.createClient() : new Client()
  }

  connect(): void {
    this.client
      .on('ready', () => {
        this.client.shell(
          { term: this.cfg.term, cols: this.cfg.cols, rows: this.cfg.rows },
          (err, stream) => {
            if (err) {
              this.handleClose(`Shell request failed: ${err.message}`, null)
              return
            }
            this.stream = stream
            stream.on('data', (data: Buffer) => this.handleOutput(data.toString('utf8')))
            stream.stderr?.on('data', (data: Buffer) => this.handleOutput(data.toString('utf8')))
            stream.on('close', (code: number | null) => {
              this.handleClose('Shell channel closed', code ?? null)
            })
          },
        )
      })
      .on('keyboard-interactive', (_name, _inst, _lang, prompts, finish) => {
        this.handleKeyboardInteractive(
          prompts.map((p) => ({ prompt: p.prompt, echo: p.echo ?? false })),
          finish,
        )
      })
      .on('error', (err) => {
        this.handleClose(`Connection error: ${err.message}`, null)
      })
      .on('close', () => {
        if (!this.closed) this.handleClose('Connection closed', null)
      })

    this.client.connect({
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.username,
      password: this.cfg.authType === 'password' ? this.cfg.password : undefined,
      privateKey: this.cfg.authType === 'key' ? this.cfg.privateKey : undefined,
      passphrase: this.cfg.authType === 'key' ? this.cfg.passphrase : undefined,
      tryKeyboard: true,
      keepaliveInterval: 15_000,
      // Slow transfers (rate-limited links, large base64 uploads) can delay
      // keepalive round-trips for minutes; default countMax=3 drops at ~45s.
      keepaliveCountMax: 40,
      readyTimeout: config.sshReadyTimeoutMs,
    })
  }

  /** Answer keyboard-interactive prompts automatically when possible, otherwise await external input such as an OTP. */
  private handleKeyboardInteractive(
    prompts: { prompt: string; echo: boolean }[],
    finish: (answers: string[]) => void,
  ): void {
    if (prompts.length === 0) {
      finish([])
      return
    }
    this.pendingAuth = { prompts, answers: [], finish }
    this.advanceAuth()
  }

  /** Process authentication prompts in order. */
  private advanceAuth(): void {
    const auth = this.pendingAuth
    if (!auth) return
    while (auth.answers.length < auth.prompts.length) {
      const p = auth.prompts[auth.answers.length]
      if (/password/i.test(p.prompt) && this.cfg.password) {
        auth.answers.push(this.cfg.password)
        continue
      }
      // Surface unanswerable prompts as output and wait for AI or human input.
      this.emitSyntheticOutput(`\r\n${p.prompt}`)
      bus.emit('session.loginExternal', { sessionId: this.id, hint: p.prompt })
      return
    }
    const { finish, answers } = auth
    this.pendingAuth = null
    finish(answers)
  }

  /** Route input to authentication while pending; otherwise use normal writes. */
  override write(data: string, opts: { direction?: 'input'; record?: boolean } = {}): void {
    if (this.pendingAuth) {
      const answer = data.replace(/[\r\n]+$/, '')
      this.pendingAuth.answers.push(answer)
      this.emitSyntheticOutput('\r\n')
      this.advanceAuth()
      return
    }
    super.write(data, opts)
  }

  protected writeRaw(data: string): void {
    if (!this.stream) throw new Error('The session has not established a shell channel')
    this.stream.write(data)
  }

  resize(cols: number, rows: number): void {
    this.stream?.setWindow(rows, cols, 0, 0)
  }

  close(reason = 'Closed manually'): void {
    if (this.closed) return
    this.stream?.end()
    this.client.end()
    // The client close event invokes handleClose; call it directly as a fallback.
    setTimeout(() => this.handleClose(reason, null), 500)
  }
}
