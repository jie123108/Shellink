import { TransferError } from './TransferError.js'

export type SessionLockKind = 'exec' | 'transfer'

/**
 * Serialize exec, file transfer, and remote edit operations for one session to prevent PTY command interleaving.
 * Input remains allowed under an exec lock for interactive reads; transfer locks allow only Ctrl+C.
 */
export class SessionOpLock {
  private locks = new Map<string, SessionLockKind>()

  isLocked(sessionId: string): boolean {
    return this.locks.has(sessionId)
  }

  kind(sessionId: string): SessionLockKind | undefined {
    return this.locks.get(sessionId)
  }

  async withLock<T>(
    sessionId: string,
    fn: () => Promise<T>,
    busyMessage = 'This session is performing another operation; try again later',
    kind: SessionLockKind = 'transfer',
  ): Promise<T> {
    if (this.locks.has(sessionId)) {
      throw new TransferError(busyMessage, 409)
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
