import type { CliLocale } from './i18n.js'

type Writable = Pick<NodeJS.WriteStream, 'write'>

export type ProgressUpdate = {
  label: string
  received: number
  total?: number
  startedAt: number
}

export type ProgressReporter = {
  update(update: ProgressUpdate): void
  retry(message: string): void
  finish(update: ProgressUpdate): void
}

const labels = {
  'en-US': { downloaded: 'Downloaded' },
  'zh-CN': { downloaded: '已下载' },
} as const

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1)
  return `${(bytes / 1024 ** (index + 1)).toFixed(1)} ${units[index]}`
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
}

export function renderProgressLine(options: ProgressUpdate & {
  bytesPerSecond: number
  elapsedMs: number
  width?: number
}): string {
  const speed = options.bytesPerSecond > 0 ? ` ${formatBytes(options.bytesPerSecond)}/s` : ''
  if (options.total === undefined || options.total <= 0) {
    return `${options.label} ${formatBytes(options.received)}${speed}`
  }
  const ratio = Math.min(1, options.received / options.total)
  const percent = Math.round(ratio * 100)
  const width = options.width ?? 16
  const done = Math.round(ratio * width)
  const bar = `${'='.repeat(done)}${done < width ? '>' : ''}${' '.repeat(Math.max(0, width - done - 1))}`
  const remainingMs = options.bytesPerSecond > 0 ? (options.total - options.received) / options.bytesPerSecond * 1000 : 0
  const eta = remainingMs > 0 ? ` ETA ${formatDuration(remainingMs)}` : ''
  return `${options.label} ${String(percent).padStart(3)}% [${bar}] ${formatBytes(options.received)}/${formatBytes(options.total)}${speed}${eta}`
}

export function createProgressReporter(options: {
  stream: Writable
  isTty: boolean
  enabled: boolean
  locale: CliLocale
  now?: () => number
}): ProgressReporter {
  if (!options.enabled) return { update() {}, retry() {}, finish() {} }

  const now = options.now ?? Date.now
  let lastRenderedAt = 0
  let lastPercent = -1
  let ttyLine = false

  function write(line: string, replace = false): void {
    if (replace) {
      options.stream.write(`\r${line}\x1b[K`)
      ttyLine = true
    } else {
      if (ttyLine) options.stream.write('\n')
      options.stream.write(`${line}\n`)
      ttyLine = false
    }
  }

  function render(update: ProgressUpdate, force: boolean): void {
    const current = now()
    const elapsedMs = Math.max(1, current - update.startedAt)
    const bytesPerSecond = update.received / (elapsedMs / 1000)
    const line = renderProgressLine({ ...update, elapsedMs, bytesPerSecond })
    if (options.isTty) {
      if (force || current - lastRenderedAt >= 100) {
        write(line, true)
        lastRenderedAt = current
      }
      return
    }
    const percent = update.total ? Math.floor(update.received / update.total * 10) * 10 : -1
    if (force || percent > lastPercent || current - lastRenderedAt >= 5000) {
      write(line)
      lastPercent = percent
      lastRenderedAt = current
    }
  }

  return {
    update(update) {
      render(update, false)
    },
    retry(message) {
      write(message)
    },
    finish(update) {
      render(update, true)
      const elapsedMs = Math.max(1, now() - update.startedAt)
      const speed = update.received / (elapsedMs / 1000)
      write(`${labels[options.locale].downloaded} ${formatBytes(update.received)} in ${formatDuration(elapsedMs)} (${formatBytes(speed)}/s)`)
    },
  }
}
