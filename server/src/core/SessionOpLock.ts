import { TransferError } from './TransferError.js'

export type SessionLockKind = 'exec' | 'transfer'

/**
 * Serialize exec, file transfer, and remote edit operations for one session to prevent PTY command interleaving.
 * Input remains allowed under an exec lock for interactive reads; transfer locks allow only Ctrl+C.
 */
export class SessionOpLock {
  private locks = new Map<string, SessionLockKind>()
  private describeBusy?: (sessionId: string) => string

  isLocked(sessionId: string): boolean {
    return this.locks.has(sessionId)
  }

  kind(sessionId: string): SessionLockKind | undefined {
    return this.locks.get(sessionId)
  }

  /** Install a callback that produces a conflict message naming the currently running job, if any. */
  setBusyDescriber(describe: ((sessionId: string) => string) | undefined): void {
    this.describeBusy = describe
  }

  async withLock<T>(
    sessionId: string,
    fn: () => Promise<T>,
    busyMessage = 'This session is performing another operation; try again later',
    kind: SessionLockKind = 'transfer',
  ): Promise<T> {
    if (this.locks.has(sessionId)) {
      const message = this.describeBusy ? this.describeBusy(sessionId) : busyMessage
      throw new TransferError(message, 409)
    }
    this.locks.set(sessionId, kind)
    try {
      return await fn()
    } finally {
      this.locks.delete(sessionId)
    }
  }

  clear(sessionId: string): void {
    this.locks.delete(sessionId)
  }
}
