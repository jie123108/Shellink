import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UpgradeError,
  compareVersions,
  describeDownloadError,
  DownloadError,
  detectAssetName,
  detectInstallTarget,
  downloadAndVerify,
  expectedChecksum,
  formatUpgradeResult,
  installBinary,
  normalizeTag,
  resolveReleaseTag,
  runUpgrade,
  stripVersionPrefix,
} from '../src/upgrade.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellink-upgrade-test-'))
  tempDirs.push(dir)
  return dir
}

function mockFetch(handlers: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const handler = Object.entries(handlers).find(([prefix]) => url.includes(prefix) || url === prefix)?.[1]
    if (!handler) throw new Error(`unexpected fetch: ${url}`)
    return await handler()
  }) as unknown as typeof fetch
}

describe('upgrade helpers', () => {
  it('normalizes and compares versions', () => {
    expect(normalizeTag('0.2.0')).toBe('v0.2.0')
    expect(normalizeTag('v0.2.0')).toBe('v0.2.0')
    expect(() => normalizeTag('   ')).toThrow(/must not be empty/)
    expect(stripVersionPrefix('v1.2.3')).toBe('1.2.3')
    expect(compareVersions('0.1.0', 'v0.2.0')).toBe(-1)
    expect(compareVersions('v0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.3.0', '0.2.0')).toBe(1)
    expect(compareVersions('1.0', '1.0.1')).toBe(-1)
  })

  it('detects release asset names and rejects unsupported targets', () => {
    expect(detectAssetName('darwin', 'arm64')).toBe('shellink-darwin-arm64')
    expect(detectAssetName('linux', 'x64')).toBe('shellink-linux-x64')
    expect(() => detectAssetName('win32', 'x64')).toThrow(UpgradeError)
    expect(() => detectAssetName('freebsd' as NodeJS.Platform, 'x64')).toThrow(/unsupported OS/)
    expect(() => detectAssetName('linux', 'ia32')).toThrow(/unsupported architecture/)
  })

  it('rejects non-binary installs and unreadable paths', () => {
    expect(() => detectInstallTarget({ isBunBinary: false })).toThrow(/standalone binary/)
    expect(() => detectInstallTarget({ isBunBinary: true, execPath: path.join(makeTempDir(), 'missing') })).toThrow(/cannot resolve binary path/)
  })

  it('resolves latest release tag from GitHub API', async () => {
    const fetchImpl = mockFetch({
      '/releases/latest': () => Response.json({ tag_name: 'v0.2.0' }),
    })
    await expect(resolveReleaseTag(undefined, fetchImpl, '0.1.0')).resolves.toBe('v0.2.0')
    await expect(resolveReleaseTag('0.3.0', fetchImpl, '0.1.0')).resolves.toBe('v0.3.0')
  })

  it('rejects malformed latest release payloads', async () => {
    const fetchImpl = mockFetch({
      '/releases/latest': () => Response.json({ tag_name: 123 }),
    })
    await expect(resolveReleaseTag(undefined, fetchImpl, '0.1.0')).rejects.toThrow(/could not resolve latest release tag/)
  })

  it('retries transient HTTP failures then succeeds', async () => {
    let calls = 0
    const retries: string[] = []
    const fetchImpl = vi.fn(async () => {
      calls += 1
      if (calls < 3) return new Response('unavailable', { status: 500, statusText: 'Internal Server Error' })
      return Response.json({ tag_name: 'v0.2.0' })
    }) as unknown as typeof fetch
    await expect(resolveReleaseTag(undefined, fetchImpl, '0.1.0', {
      retryDelayMs: 1,
      progress: { update() {}, retry(message) { retries.push(message) }, finish() {} },
    })).resolves.toBe('v0.2.0')
    expect(calls).toBe(3)
    expect(retries.length).toBe(2)
  })

  it('fails immediately on HTTP 404 and includes release guidance', async () => {
    const fetchImpl = mockFetch({
      '/releases/latest': () => new Response('missing', { status: 404, statusText: 'Not Found' }),
    })
    await expect(resolveReleaseTag(undefined, fetchImpl, '0.1.0', { locale: 'en-US' })).rejects.toThrow(/does not exist/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('parses checksums and verifies downloads', async () => {
    const payload = Buffer.from('shellink-binary')
    const sha = crypto.createHash('sha256').update(payload).digest('hex')
    const assetName = 'shellink-darwin-arm64'
    const dir = makeTempDir()
    const fetchImpl = mockFetch({
      'SHA256SUMS.txt': () => new Response(`${sha}  ${assetName}\n`),
      [assetName]: () => new Response(payload),
    })
    expect(expectedChecksum(`${sha}  ${assetName}\n`, assetName)).toBe(sha)
    expect(() => expectedChecksum('deadbeef  other\n', assetName)).toThrow(/checksum .* not found/)
    const result = await downloadAndVerify({
      tag: 'v0.2.0',
      assetName,
      destDir: dir,
      fetchImpl,
      currentVersion: '0.1.0',
    })
    expect(result.sha256).toBe(sha)
    expect(fs.readFileSync(result.binaryPath)).toEqual(payload)
  })

  it('fails on checksum mismatch', async () => {
    const payload = Buffer.from('shellink-binary')
    const assetName = 'shellink-linux-x64'
    const dir = makeTempDir()
    const fetchImpl = mockFetch({
      'SHA256SUMS.txt': () => new Response(`${'a'.repeat(64)}  ${assetName}\n`),
      [assetName]: () => new Response(payload),
    })
    await expect(downloadAndVerify({
      tag: 'v0.2.0',
      assetName,
      destDir: dir,
      fetchImpl,
      currentVersion: '0.1.0',
      locale: 'en-US',
    })).rejects.toThrow(/checksum mismatch/)
  })

  it('reports streaming byte progress and rejects truncated assets', async () => {
    const payload = Buffer.from('shellink-binary')
    const sha = crypto.createHash('sha256').update(payload).digest('hex')
    const assetName = 'shellink-linux-x64'
    const dir = makeTempDir()
    const progress: number[] = []
    const fetchImpl = mockFetch({
      'SHA256SUMS.txt': () => new Response(`${sha}  ${assetName}\n`),
      [assetName]: () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(payload.subarray(0, 4))
          controller.enqueue(payload.subarray(4))
          controller.close()
        },
      }), { headers: { 'content-length': String(payload.length) } }),
    })
    await downloadAndVerify({
      tag: 'v0.2.0',
      assetName,
      destDir: dir,
      fetchImpl,
      progress: { update: (update) => progress.push(update.received), retry() {}, finish() {} },
    })
    expect(progress).toEqual([4, payload.length])

    const truncatedFetch = mockFetch({
      'SHA256SUMS.txt': () => new Response(`${sha}  ${assetName}\n`),
      [assetName]: () => new Response(payload.subarray(0, 4), { headers: { 'content-length': String(payload.length) } }),
    })
    await expect(downloadAndVerify({
      tag: 'v0.2.0',
      assetName,
      destDir: dir,
      fetchImpl: truncatedFetch,
      locale: 'zh-CN',
      retryDelayMs: 1,
    })).rejects.toThrow(/不完整|incomplete/)
  })

  it('aborts stalled downloads and reports Chinese guidance', async () => {
    const sha = 'a'.repeat(64)
    const assetName = 'shellink-darwin-arm64'
    const dir = makeTempDir()
    const fetchImpl = mockFetch({
      'SHA256SUMS.txt': () => new Response(`${sha}  ${assetName}\n`),
      [assetName]: () => new Response(new ReadableStream({
        start() {
          // never enqueue; wait for stall timeout
        },
      }), { headers: { 'content-length': '10' } }),
    })
    await expect(downloadAndVerify({
      tag: 'v0.2.0',
      assetName,
      destDir: dir,
      fetchImpl,
      locale: 'zh-CN',
      stallTimeoutMs: 20,
      retryDelayMs: 1,
    })).rejects.toThrow(/停滞|HTTPS_PROXY/)
  })

  it('classifies download errors across locales and causes', () => {
    const missing = new Response('', { status: 404, statusText: 'Not Found' })
    const english = describeDownloadError(
      new DownloadError('http', 'Not Found', 404, missing.headers),
      { stage: 'binary', url: 'https://example.test/release', attempts: 1, locale: 'en-US' },
    )
    expect(english.message).toContain('does not exist')

    const chinese = describeDownloadError(
      new DownloadError('http', 'Not Found', 404, missing.headers),
      { stage: 'binary', url: 'https://example.test/release', attempts: 1, locale: 'zh-CN' },
    )
    expect(chinese.message).toContain('不存在')

    const rateLimited = new Headers({ 'x-ratelimit-remaining': '0' })
    expect(describeDownloadError(
      new DownloadError('http', 'Forbidden', 403, rateLimited),
      { stage: 'release metadata', url: 'https://api.github.com', attempts: 1, locale: 'en-US' },
    ).message).toContain('rate limit')

    expect(describeDownloadError(
      new DownloadError('http', 'Boom', 503),
      { stage: 'binary', url: 'https://example.test', attempts: 3, locale: 'en-US' },
    ).message).toContain('temporarily unavailable')

    expect(describeDownloadError(
      new DownloadError('stalled', 'no data'),
      { stage: 'binary', url: 'https://example.test', attempts: 2, locale: 'en-US' },
    ).message).toContain('HTTPS_PROXY')

    expect(describeDownloadError(
      new DownloadError('network', 'lookup failed', undefined, undefined, Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
      { stage: 'binary', url: 'https://example.test', attempts: 1, locale: 'en-US' },
    ).message).toContain('DNS')

    expect(describeDownloadError(
      new DownloadError('network', 'tls failed', undefined, undefined, new Error('UNABLE_TO_VERIFY_LEAF_SIGNATURE')),
      { stage: 'binary', url: 'https://example.test', attempts: 1, locale: 'zh-CN' },
    ).message).toContain('证书')

    expect(describeDownloadError(
      new Error('plain failure'),
      { stage: 'binary', url: 'https://example.test', attempts: 1, locale: 'en-US' },
    ).message).toContain('plain failure')
  })

  it('installBinary replaces destinations and maps permission errors', () => {
    const dir = makeTempDir()
    const source = path.join(dir, 'src.bin')
    const dest = path.join(dir, 'dest.bin')
    fs.writeFileSync(source, 'new')
    installBinary(source, dest)
    expect(fs.readFileSync(dest, 'utf8')).toBe('new')

    const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })
    expect(() => installBinary(source, dest)).toThrow(/permission denied/)
    spy.mockImplementation(() => {
      throw 'disk full'
    })
    expect(() => installBinary(source, dest)).toThrow(/cannot write/)
  })

  it('rethrows UpgradeError from download retries without wrapping', async () => {
    const assetName = 'shellink-linux-x64'
    const dir = makeTempDir()
    const sha = 'b'.repeat(64)
    const fetchImpl = mockFetch({
      'SHA256SUMS.txt': () => new Response(`${sha}  ${assetName}\n`),
      [assetName]: () => new Response('missing', { status: 404, statusText: 'Not Found' }),
    })
    await expect(downloadAndVerify({
      tag: 'v0.2.0',
      assetName,
      destDir: dir,
      fetchImpl,
      locale: 'en-US',
      retryDelayMs: 1,
    })).rejects.toBeInstanceOf(UpgradeError)
  })
})

