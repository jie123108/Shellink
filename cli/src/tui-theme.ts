import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

/** Semantic ANSI helpers — keep sequences explicit so unit tests can assert them. */
export const accent = (text: string) => `\x1b[36m${text}\x1b[0m`
export const green = (text: string) => `\x1b[32m${text}\x1b[0m`
export const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`
export const red = (text: string) => `\x1b[31m${text}\x1b[0m`
export const dim = (text: string) => `\x1b[2m${text}\x1b[0m`
export const bold = (text: string) => `\x1b[1m${text}\x1b[0m`
export const underline = (text: string) => `\x1b[4m${text}\x1b[0m`
export const inverse = (text: string) => `\x1b[7m${text}\x1b[0m`
/** Selection highlight: cyan background + black foreground. */
export const selected = (text: string) => `\x1b[46;30m${text}\x1b[0m`

export function padEndVisible(text: string, width: number): string {
  const visible = visibleWidth(text)
  if (visible >= width) return truncateToWidth(text, width, '')
  return text + ' '.repeat(width - visible)
}

export function padStartVisible(text: string, width: number): string {
  const visible = visibleWidth(text)
  if (visible >= width) return truncateToWidth(text, width, '')
  return ' '.repeat(width - visible) + text
}

/** Draw a single-line top border with optional left/right labels. */
export function borderTop(width: number, left = '', right = ''): string {
  const leftPart = left ? `─ ${left} ` : ''
  const rightPart = right ? ` ${right} ─` : ''
  const used = 2 + visibleWidth(leftPart) + visibleWidth(rightPart)
  const fill = Math.max(0, width - used)
  return accent(`┌${leftPart}${'─'.repeat(fill)}${rightPart}┐`)
}

export function borderBottom(width: number): string {
  return accent(`└${'─'.repeat(Math.max(0, width - 2))}┘`)
}

/** Content line inside a border: `│ content │` padded to width. */
export function borderRow(width: number, content: string): string {
  const inner = Math.max(0, width - 4)
  const padded = padEndVisible(truncateToWidth(content, inner, ''), inner)
  return `${accent('│')} ${padded} ${accent('│')}`
}

/** Multi-line bordered panel. First content line may sit under the title bar. */
export function borderedPanel(width: number, contentLines: string[], title = '', right = ''): string[] {
  const lines = [borderTop(width, title, right)]
  for (const line of contentLines) lines.push(borderRow(width, line))
  lines.push(borderBottom(width))
  return lines
}

/** Horizontal rule with a section label, e.g. `── Active (3) ────`. */
export function sectionRule(width: number, title: string): string {
  const label = `── ${title} `
  const fill = Math.max(0, width - visibleWidth(label))
  return accent(truncateToWidth(`${label}${'─'.repeat(fill)}`, width, ''))
}

export type SessionStateTone = 'active' | 'waiting' | 'outputting' | 'closed' | 'idle' | 'default'

export function sessionStateTone(state: string | undefined, active: boolean): SessionStateTone {
  if (!active) return 'closed'
  const upper = (state ?? '').toUpperCase()
  if (upper === 'WAITING_INPUT' || upper === 'WAITING') return 'waiting'
  if (upper === 'OUTPUTTING' || upper === 'RUNNING') return 'outputting'
  if (upper === 'IDLE') return 'idle'
  if (upper === 'DISCONNECTED' || upper === 'CLOSED') return 'closed'
  return active ? 'active' : 'closed'
}

export function styleByTone(text: string, tone: SessionStateTone): string {
  switch (tone) {
    case 'waiting': return yellow(text)
    case 'outputting': return accent(text)
    case 'idle':
    case 'active': return green(text)
    case 'closed': return dim(text)
    default: return text
  }
}

/** Join columns with two-space gaps, padding each to its width. */
export function formatColumns(cells: string[], widths: number[]): string {
  return cells.map((cell, index) => padEndVisible(cell, widths[index] ?? visibleWidth(cell))).join('  ')
}

export function columnWidths(rows: string[][], minWidths: number[] = []): number[] {
  if (rows.length === 0) return minWidths.slice()
  const cols = rows[0]!.length
  const widths = Array.from({ length: cols }, (_, index) => minWidths[index] ?? 0)
  for (const row of rows) {
    for (let index = 0; index < cols; index++) {
      widths[index] = Math.max(widths[index]!, visibleWidth(row[index] ?? ''))
    }
  }
  return widths
}
