import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const connectDaemon = vi.fn()
const ensureDaemon = vi.fn()
const question = vi.fn()

vi.mock('../src/daemon.js', () => ({
  connectDaemon: (...args: unknown[]) => connectDaemon(...args),
  ensureDaemon: (...args: unknown[]) => ensureDaemon(...args),
}))

vi.mock('node:readline', () => ({
  default: {
    createInterface: () => ({
      question: (prompt: string, cb: (answer: string) => void) => question(prompt, cb),
      close: vi.fn(),
    }),
  },
}))

import { restartDaemonIfRunning, runUpgrade } from '../src/upgrade.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellink-upgrade-daemon-'))
  tempDirs.push(dir)
  return dir
}

describe('upgrade daemon and confirm helpers', () => {
  beforeEach(() => {
    connectDaemon.mockReset()
    ensureDaemon.mockReset()
    question.mockReset()
  })

  it('restartDaemonIfRunning stops an existing daemon and starts a new one', async () => {
    const stop = vi.fn(async () => ({ ok: true }))
    const close = vi.fn()
    connectDaemon.mockResolvedValueOnce({ request: stop, close })
    ensureDaemon.mockResolvedValueOnce({ close: vi.fn() })
    await expect(restartDaemonIfRunning()).resolves.toBe(true)
    expect(stop).toHaveBeenCalledWith('system.stop')
    expect(close).toHaveBeenCalledOnce()
    expect(ensureDaemon).toHaveBeenCalledOnce()
  })

  it('restartDaemonIfRunning returns false when no daemon is running', async () => {
    connectDaemon.mockResolvedValueOnce(null)
    await expect(restartDaemonIfRunning()).resolves.toBe(false)
    expect(ensureDaemon).not.toHaveBeenCalled()
  })

  it('runUpgrade restarts the daemon through the default helper', async () => {
    const destDir = makeTempDir()
    const destPath = path.join(destDir, 'shellink')
    fs.writeFileSync(destPath, 'old')
    const payload = Buffer.from('default-restart')
    const sha = crypto.createHash('sha256').update(payload).digest('hex')
    const assetName = 'shellink-linux-x64'
    connectDaemon.mockResolvedValueOnce(null)
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/releases/latest')) return Response.json({ tag_name: 'v0.2.0' })
      if (url.includes('SHA256SUMS.txt')) return new Response(`${sha}  ${assetName}\n`)
      if (url.includes(assetName)) return new Response(payload)
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const result = await runUpgrade({
      currentVersion: '0.1.0',
      isBunBinary: true,
      execPath: destPath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl,
      yes: true,
    })
    expect(result.updated).toBe(true)
    expect(result.restarted).toBe(false)
  })

  it('uses the interactive confirm prompt during upgrade', async () => {
    const destDir = makeTempDir()
    const destPath = path.join(destDir, 'shellink')
    fs.writeFileSync(destPath, 'old')
    const payload = Buffer.from('prompted-binary')
    const sha = crypto.createHash('sha256').update(payload).digest('hex')
    const assetName = 'shellink-darwin-arm64'
    question.mockImplementation((_prompt: string, cb: (answer: string) => void) => cb('yes'))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/releases/latest')) return Response.json({ tag_name: 'v0.2.0' })
      if (url.includes('SHA256SUMS.txt')) return new Response(`${sha}  ${assetName}\n`)
      if (url.includes(assetName)) return new Response(payload)
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const result = await runUpgrade({
      currentVersion: '0.1.0',
      isBunBinary: true,
      execPath: destPath,
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl,
      isTty: true,
      restartDaemon: async () => false,
    })
    expect(question).toHaveBeenCalledOnce()
    expect(result.updated).toBe(true)
  })
})

describe('connect timeout classification', () => {
  it('treats aborted fetches as connect timeouts', async () => {
    const { resolveReleaseTag } = await import('../src/upgrade.js')
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('connect-timeout'), { name: 'AbortError' })))
      })
      return new Response('unreachable')
    }) as unknown as typeof fetch

    await expect(resolveReleaseTag(undefined, fetchImpl, '0.1.0', {
      connectTimeoutMs: 20,
      retryDelayMs: 1,
      locale: 'en-US',
    })).rejects.toThrow(/connection timed out|HTTPS_PROXY/)
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})
