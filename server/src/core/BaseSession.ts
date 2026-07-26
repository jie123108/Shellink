import { config } from '../config.js'
import { stripAnsi } from './ansi.js'
import { bus } from './events.js'
import type { SessionState, InteractionMode } from './types.js'

export interface BaseSessionConfig {
  id: string
  profileId: string
  profileName: string
  term: string
  cols: number
  rows: number
  promptRegex?: string | null
}

const DEFAULT_PROMPT_REGEX = /[$#>%](\s|\u00a0)*$/

/**
 * Shared session logic: output pipeline, silence state machine, history, waitForStable.
 * Subclasses implement the transport (ssh2 / local PTY).
 */
export abstract class BaseSession {
  readonly id: string

  state: SessionState = 'CONNECTING'
  mode: InteractionMode = 'AUTO'
  lastSeq = 0
  readonly createdAt = Date.now()

  protected closed = false
  private silenceTimer: NodeJS.Timeout | null = null

  /** Rolling plain-text buffer for prompt detection and the state API. */
  private recentPlain = ''
  /** Until the first prompt is seen, keep the session in CONNECTING. */
  protected loginPhase = true
  private promptRegex: RegExp

  constructor(protected readonly base: BaseSessionConfig) {
    this.id = base.id
    this.promptRegex = base.promptRegex ? new RegExp(base.promptRegex) : DEFAULT_PROMPT_REGEX
  }

  /** Establish the connection / start the process. */
  abstract connect(): void

  /** Write raw data to the underlying transport. */
  protected abstract writeRaw(data: string): void

  abstract resize(cols: number, rows: number): void

  abstract close(reason?: string): void

  /** Write to the terminal (AI input / Web manual input / exec). */
  write(data: string, opts: { direction?: 'input'; record?: boolean } = {}): void {
    if (opts.record !== false) {
      this.recordChunk('input', data, data)
    }
    this.writeRaw(data)
  }

  setMode(mode: InteractionMode): void {
    if (this.mode === mode) return
    this.mode = mode
    bus.emit('session.mode', { sessionId: this.id, mode })
  }

  /** Whether the underlying transport has been closed. */
  isClosed(): boolean {
    return this.closed
  }

  /** Wait until the session reaches a stable state. exec defaults to not treating IDLE as done. */
  waitForStable(
    timeoutMs: number,
    opts: { acceptIdle?: boolean } = {},
  ): Promise<{ state: SessionState; timedOut: boolean }> {
    const acceptIdle = opts.acceptIdle !== false
    return new Promise((resolve) => {
      if (this.state === 'DISCONNECTED') {
        resolve({ state: this.state, timedOut: false })
        return
      }
      const onState = (e: { sessionId: string; state: SessionState }) => {
        if (e.sessionId !== this.id) return
        const done =
          e.state === 'WAITING_INPUT' ||
          e.state === 'DISCONNECTED' ||
          (acceptIdle && e.state === 'IDLE')
        if (done) {
          cleanup()
          resolve({ state: e.state, timedOut: false })
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve({ state: this.state, timedOut: true })
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        bus.off('session.state', onState)
      }
      bus.on('session.state', onState)
    })
  }

  /** Return the last N lines of recent plain output. */
  recentOutput(maxLines = 15): string {
    const lines = this.recentPlain.split('\n')
    return lines.slice(-maxLines).join('\n')
  }

  // ---------- Output pipeline for subclasses ----------

  protected handleOutput(raw: string): void {
    if (this.closed) return
    const plain = stripAnsi(raw)
    this.appendRecent(plain)
    this.recordChunk('output', raw, plain)
    this.transition('OUTPUTTING')
    this.resetSilenceTimer()
  }

  /** Synthetic connection-phase output (e.g. auth prompts) also goes to history and the Web terminal. */
  protected emitSyntheticOutput(text: string): void {
    const plain = stripAnsi(text)
    this.appendRecent(plain)
    this.recordChunk('output', text, plain)
    this.resetSilenceTimer()
  }

  protected recordChunk(direction: 'output' | 'input', raw: string, plain: string): void {
    this.lastSeq += 1
    bus.emit('session.data', {
      sessionId: this.id,
      seq: this.lastSeq,
      direction,
      raw,
      plain,
    })
  }

  protected handleClose(reason: string, exitCode: number | null): void {
    if (this.closed) return
    this.closed = true
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.transition('DISCONNECTED')
    bus.emit('session.closed', { sessionId: this.id, reason, exitCode })
  }

  protected completeLogin(): void {
    this.loginPhase = false
  }

  // ---------- Internals ----------

  private appendRecent(plain: string): void {
    this.recentPlain = (this.recentPlain + plain).slice(-16_384)
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer)
    this.silenceTimer = setTimeout(() => this.evaluateSilence(), config.silenceThresholdMs)
  }

  /** State evaluation after output has been silent for the threshold. */
  private evaluateSilence(): void {
    if (this.closed) return
    const lines = this.recentPlain.split('\n')
    const lastLine = lines[lines.length - 1] ?? ''
    const atPrompt = this.promptRegex.test(lastLine)

    if (this.loginPhase) {
      if (atPrompt) {
        this.completeLogin()
        this.transition('WAITING_INPUT')
      } else {
        this.transition('CONNECTING')
      }
      return
    }
    this.transition(atPrompt ? 'WAITING_INPUT' : 'IDLE')
  }

  protected transition(next: SessionState): void {
    // During login, keep CONNECTING except for disconnect.
    if (this.loginPhase && next === 'OUTPUTTING') next = 'CONNECTING'
    if (this.state === next) return
    const prev = this.state
    this.state = next
    bus.emit('session.state', { sessionId: this.id, state: next, prevState: prev, at: Date.now() })
  }
}