describe('runUpgrade', () => {
  it('check-only reports update without writing files', async () => {
    const destDir = makeTempDir()
    const destPath = path.join(destDir, 'shellink')
    fs.writeFileSync(destPath, 'old')
    const fetchImpl = mockFetch({
      '/releases/latest': () => Response.json({ tag_name: 'v0.2.0' }),
    })
    const restartDaemon = vi.fn(async () => true)
    const result = await runUpgrade({
      checkOnly: true,
      currentVersion: '0.1.0',
      isBunBinary: true,
      execPath: destPath,
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl,
      restartDaemon,
    })
    expect(result).toMatchObject({
      current: '0.1.0',
      target: '0.2.0',
      upToDate: false,
      updated: false,
      checkOnly: true,
      restarted: false,
    })
    expect(fs.readFileSync(destPath, 'utf8')).toBe('old')
    expect(restartDaemon).not.toHaveBeenCalled()
    expect(formatUpgradeResult(result)).toContain('0.1.0 → 0.2.0')
    expect(formatUpgradeResult({ ...result, upToDate: true })).toContain('up to date')
  })

  it('reports up-to-date without downloading', async () => {
    const destDir = makeTempDir()
    const destPath = path.join(destDir, 'shellink')
    fs.writeFileSync(destPath, 'old')
    const fetchImpl = mockFetch({
      '/releases/latest': () => Response.json({ tag_name: 'v0.1.0' }),
    })
    const result = await runUpgrade({
      currentVersion: '0.1.0',
      isBunBinary: true,
      execPath: destPath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl,
      yes: true,
      restartDaemon: async () => false,
    })
    expect(result.upToDate).toBe(true)
    expect(result.updated).toBe(false)
    expect(fs.readFileSync(destPath, 'utf8')).toBe('old')
    expect(formatUpgradeResult(result)).toContain('already up to date')
  })

  it('downloads, verifies, replaces binary, and restarts daemon', async () => {
    const destDir = makeTempDir()
    const destPath = path.join(destDir, 'shellink')
    fs.writeFileSync(destPath, 'old-binary')
    const payload = Buffer.from('new-binary')
    const sha = crypto.createHash('sha256').update(payload).digest('hex')
    const assetName = 'shellink-darwin-arm64'
    const fetchImpl = mockFetch({
      '/releases/latest': () => Response.json({ tag_name: 'v0.2.0' }),
      'SHA256SUMS.txt': () => new Response(`${sha}  ./${assetName}\n`),
      [assetName]: () => new Response(payload),
    })
    const restartDaemon = vi.fn(async () => true)
    const result = await runUpgrade({
      currentVersion: '0.1.0',
      isBunBinary: true,
      execPath: destPath,
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl,
      yes: true,
      restartDaemon,
    })
    expect(result.updated).toBe(true)
    expect(result.restarted).toBe(true)
    expect(result.downloadedBytes).toBe(payload.length)
    expect(fs.readFileSync(destPath)).toEqual(payload)
    expect(restartDaemon).toHaveBeenCalledOnce()
    expect(formatUpgradeResult(result)).toContain('Daemon restarted')
    expect(formatUpgradeResult({ ...result, restarted: false })).not.toContain('Daemon restarted')
  })

  it('requires --yes when non-interactive and honors cancel', async () => {
    const destDir = makeTempDir()
    const destPath = path.join(destDir, 'shellink')
    fs.writeFileSync(destPath, 'old')
    const fetchImpl = mockFetch({
      '/releases/latest': () => Response.json({ tag_name: 'v0.2.0' }),
    })
    await expect(runUpgrade({
      currentVersion: '0.1.0',
      isBunBinary: true,
      execPath: destPath,
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl,
      isTty: false,
      yes: false,
    })).rejects.toMatchObject({ message: /non-interactive upgrade requires --yes/, exitCode: 2 })

    await expect(runUpgrade({
      currentVersion: '0.1.0',
      isBunBinary: true,
      execPath: destPath,
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl,
      isTty: true,
      yes: false,
      confirm: async () => false,
    })).rejects.toThrow(/upgrade cancelled/)
  })

  it('uses interactive confirm before upgrading', async () => {
    const destDir = makeTempDir()
    const destPath = path.join(destDir, 'shellink')
    fs.writeFileSync(destPath, 'old')
    const payload = Buffer.from('confirmed')
    const sha = crypto.createHash('sha256').update(payload).digest('hex')
    const assetName = 'shellink-linux-x64'
    const fetchImpl = mockFetch({
      '/releases/latest': () => Response.json({ tag_name: 'v0.2.0' }),
      'SHA256SUMS.txt': () => new Response(`${sha}  ${assetName}\n`),
      [assetName]: () => new Response(payload),
    })
    const confirm = vi.fn(async () => true)
    const result = await runUpgrade({
      currentVersion: '0.1.0',
      isBunBinary: true,
      execPath: destPath,
      platform: 'linux',
      arch: 'x64',
      fetchImpl,
      isTty: true,
      confirm,
      restartDaemon: async () => false,
    })
    expect(confirm).toHaveBeenCalledOnce()
    expect(result.updated).toBe(true)
  })
})
