import { describe, expect, it } from 'vitest'
import { serviceUrls } from '../../src/serviceUrls.js'
import { config } from '../../src/config.js'

describe('serviceUrls', () => {
  it('returns single url when host is specific', () => {
    const prev = config.host
    ;(config as { host: string }).host = '127.0.0.1'
    const urls = serviceUrls()
    expect(urls).toEqual([`http://127.0.0.1:${config.port}`])
    ;(config as { host: string }).host = prev
  })

  it('includes localhost when bound to 0.0.0.0', () => {
    const prev = config.host
    ;(config as { host: string }).host = '0.0.0.0'
    const urls = serviceUrls()
    expect(urls[0]).toBe(`http://localhost:${config.port}`)
    ;(config as { host: string }).host = prev
  })
})
