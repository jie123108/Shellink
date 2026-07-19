import { describe, expect, it, vi } from 'vitest'
import { parseMasterKey } from '../../src/config.js'

describe('parseMasterKey', () => {
  it('uses insecure default when unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const key = parseMasterKey(undefined)
    expect(key).toHaveLength(32)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('accepts 32-byte hex', () => {
    const hex = '30616a47fe6666e88cdc2e5a8fef7d81ad6c62710d0723de5a75be2dc61fea49'
    expect(parseMasterKey(hex)).toEqual(Buffer.from(hex, 'hex'))
  })

  it('rejects wrong length', () => {
    expect(() => parseMasterKey('abcd')).toThrow(/32-byte/)
  })
})
