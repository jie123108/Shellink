import { describe, expect, it } from 'vitest'
import { createProgressReporter, formatBytes, formatDuration, renderProgressLine } from '../src/progress.js'

describe('upgrade progress', () => {
  it('formats bytes and durations', () => {
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(12_582_912)).toBe('12.0 MB')
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
    expect(formatDuration(500)).toBe('1s')
    expect(formatDuration(62_000)).toBe('1m02s')
  })

  it('renders a determinate progress line', () => {
    const line = renderProgressLine({
      label: 'Downloading shellink',
      received: 5 * 1024 * 1024,
      total: 10 * 1024 * 1024,
      bytesPerSecond: 1024 * 1024,
      elapsedMs: 5000,
    })
    expect(line).toContain(' 50%')
    expect(line).toContain('5.0 MB/10.0 MB')
    expect(line).toContain('ETA 5s')
  })

  it('renders completed bars and unknown totals', () => {
    const complete = renderProgressLine({
      label: 'Downloading shellink',
      received: 100,
      total: 100,
      bytesPerSecond: 0,
      elapsedMs: 1000,
      width: 10,
    })
    expect(complete).toContain('100%')
    expect(complete).toContain('[==========]')
    expect(complete).not.toContain('ETA')

    const unknown = renderProgressLine({
      label: 'Downloading shellink',
      received: 1024,
      bytesPerSecond: 512,
      elapsedMs: 2000,
    })
    expect(unknown).toContain('1.0 KB')
    expect(unknown).not.toContain('[')
  })

  it('prints non-TTY milestones and remains silent when disabled', () => {
    const output: string[] = []
    let now = 0
    const stream = { write(value: string): true { output.push(value); return true } }
    const reporter = createProgressReporter({ stream, isTty: false, enabled: true, locale: 'en-US', now: () => now })
    reporter.update({ label: 'Downloading', received: 0, total: 100, startedAt: 0 })
    now = 100
    reporter.update({ label: 'Downloading', received: 10, total: 100, startedAt: 0 })
    now = 5200
    reporter.update({ label: 'Downloading', received: 15, total: 100, startedAt: 0 })
    reporter.retry('retrying...')
    reporter.finish({ label: 'Downloading', received: 100, total: 100, startedAt: 0 })
    const text = output.join('')
    expect(text).toContain(' 10%')
    expect(text).toContain('retrying...')
    expect(text).toContain('Downloaded')

    const zh: string[] = []
    createProgressReporter({
      stream: { write(value: string): true { zh.push(value); return true } },
      isTty: false,
      enabled: true,
      locale: 'zh-CN',
      now: () => 1000,
    }).finish({ label: 'Downloading', received: 2048, startedAt: 0 })
    expect(zh.join('')).toContain('已下载')

    const silent: string[] = []
    const disabled = createProgressReporter({
      stream: { write(value: string): true { silent.push(value); return true } },
      isTty: false,
      enabled: false,
      locale: 'en-US',
    })
    disabled.update({ label: 'Downloading', received: 1, startedAt: 0 })
    disabled.retry('ignored')
    disabled.finish({ label: 'Downloading', received: 1, startedAt: 0 })
    expect(silent).toEqual([])
  })

  it('redraws TTY progress in place and clears before plain lines', () => {
    const output: string[] = []
    let now = 0
    const stream = { write(value: string): true { output.push(value); return true } }
    const reporter = createProgressReporter({ stream, isTty: true, enabled: true, locale: 'en-US', now: () => now })
    reporter.update({ label: 'Downloading', received: 10, total: 100, startedAt: 0 })
    now = 50
    reporter.update({ label: 'Downloading', received: 20, total: 100, startedAt: 0 })
    now = 150
    reporter.update({ label: 'Downloading', received: 40, total: 100, startedAt: 0 })
    reporter.retry('retrying after stall')
    reporter.finish({ label: 'Downloading', received: 100, total: 100, startedAt: 0 })
    const text = output.join('')
    expect(text).toContain('\r')
    expect(text).toContain('\x1b[K')
    expect(text).toContain('retrying after stall')
    expect(text).toContain('Downloaded')
  })

  it('uses Date.now when a clock is not injected', () => {
    const output: string[] = []
    const reporter = createProgressReporter({
      stream: { write(value: string): true { output.push(value); return true } },
      isTty: false,
      enabled: true,
      locale: 'en-US',
    })
    reporter.finish({ label: 'Downloading', received: 1024, startedAt: Date.now() - 1000 })
    expect(output.join('')).toContain('Downloaded')
  })
})
