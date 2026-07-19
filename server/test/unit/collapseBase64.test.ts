import { describe, expect, it } from 'vitest'
import {
  collapseBase64Payloads,
  createBase64CollapseStream,
} from '../../src/core/collapseBase64.js'

describe('collapseBase64Payloads', () => {
  it('returns empty/short text unchanged', () => {
    expect(collapseBase64Payloads('')).toBe('')
    expect(collapseBase64Payloads('hello')).toBe('hello')
  })

  it('collapses long base64 segments', () => {
    const b64 = 'A'.repeat(3000)
    const out = collapseBase64Payloads(b64, 10, 10)
    expect(out.startsWith('AAAAAAAAAA')).toBe(true)
    expect(out.endsWith('AAAAAAAAAA')).toBe(true)
    expect(out).toContain('characters omitted')
    expect(out.length).toBeLessThan(b64.length)
  })

  it('treats newlines inside base64 as same segment', () => {
    const part = 'B'.repeat(1500)
    const text = `${part}\n${part}`
    const out = collapseBase64Payloads(text, 8, 8)
    expect(out).toContain('characters omitted')
  })
})

describe('createBase64CollapseStream', () => {
  it('streams head then ellipsis and tail on flush', () => {
    const s = createBase64CollapseStream(4, 4)
    const a = s.push('AAAA')
    expect(a).toBe('AAAA')
    const b = s.push('BBBBCCCCDDDD')
    expect(b).toBe('')
    const end = s.push('!')
    expect(end).toContain('characters omitted')
    expect(end.endsWith('DDDD!')).toBe(true)
  })

  it('flush ends open segment', () => {
    const s = createBase64CollapseStream(2, 2)
    s.push('ABCDEFGH')
    const f = s.flush()
    expect(f).toContain('characters omitted')
    expect(f.endsWith('GH')).toBe(true)
  })
})
