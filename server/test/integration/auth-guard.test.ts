import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { resetDb } from '../helpers/resetDb.js'

describe('authGuard via HTTP', () => {
  it('rejects non-local requests without token', async () => {
    resetDb()
    const app = await buildApp({ logger: false, skipMarkStale: true })
    const res = await app.inject({
      method: 'GET',
      url: '/shellink/api/profiles',
      remoteAddress: '8.8.8.8',
      headers: { host: 'example.com' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('allows non-local with bearer token', async () => {
    resetDb()
    const app = await buildApp({ logger: false, skipMarkStale: true })
    const res = await app.inject({
      method: 'GET',
      url: '/shellink/api/profiles',
      remoteAddress: '8.8.8.8',
      headers: { host: 'example.com', authorization: 'Bearer test-token' },
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})
