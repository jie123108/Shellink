import { describe, expect, it } from 'vitest'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { TransferError } from '../../src/core/TransferError.js'

describe('SessionOpLock', () => {
  it('runs exclusive work', async () => {
    const lock = new SessionOpLock()
    const order: number[] = []
    await lock.withLock('s1', async () => {
      order.push(1)
      return 42
    })
    expect(order).toEqual([1])
  })

  it('rejects concurrent lock on same session', async () => {
    const lock = new SessionOpLock()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const first = lock.withLock('s1', async () => {
      await gate
      return 'done'
    })
    await expect(lock.withLock('s1', async () => 'nope')).rejects.toBeInstanceOf(TransferError)
    release()
    await expect(first).resolves.toBe('done')
  })

  it('tracks lock kind and isLocked', async () => {
    const lock = new SessionOpLock()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const first = lock.withLock(
      's1',
      async () => {
        expect(lock.isLocked('s1')).toBe(true)
        expect(lock.kind('s1')).toBe('exec')
        await gate
      },
      'busy',
      'exec',
    )
    expect(lock.kind('s1')).toBe('exec')
    release()
    await first
    expect(lock.isLocked('s1')).toBe(false)
  })

  it('clear allows re-entry after stuck lock', async () => {
    const lock = new SessionOpLock()
    const p = lock.withLock('s1', async () => {
      await new Promise(() => {})
    })
    void p
    lock.clear('s1')
    await expect(lock.withLock('s1', async () => 'ok')).resolves.toBe('ok')
  })

  it('uses setBusyDescriber for conflict messages', async () => {
    const lock = new SessionOpLock()
    lock.setBusyDescriber((sid) => `busy-job on ${sid}`)
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const first = lock.withLock('s1', async () => {
      await gate
    })
    await expect(lock.withLock('s1', async () => 'nope')).rejects.toMatchObject({
      message: 'busy-job on s1',
      statusCode: 409,
    })
    release()
    await first
    lock.setBusyDescriber(undefined)
  })
})
