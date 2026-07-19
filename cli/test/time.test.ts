import { describe, expect, it } from 'vitest'
import { formatSessionStartedAt } from '../src/time.js'

describe('formatSessionStartedAt', () => {
  it('formats local MM-DD hh:mm with zero padding', () => {
    const date = new Date(2026, 0, 5, 3, 7, 0)
    expect(formatSessionStartedAt(date.getTime())).toBe('01-05 03:07')
  })

  it('formats December evening times', () => {
    const date = new Date(2026, 11, 31, 23, 59, 0)
    expect(formatSessionStartedAt(date.getTime())).toBe('12-31 23:59')
  })

  it('returns empty string for invalid timestamps', () => {
    expect(formatSessionStartedAt(Number.NaN)).toBe('')
  })
})
