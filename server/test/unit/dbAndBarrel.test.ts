import { describe, expect, it } from 'vitest'
import { closeDatabase } from '../../src/db/index.js'
import * as servicesBarrel from '../../src/services/index.js'

describe('closeDatabase', () => {
  it('is idempotent and safe to call repeatedly', () => {
    expect(() => closeDatabase()).not.toThrow()
    expect(() => closeDatabase()).not.toThrow()
  })
})

describe('services barrel exports', () => {
  it('re-exports service singletons and helpers', () => {
    expect(servicesBarrel.profileService).toBeDefined()
    expect(servicesBarrel.sessionService).toBeDefined()
    expect(servicesBarrel.webhookService).toBeDefined()
    expect(servicesBarrel.webhookInboxService).toBeDefined()
    expect(servicesBarrel.SystemService).toBeTypeOf('function')
    expect(servicesBarrel.asAppError).toBeTypeOf('function')
  })
})
