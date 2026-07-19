import { describe, expect, it } from 'vitest'
import { stripAnsi } from '../../src/core/ansi.js'

describe('stripAnsi', () => {
  it('removes CSI sequences', () => {
    expect(stripAnsi('\u001B[31mred\u001B[0m')).toBe('red')
  })

  it('normalizes CRLF and drops lone CR', () => {
    expect(stripAnsi('a\r\nb\rc')).toBe('a\nbc')
  })

  it('strips OSC sequences', () => {
    expect(stripAnsi('\u001B]0;title\u0007ok')).toBe('ok')
  })

  it('strips other control chars but keeps newline and tab', () => {
    expect(stripAnsi('a\tb\nc\u0007d')).toBe('a\tb\ncd')
  })
})
