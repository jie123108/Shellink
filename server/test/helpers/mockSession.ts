import { BaseSession, type BaseSessionConfig } from '../../src/core/BaseSession.js'
import type { SessionState } from '../../src/core/types.js'

/**
 * Controllable BaseSession for unit tests: feed output, capture writes.
 */
export class MockSession extends BaseSession {
  writes: string[] = []
  closedReason: string | null = null

  constructor(cfg: Partial<BaseSessionConfig> & { id: string }) {
    super({
      id: cfg.id,
      profileId: cfg.profileId ?? 'p1',
      profileName: cfg.profileName ?? 'test',
      term: cfg.term ?? 'xterm',
      cols: cfg.cols ?? 80,
      rows: cfg.rows ?? 24,
      promptRegex: cfg.promptRegex,
    })
  }

  connect(): void {
    // no-op
  }

  protected writeRaw(data: string): void {
    this.writes.push(data)
  }

  resize(_cols: number, _rows: number): void {
    // no-op
  }

  close(reason = 'test close'): void {
    this.handleClose(reason, 0)
    this.closedReason = reason
  }

  /** Feed terminal output into the pipeline. */
  feed(raw: string): void {
    this.handleOutput(raw)
  }

  feedSynthetic(text: string): void {
    this.emitSyntheticOutput(text)
  }

  forceState(state: SessionState): void {
    this.completeLogin()
    this.transition(state)
  }

  completeLoginPublic(): void {
    this.completeLogin()
  }
}
