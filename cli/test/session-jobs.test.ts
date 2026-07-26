import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError, RpcErrorCode } from '@shellink/protocol'
import { formatHelp } from '../src/help.js'
import { main, parse, socketTimeoutMs } from '../src/index.js'
import * as daemon from '../src/daemon.js'
import type { SocketClient } from '../src/SocketClient.js'

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('session job CLI helpers', () => {
  it('parses --detach as a boolean flag', () => {
    const { words, flags } = parse(['session', 'exec', 'abc12345', '--command', 'sleep 1', '--detach', '--json'])
    expect(words).toEqual(['session', 'exec', 'abc12345'])
    expect(flags.detach).toBe(true)
    expect(flags.command).toBe('sleep 1')
    expect(flags.json).toBe(true)
  })

  it('parses exec-status --since and --wait', () => {
    const { words, flags } = parse(['session', 'exec-status', 'jobId123', '--since', '42', '--wait', '20000'])
    expect(words).toEqual(['session', 'exec-status', 'jobId123'])
    expect(flags.since).toBe('42')
    expect(flags.wait).toBe('20000')
  })

  it('computes socket timeout as server timeout + 1000ms', () => {
    expect(socketTimeoutMs(20_000)).toBe(21_000)
    expect(socketTimeoutMs(25_000)).toBe(26_000)
    expect(socketTimeoutMs(0)).toBe(1000)
  })

  it('documents detach / exec-status / exec-cancel in bilingual help', () => {
    for (const locale of ['en-US', 'zh-CN'] as const) {
      const text = formatHelp('session', locale, '0.0.0')
      expect(text).toContain('--detach')
      expect(text).toContain('exec-status')
      expect(text).toContain('exec-cancel')
    }
  })

  it('METHOD_NOT_FOUND is a distinct AppError code for the CLI restart hint', () => {
    const error = new AppError(RpcErrorCode.METHOD_NOT_FOUND, 'Method not found', 404)
    expect(error.code).toBe(RpcErrorCode.METHOD_NOT_FOUND)
  })
})

describe('session job CLI RPC routing', () => {
  it('exec --detach / exec-status / exec-cancel hit the expected RPC methods and timeouts', async () => {
    const requests: Array<{ method: string; params: unknown; timeoutMs?: number }> = []
    const client = {
      request: vi.fn(async (method: string, params?: unknown, timeoutMs?: number) => {
        requests.push({ method, params, timeoutMs })
        if (method === 'sessions.execStart') return { jobId: 'jobAAAA1', status: 'RUNNING', startSeq: 1, state: 'OUTPUTTING' }
        if (method === 'sessions.execStatus') return { job: { id: 'jobAAAA1', status: 'DONE' }, output: 'ok', cursor: 9, done: true }
        if (method === 'sessions.execCancel') return { id: 'jobAAAA1', status: 'CANCELED' }
        if (method === 'sessions.state') return { state: 'WAITING_INPUT' }
        return {}
      }),
      close: vi.fn(),
    }

    vi.spyOn(daemon, 'ensureDaemon').mockResolvedValue(client as unknown as SocketClient)
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      void chunk
      return true
    }) as typeof process.stdout.write)

    await main(['session', 'exec', 'sess1111', '--command', 'sleep 1', '--detach', '--timeout', '15000', '--json'])
    expect(requests[0]?.method).toBe('sessions.execStart')
    expect(requests[0]?.timeoutMs).toBe(socketTimeoutMs(15_000))
    expect(requests[0]?.params).toMatchObject({ id: 'sess1111', command: 'sleep 1', timeoutMs: 15_000 })

    requests.length = 0
    await main(['session', 'exec-status', 'jobAAAA1', '--since', '1', '--wait', '20000', '--json'])
    expect(requests[0]?.method).toBe('sessions.execStatus')
    expect(requests[0]?.timeoutMs).toBe(socketTimeoutMs(20_000))
    expect(requests[0]?.params).toMatchObject({ jobId: 'jobAAAA1', since: 1, waitMs: 20_000 })

    requests.length = 0
    await main(['session', 'exec-cancel', 'jobAAAA1', '--json'])
    expect(requests[0]?.method).toBe('sessions.execCancel')
    expect(requests[0]?.params).toMatchObject({ jobId: 'jobAAAA1' })

    stdoutSpy.mockRestore()
  })
})
