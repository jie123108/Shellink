import { describe, expect, it } from 'vitest'
import { TransferError } from '../../src/core/TransferError.js'

describe('TransferError', () => {
  it('carries statusCode', () => {
    const err = new TransferError('busy', 409)
    expect(err.message).toBe('busy')
    expect(err.statusCode).toBe(409)
    expect(err.name).toBe('TransferError')
    expect(err).toBeInstanceOf(Error)
  })
})
