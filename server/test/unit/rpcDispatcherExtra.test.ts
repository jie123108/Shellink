import { afterEach, describe, expect, it } from 'vitest'
import { AppError, PROTOCOL_VERSION, RpcErrorCode } from '@shellink/protocol'
import { RpcDispatcher, type SubscriptionSink } from '../../src/socket/RpcDispatcher.js'
import { SystemService } from '../../src/services/SystemService.js'
import { resetDb } from '../helpers/resetDb.js'

const sink: SubscriptionSink = {
  addSubscription: () => ({ subscriptionId: 'sub-1', initial: null }),
  removeSubscription: () => false,
}

describe('RpcDispatcher error paths', () => {
  it('rejects unknown methods', async () => {
    const dispatcher = new RpcDispatcher(new SystemService())
    await expect(dispatcher.dispatch('nope.method', {}, sink)).rejects.toMatchObject({
      code: RpcErrorCode.METHOD_NOT_FOUND,
    })
  })

  it('rejects invalid params', async () => {
    const dispatcher = new RpcDispatcher(new SystemService())
    await expect(dispatcher.dispatch('profiles.create', { bogus: true }, sink)).rejects.toMatchObject({
      code: RpcErrorCode.INVALID_REQUEST,
    })
  })

  it('rejects hello with a mismatched protocol version', async () => {
    const dispatcher = new RpcDispatcher(new SystemService())
    await expect(
      dispatcher.dispatch('system.hello', { protocolVersion: PROTOCOL_VERSION + 1 }, sink),
    ).rejects.toMatchObject({ code: RpcErrorCode.PROTOCOL_ERROR })
  })

  it('runs system.ping, system.status, and system.stop', async () => {
    const dispatcher = new RpcDispatcher(new SystemService())
    expect((await dispatcher.dispatch('system.ping', {}, sink)) as { pong: boolean }).toMatchObject({ pong: true })
    expect((await dispatcher.dispatch('system.status', {}, sink)) as { pid: number; version: string; commit: string }).toMatchObject({
      pid: process.pid,
      version: expect.any(String),
      commit: expect.any(String),
      protocolVersion: PROTOCOL_VERSION,
    })
    const hello = (await dispatcher.dispatch('system.hello', { protocolVersion: PROTOCOL_VERSION }, sink)) as {
      serviceVersion: string
      serviceCommit: string
    }
    expect(hello.serviceVersion.length).toBeGreaterThan(0)
    expect(hello.serviceCommit.length).toBeGreaterThan(0)
    expect((await dispatcher.dispatch('system.stop', {}, sink)) as { stopping: boolean }).toMatchObject({
      stopping: true,
    })
  })

  it('maps unexpected non-AppError failures through asAppError', async () => {
    const failing = { hello: () => { throw new Error('boom') } } as unknown as SystemService
    const dispatcher = new RpcDispatcher(failing)
    await expect(
      dispatcher.dispatch('system.hello', { protocolVersion: PROTOCOL_VERSION }, sink),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('reports removed:false when unsubscribing an unknown subscription', async () => {
    const dispatcher = new RpcDispatcher(new SystemService())
    const result = (await dispatcher.dispatch('events.unsubscribe', { subscriptionId: 'nope' }, sink)) as {
      removed: boolean
    }
    expect(result.removed).toBe(false)
  })
})

describe('RpcDispatcher full method coverage', () => {
  afterEach(() => resetDb())

  it('reaches every sessions.* and webhooks.* switch case at least once', async () => {
    const dispatcher = new RpcDispatcher(new SystemService())
    const call = async (method: string, params: unknown): Promise<unknown> => {
      try {
        return await dispatcher.dispatch(method, params, sink)
      } catch {
        return undefined
      }
    }

    const profile = (await call('profiles.create', {
      name: 'dispatcher-cov',
      connectType: 'command',
      command: '/bin/sh',
    })) as { id: string } | undefined
    expect(profile?.id).toBeDefined()
    await call('profiles.get', { id: profile!.id })
    await call('profiles.update', { id: profile!.id, profile: { name: 'dispatcher-cov-2' } })
    await call('profiles.delete', { id: profile!.id })

    await call('sessions.list', {})
    const bogusId = 'does-not-exist'
    await call('sessions.state', { id: bogusId })
    await call('sessions.history', { id: bogusId })
    await call('sessions.input', { id: bogusId, text: 'echo hi' })
    await call('sessions.exec', { id: bogusId, command: 'echo hi', timeoutMs: 1000 })
    await call('sessions.execStart', { id: bogusId, command: 'echo hi', timeoutMs: 1000 })
    await call('sessions.execStatus', { jobId: 'nopejob1', since: 0, waitMs: 0 })
    await call('sessions.execCancel', { jobId: 'nopejob1' })
    await call('sessions.download', { id: bogusId, path: '/tmp/x' })
    await call('sessions.upload', { id: bogusId, path: '/tmp/x', data: new TextEncoder().encode('hi') })
    await call('sessions.edit', { id: bogusId, path: '/tmp/x', edits: [{ oldText: 'a', newText: 'b' }] })
    await call('sessions.uploadStart', { id: bogusId, path: '/tmp/x', data: new TextEncoder().encode('hi') })
    await call('sessions.downloadStart', { id: bogusId, path: '/tmp/x', output: '/tmp/out' })
    await call('sessions.editStart', { id: bogusId, path: '/tmp/x', edits: [{ oldText: 'a', newText: 'b' }] })
    await call('sessions.mode', { id: bogusId, mode: 'MANUAL' })
    await call('sessions.resize', { id: bogusId, cols: 100, rows: 30 })
    await call('sessions.removeRecord', { id: bogusId })

    await call('webhooks.list', {})
    const created = (await call('webhooks.create', { url: 'https://example.com/hook', events: [] })) as
      | { id: string }
      | undefined
    expect(created?.id).toBeDefined()
    await call('webhooks.delete', { id: created!.id })
  })
})

describe('SystemService', () => {
  it('reports status fields and invokes the stop callback asynchronously', async () => {
    let stopped = false
    const svc = new SystemService(() => {
      stopped = true
    })
    expect(svc.ping().pong).toBe(true)
    const status = svc.status()
    expect(status.pid).toBe(process.pid)
    expect(typeof status.version).toBe('string')
    expect(status.version.length).toBeGreaterThan(0)
    expect(typeof status.commit).toBe('string')
    expect(status.commit.length).toBeGreaterThan(0)
    expect(status.protocolVersion).toBe(PROTOCOL_VERSION)
    const hello = svc.hello()
    expect(hello.serviceCommit).toBe(status.commit)
    expect(hello.serviceVersion).toBe(status.version)
    expect(typeof status.uptimeSeconds).toBe('number')
    expect(svc.stop().stopping).toBe(true)
    await new Promise((r) => setImmediate(r))
    expect(stopped).toBe(true)
  })

  it('defaults to a no-op stop callback', () => {
    const svc = new SystemService()
    expect(() => svc.stop()).not.toThrow()
  })
})
