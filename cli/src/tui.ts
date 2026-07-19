import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import {
  Loader,
  matchesKey,
  ProcessTerminal,
  TUI,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
} from '@earendil-works/pi-tui'
import xtermHeadless from '@xterm/headless'
import type { Terminal as TerminalType } from '@xterm/headless'
import type { RpcEvent } from '@shellink/protocol'
import { SocketClient } from './SocketClient.js'
import { resolveCliLocale, t, type CliLocale } from './i18n.js'
import { formatSessionStartedAt } from './time.js'
import {
  accent,
  bold,
  borderBottom,
  borderRow,
  borderTop,
  borderedPanel,
  columnWidths,
  dim,
  formatColumns,
  inverse,
  padEndVisible,
  red,
  sectionRule,
  selected,
  sessionStateTone,
  styleByTone,
  underline,
  yellow,
} from './tui-theme.js'

const HeadlessTerminal = xtermHeadless.Terminal

interface TerminalDimensions { cols: number; rows: number }

let detectedTerminalSize: TerminalDimensions | null = null
let detectedTerminalSizeAt = 0

function readTerminalDimensions(): TerminalDimensions {
  try {
    const ttyFd = fs.openSync('/dev/tty', 'r')
    try {
      const output = execFileSync('/bin/stty', ['size'], {
        stdio: [ttyFd, 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim().split(/\s+/).map(Number)
      if (output.length === 2 && output.every((value) => Number.isInteger(value) && value > 0)) {
        return { rows: output[0]!, cols: output[1]! }
      }
    } finally {
      fs.closeSync(ttyFd)
    }
  } catch {
    // Fall through when there is no controlling terminal, for example on Windows.
  }

  const stdoutCols = Number(process.stdout.columns)
  const stdoutRows = Number(process.stdout.rows)
  if (Number.isInteger(stdoutCols) && stdoutCols >= 20 && Number.isInteger(stdoutRows) && stdoutRows >= 5) {
    return { cols: stdoutCols, rows: stdoutRows }
  }

  const envCols = Number(process.env.COLUMNS)
  const envRows = Number(process.env.LINES)
  if (Number.isInteger(envCols) && envCols >= 20 && Number.isInteger(envRows) && envRows >= 5) {
    return { cols: envCols, rows: envRows }
  }
  return { cols: 80, rows: 24 }
}

function terminalDimensions(): TerminalDimensions {
  const now = Date.now()
  if (!detectedTerminalSize || now - detectedTerminalSizeAt > 500) {
    detectedTerminalSize = readTerminalDimensions()
    detectedTerminalSizeAt = now
  }
  return detectedTerminalSize
}

function currentTerminalSize(width = terminalDimensions().cols): { cols: number; rows: number } {
  const dimensions = terminalDimensions()
  return {
    cols: Math.max(20, Math.min(500, width)),
    rows: Math.max(5, Math.min(200, dimensions.rows - 3)),
  }
}

/** pi-tui also falls back to 80x24 when Bun does not expose stdout dimensions. */
class ShellinkProcessTerminal extends ProcessTerminal {
  override get columns(): number { return terminalDimensions().cols }
  override get rows(): number { return terminalDimensions().rows }
  override start(onInput: (data: string) => void, onResize: () => void): void {
    super.start(onInput, () => {
      detectedTerminalSize = null
      onResize()
    })
  }
}

function paletteCode(value: number, background: boolean): string {
  if (value < 8) return String((background ? 40 : 30) + value)
  if (value < 16) return String((background ? 100 : 90) + value - 8)
  return `${background ? 48 : 38};5;${value}`
}

export function renderTerminalLine(terminal: TerminalType, absoluteRow: number, width: number, cursor: boolean): string {
  const line = terminal.buffer.active.getLine(absoluteRow)
  if (!line) return ''
  let result = ''
  for (let column = 0; column < Math.min(width, terminal.cols); column++) {
    const cell = line.getCell(column)
    if (!cell || cell.getWidth() === 0) continue
    const codes: string[] = []
    if (cell.isBold()) codes.push('1')
    if (cell.isDim()) codes.push('2')
    if (cell.isItalic()) codes.push('3')
    if (cell.isUnderline()) codes.push('4')
    if (cell.isInverse() || (cursor && column === terminal.buffer.active.cursorX)) codes.push('7')
    if (cell.isFgPalette()) codes.push(paletteCode(cell.getFgColor(), false))
    else if (cell.isFgRGB()) { const color = cell.getFgColor(); codes.push(`38;2;${color >> 16};${(color >> 8) & 255};${color & 255}`) }
    if (cell.isBgPalette()) codes.push(paletteCode(cell.getBgColor(), true))
    else if (cell.isBgRGB()) { const color = cell.getBgColor(); codes.push(`48;2;${color >> 16};${(color >> 8) & 255};${color & 255}`) }
    const char = cell.isInvisible() ? ' ' : (cell.getChars() || ' ')
    result += codes.length ? `\x1b[${codes.join(';')}m${char}\x1b[0m` : char
  }
  return result.replace(/ +$/, '')
}

type MessageKind = 'info' | 'error'

class HelpOverlay implements Component {
  constructor(
    private readonly locale: CliLocale,
    private readonly onClose: () => void,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const panelWidth = Math.min(width, 56)
    const body = t(this.locale, 'helpBody').split('\n')
    const content = [
      dim(t(this.locale, 'helpClose')),
      '',
      ...body,
    ]
    return borderedPanel(panelWidth, content, t(this.locale, 'helpTitle'))
  }

  handleInput(data: string): void {
    if (data === '?' || data === 'q' || matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || matchesKey(data, 'enter')) {
      this.onClose()
    }
  }
}

export class Dashboard implements Component {
  private view: 'sessions' | 'profiles' = 'sessions'
  private allItems: Array<Record<string, any>> = []
  private items: Array<Record<string, any>> = []
  private selected = 0
  private viewportStart = 0
  private loading = false
  private message = ''
  private messageKind: MessageKind = 'info'
  private searchMode = false
  private searchQuery = ''
  private searchDraft = ''
  private searchBefore = ''
  private helpOverlay: OverlayHandle | null = null
  private loader: Loader | null = null
  private loaderOverlay: OverlayHandle | null = null
  onOpenSession?: (id: string) => void
  onOpenProfile?: (id: string) => void
  onQuit?: () => void

  constructor(
    private readonly client: SocketClient,
    private readonly rerender: () => void,
    private readonly locale: CliLocale = resolveCliLocale(),
    private readonly tui?: TUI,
  ) {}

  invalidate(): void {}

  async refresh(): Promise<void> {
    this.loading = true
    this.message = ''
    this.startLoader()
    this.rerender()
    try {
      this.allItems = await this.client.request(this.view === 'sessions' ? 'sessions.list' : 'profiles.list')
      this.applySearch(this.searchQuery, false)
      this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1))
      this.keepSelectionVisible()
    } catch (error) {
      this.allItems = []
      this.items = []
      this.selected = 0
      this.viewportStart = 0
      this.setMessage(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      this.loading = false
      this.stopLoader()
      this.rerender()
    }
  }

  setMessage(message: string, kind: MessageKind = 'info'): void {
    this.message = message
    this.messageKind = kind
    this.rerender()
  }

  async reconnect(): Promise<void> {
    await this.refresh()
  }

  render(width: number): string[] {
    const header = this.renderHeader(width)
    const footer = this.renderFooter(width)
    const body: string[] = []

    if (this.message) {
      const styled = this.messageKind === 'error'
        ? red(truncateToWidth(t(this.locale, 'error', { message: this.message }), width))
        : yellow(truncateToWidth(this.message, width))
      body.push(styled)
    }

    if (this.searchMode) {
      body.push(truncateToWidth(accent(`/${this.searchDraft}`) + inverse(' '), width))
    } else if (this.searchQuery) {
      body.push(dim(truncateToWidth(t(this.locale, 'search', { query: this.searchQuery }), width)))
    }

    if (this.loading && !this.loaderOverlay) {
      body.push(dim(truncateToWidth(t(this.locale, 'loading'), width)))
      return this.fillViewport([...header, ...body, ...footer])
    }

    if (this.view === 'profiles' && this.items.length > 0) {
      const item = this.items[this.selected]!
      const target = item.connectType === 'command'
        ? t(this.locale, 'command', { command: item.command ?? '' })
        : t(this.locale, 'host', { host: `${item.username ? `${item.username}@` : ''}${item.host ?? ''}:${item.port ?? 22}` })
      body.push(dim(truncateToWidth(target, width)))
    }

    if (this.items.length === 0 && !this.loading) {
      body.push('')
      if (this.allItems.length > 0) {
        body.push(yellow(truncateToWidth(t(this.locale, 'noMatches'), width)))
      } else {
        body.push(dim(truncateToWidth(
          this.view === 'sessions' ? t(this.locale, 'noSessions') : t(this.locale, 'noProfiles'),
          width,
        )))
      }
      return this.fillViewport([...header, ...body, ...footer])
    }

    body.push('')
    body.push(...this.renderList(width))
    return this.fillViewport([...header, ...body, ...footer])
  }

  /** pi-tui's first paint does not clear the screen; short output sticks to the cursor (often bottom). */
  private fillViewport(lines: string[]): string[] {
    const rows = terminalDimensions().rows
    if (lines.length >= rows) return lines
    // Keep footer at the bottom by inserting blank lines before the last footer panel (3 lines).
    const footerHeight = 3
    const head = lines.slice(0, -footerHeight)
    const foot = lines.slice(-footerHeight)
    const pad = Math.max(0, rows - lines.length)
    return [...head, ...Array.from({ length: pad }, () => ''), ...foot]
  }

  private renderHeader(width: number): string[] {
    const sessions = t(this.locale, 'sessions')
    const profiles = t(this.locale, 'profiles')
    const tabSessions = this.view === 'sessions' ? underline(bold(`1 ${sessions}`)) : dim(`1 ${sessions}`)
    const tabProfiles = this.view === 'profiles' ? underline(bold(`2 ${profiles}`)) : dim(`2 ${profiles}`)
    const tabs = `${tabSessions}    ${tabProfiles}`

    let right = ''
    if (this.items.length > 0) {
      right = t(this.locale, 'position', { current: this.selected + 1, total: this.items.length })
      if (this.searchQuery || this.searchMode) {
        right += t(this.locale, 'total', { count: this.allItems.length })
      }
    }

    const titleRight = this.view === 'sessions' && this.allItems.length > 0
      ? t(this.locale, 'summary', {
        active: this.allItems.filter((item) => item.active === true).length,
        closed: this.allItems.filter((item) => item.active !== true).length,
      })
      : ''

    const inner = Math.max(0, width - 4)
    const leftPlain = `1 ${sessions}    2 ${profiles}`
    const space = Math.max(1, inner - visibleWidth(leftPlain) - visibleWidth(right))
    const tabLine = right ? `${tabs}${' '.repeat(space)}${dim(right)}` : tabs

    return [
      borderTop(width, 'Shellink', titleRight),
      borderRow(width, tabLine),
      borderBottom(width),
    ]
  }

  private renderFooter(width: number): string[] {
    const action = this.view === 'sessions' ? t(this.locale, 'openTerminal') : t(this.locale, 'createAndOpen')
    const controls = t(this.locale, 'controls', { action })
    // Prefer short controls when the full line would overflow badly.
    const text = visibleWidth(controls) > Math.max(0, width - 4)
      ? t(this.locale, 'controlsShort', { action })
      : controls
    return borderedPanel(width, [dim(text)])
  }

  private renderList(width: number): string[] {
    const lines: string[] = []
    const end = Math.min(this.items.length, this.viewportStart + this.visibleCount())

    if (this.view === 'sessions') {
      const rows = this.items.map((item) => this.sessionCells(item))
      const widths = columnWidths(rows, [8, 8, 4, 8, 8, 11])
      // Cap total so rows fit; shrink target column first.
      const markerWidth = 4 // `❯ ● `
      const gaps = (widths.length - 1) * 2
      let total = markerWidth + widths.reduce((sum, value) => sum + value, 0) + gaps
      if (total > width) {
        const overflow = total - width
        widths[4] = Math.max(6, (widths[4] ?? 8) - overflow)
      }

      let previousSessionGroup: boolean | undefined
      const activeCount = this.items.filter((item) => item.active === true).length
      const closedCount = this.items.length - activeCount

      for (let index = this.viewportStart; index < end; index++) {
        const item = this.items[index]!
        const isActive = item.active === true
        if (isActive !== previousSessionGroup) {
          const title = t(this.locale, isActive ? 'active' : 'closed')
          const count = isActive ? activeCount : closedCount
          lines.push(sectionRule(width, `${title} (${count})`))
          previousSessionGroup = isActive
        }
        const cells = this.sessionCells(item)
        const marker = isActive ? '●' : '○'
        const prefix = index === this.selected ? `❯ ${marker} ` : `  ${marker} `
        const tone = sessionStateTone(typeof item.state === 'string' ? item.state : undefined, isActive)
        const rowText = truncateToWidth(prefix + formatColumns(cells, widths), width)
        const styled = styleByTone(rowText, tone)
        lines.push(index === this.selected ? selected(padEndVisible(rowText, width)) : styled)
      }
      return lines
    }

    // Profiles view
    const rows = this.items.map((item) => [
      String(item.name ?? ''),
      item.connectType === 'command' ? 'COMMAND' : 'SSH',
    ])
    const widths = columnWidths(rows, [12, 7])
    for (let index = this.viewportStart; index < end; index++) {
      const item = this.items[index]!
      const prefix = index === this.selected ? '❯ ' : '  '
      const rowText = truncateToWidth(prefix + formatColumns(rows[index]!, widths), width)
      lines.push(index === this.selected ? selected(padEndVisible(rowText, width)) : rowText)
    }
    return lines
  }

  private sessionCells(item: Record<string, any>): string[] {
    const isActive = item.active === true
    const startedAt = typeof item.createdAt === 'number' ? formatSessionStartedAt(item.createdAt) : ''
    return [
      String(item.id ?? ''),
      isActive ? String(item.state ?? '') : '',
      String(item.mode ?? ''),
      String(item.profileName ?? ''),
      String(item.target ?? ''),
      startedAt,
    ]
  }

  handleInput(data: string): void {
    if (this.searchMode) { this.handleSearchInput(data); return }
    if (data === '?') { this.toggleHelp(); return }
    if (data === '/') { this.beginSearch(); return }
    if (data === 'q' || matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) return this.onQuit?.()
    if (data === '\t' || matchesKey(data, 'tab')) { this.switchView(this.view === 'sessions' ? 'profiles' : 'sessions'); return }
    if (data === '1') { this.switchView('sessions'); return }
    if (data === '2') { this.switchView('profiles'); return }
    if (data === 'h' || matchesKey(data, 'left')) { this.switchView('sessions'); return }
    if (data === 'l' || matchesKey(data, 'right')) { this.switchView('profiles'); return }
    if (data === 'r') { void this.refresh(); return }
    if (this.items.length === 0) { this.rerender(); return }
    if (data === 'j' || matchesKey(data, 'down')) this.moveSelection(1)
    else if (data === 'k' || matchesKey(data, 'up')) this.moveSelection(-1)
    else if (matchesKey(data, 'pageUp')) this.selected = Math.max(0, this.selected - this.visibleCount())
    else if (matchesKey(data, 'pageDown')) this.selected = Math.min(this.items.length - 1, this.selected + this.visibleCount())
    else if (data === 'g' || matchesKey(data, 'home')) this.selected = 0
    else if (data === 'G' || matchesKey(data, 'end')) this.selected = this.items.length - 1
    else if (matchesKey(data, 'enter')) {
      const id = this.items[this.selected]?.id
      if (typeof id === 'string') {
        if (this.view === 'sessions') this.onOpenSession?.(id)
        else this.onOpenProfile?.(id)
      }
    }
    this.keepSelectionVisible()
    this.rerender()
  }

  private closeHelp(): void {
    this.helpOverlay?.hide()
    this.helpOverlay = null
  }

  private toggleHelp(): void {
    if (!this.tui) return
    if (this.helpOverlay) {
      this.closeHelp()
      this.rerender()
      return
    }
    const overlay = new HelpOverlay(this.locale, () => {
      this.closeHelp()
      this.rerender()
    })
    this.helpOverlay = this.tui.showOverlay(overlay, {
      anchor: 'center',
      width: Math.min(56, terminalDimensions().cols - 4),
      maxHeight: '80%',
      margin: 1,
    })
  }

  private startLoader(): void {
    if (!this.tui || this.loader) return
    this.loader = new Loader(this.tui, accent, dim, t(this.locale, 'loading'))
    this.loaderOverlay = this.tui.showOverlay(this.loader, {
      anchor: 'center',
      nonCapturing: true,
      width: 28,
    })
  }

  private stopLoader(): void {
    this.loader?.stop()
    this.loaderOverlay?.hide()
    this.loader = null
    this.loaderOverlay = null
  }

  private switchView(view: 'sessions' | 'profiles'): void {
    if (this.view === view && !this.loading) return
    this.view = view
    this.selected = 0
    this.viewportStart = 0
    this.searchMode = false
    this.searchQuery = ''
    this.searchDraft = ''
    void this.refresh()
  }

  private visibleCount(): number {
    const searchRows = this.searchMode || this.searchQuery ? 1 : 0
    const sessionGroupRows = this.view === 'sessions'
      ? Number(this.items.some((item) => item.active === true)) + Number(this.items.some((item) => item.active !== true))
      : 0
    const messageRows = this.message ? 1 : 0
    const profileDetailRows = this.view === 'profiles' && this.items.length > 0 ? 1 : 0
    // header(3) + footer(3) + blank + optional chrome
    const chromeRows = 3 + 3 + 1 + searchRows + sessionGroupRows + messageRows + profileDetailRows
    return Math.max(1, terminalDimensions().rows - chromeRows)
  }

  private beginSearch(): void {
    this.searchMode = true
    this.searchBefore = this.searchQuery
    this.searchDraft = ''
    this.message = ''
    this.applySearch(this.searchDraft)
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.cancelSearch()
      return
    }
    if (this.items.length > 0) {
      let navigated = true
      if (matchesKey(data, 'down') || data === '\x0e') this.moveSelection(1)
      else if (matchesKey(data, 'up') || data === '\x10') this.moveSelection(-1)
      else if (matchesKey(data, 'pageUp')) this.selected = Math.max(0, this.selected - this.visibleCount())
      else if (matchesKey(data, 'pageDown')) this.selected = Math.min(this.items.length - 1, this.selected + this.visibleCount())
      else if (matchesKey(data, 'home')) this.selected = 0
      else if (matchesKey(data, 'end')) this.selected = this.items.length - 1
      else if (data.startsWith('\x1b[') || data.startsWith('\x1bO')) return
      else navigated = false
      if (navigated) {
        this.keepSelectionVisible()
        this.rerender()
        return
      }
    } else if (data.startsWith('\x1b[') || data.startsWith('\x1bO')) return
    if (matchesKey(data, 'enter')) {
      this.searchMode = false
      this.searchQuery = this.searchDraft
      this.applySearch(this.searchQuery, false)
      return
    }
    if (data === '\x7f' || data === '\b') {
      if (!this.searchDraft) {
        this.cancelSearch()
        return
      }
      this.searchDraft = Array.from(this.searchDraft).slice(0, -1).join('')
    } else if (data === '\x15') {
      this.searchDraft = ''
    } else {
      const printable = data.replace(/[\x00-\x1f\x7f]/g, '')
      if (!printable) return
      this.searchDraft += printable
    }
    this.applySearch(this.searchDraft)
  }

  private cancelSearch(): void {
    this.searchMode = false
    this.searchQuery = this.searchBefore
    this.searchDraft = this.searchQuery
    this.applySearch(this.searchQuery)
  }

  private applySearch(query: string, resetSelection = true): void {
    const needle = query.toLocaleLowerCase()
    this.items = needle
      ? this.allItems.filter((item) => this.searchableText(item).toLocaleLowerCase().includes(needle))
      : [...this.allItems]
    if (this.view === 'sessions') {
      this.items.sort((left, right) => Number(right.active === true) - Number(left.active === true))
    }
    if (resetSelection) {
      this.selected = 0
      this.viewportStart = 0
    }
    this.keepSelectionVisible()
    this.rerender()
  }

  private searchableText(item: Record<string, any>): string {
    if (this.view === 'sessions') {
      return [item.id, item.state, item.mode, item.profileName, item.target].filter(Boolean).join(' ')
    }
    return [item.name, item.connectType, item.command, item.username, item.host, item.port].filter((value) => value !== undefined && value !== null).join(' ')
  }

  /** Move selection by delta with wrap-around (last → first, first → last). */
  private moveSelection(delta: number): void {
    const count = this.items.length
    if (count === 0) return
    this.selected = ((this.selected + delta) % count + count) % count
  }

  private keepSelectionVisible(): void {
    if (this.items.length === 0) { this.viewportStart = 0; return }
    const count = this.visibleCount()
    if (this.selected < this.viewportStart) this.viewportStart = this.selected
    else if (this.selected >= this.viewportStart + count) this.viewportStart = this.selected - count + 1
    this.viewportStart = Math.max(0, Math.min(this.viewportStart, Math.max(0, this.items.length - count)))
  }
}

export class TerminalScreen implements Component {
  private readonly terminal = new HeadlessTerminal({ ...currentTerminalSize(), scrollback: 10_000, allowProposedApi: true })
  private manual = false
  private tookControl = false
  private remoteCols = 0
  private remoteRows = 0
  private subscription: Awaited<ReturnType<SocketClient['subscribe']>> | null = null
  onExit?: () => void

  constructor(
    private readonly client: SocketClient,
    private readonly sessionId: string,
    private readonly rerender: () => void,
    private readonly locale: CliLocale,
    private readonly tui?: TUI,
  ) {}

  invalidate(): void {}

  async start(): Promise<void> {
    this.subscription = await this.client.subscribe({ sessionId: this.sessionId, replay: true }, (event) => this.onEvent(event))
    const initial = this.subscription.initial as { state?: { mode?: string }; replay?: string }
    this.manual = initial.state?.mode === 'MANUAL'
    if (initial.replay) this.terminal.write(initial.replay, () => this.rerender())
    this.syncSize(currentTerminalSize())
  }

  async close(): Promise<void> {
    if (this.tookControl) await this.client.request('sessions.mode', { id: this.sessionId, mode: 'AUTO' }).catch(() => {})
    await this.subscription?.unsubscribe().catch(() => {}); this.terminal.dispose()
  }

  async reconnect(): Promise<void> {
    this.subscription?.detach()
    this.subscription = null
    this.remoteCols = 0
    this.remoteRows = 0
    await this.start()
  }

  render(width: number): string[] {
    const modeLabel = this.manual ? t(this.locale, 'manual') : t(this.locale, 'readOnly')
    const header = [
      borderTop(width, t(this.locale, 'session', { id: this.sessionId }), modeLabel),
      borderRow(width, this.manual ? selected(` ${modeLabel} `) : dim(` ${modeLabel} `)),
      borderBottom(width),
    ]

    const controls = this.manual
      ? t(this.locale, 'terminalControlsManual')
      : t(this.locale, 'terminalControlsReadOnly')
    const footer = borderedPanel(width, [dim(controls)])

    const chromeRows = header.length + footer.length
    const bodyRows = Math.max(1, terminalDimensions().rows - chromeRows)
    this.syncSize({ cols: Math.max(20, Math.min(500, width)), rows: bodyRows })

    const buffer = this.terminal.buffer.active
    const start = Math.max(0, buffer.viewportY)
    const body: string[] = []
    for (let row = 0; row < bodyRows; row++) {
      const absoluteRow = start + row
      const cursor = absoluteRow === buffer.baseY + buffer.cursorY
      const line = renderTerminalLine(this.terminal, absoluteRow, width, cursor)
      body.push(truncateToWidth(line, width))
    }

    return [...header, ...body, ...footer]
  }

  handleInput(data: string): void {
    if (data === '\u001d') { this.onExit?.(); return }
    if (!this.manual) {
      if (data === '\x1b[5~') { this.terminal.scrollPages(-1); this.rerender(); return }
      if (data === '\x1b[6~') { this.terminal.scrollPages(1); this.rerender(); return }
      if (data === '\x1b[H' || data === '\x1bOH') { this.terminal.scrollToTop(); this.rerender(); return }
      if (data === '\x1b[F' || data === '\x1bOF') { this.terminal.scrollToBottom(); this.rerender(); return }
    }
    if (!this.manual && data === 'm') {
      void this.client.request('sessions.mode', { id: this.sessionId, mode: 'MANUAL' }).then(() => { this.manual = true; this.tookControl = true; this.rerender() })
      return
    }
    if (this.manual && data === '\x1c') {
      void this.client.request('sessions.mode', { id: this.sessionId, mode: 'AUTO' }).then(() => {
        this.manual = false
        this.tookControl = false
        this.rerender()
      })
      return
    }
    if (this.manual) void this.client.request('sessions.input', { id: this.sessionId, text: data, appendNewline: false, manual: true }).catch(() => {})
  }

  private onEvent(event: RpcEvent): void {
    const data = event.data as Record<string, any>
    if (event.event === 'session.data' && typeof data.raw === 'string') this.terminal.write(data.raw, () => this.rerender())
    if (event.event === 'session.mode') {
      this.manual = data.mode === 'MANUAL'
      if (!this.manual) this.tookControl = false
      this.rerender()
    }
    if (event.event === 'session.closed') this.rerender()
  }

  private syncSize(size: { cols: number; rows: number }): void {
    if (this.terminal.cols !== size.cols || this.terminal.rows !== size.rows) {
      this.terminal.resize(size.cols, size.rows)
    }
    if (this.remoteCols === size.cols && this.remoteRows === size.rows) return
    this.remoteCols = size.cols
    this.remoteRows = size.rows
    void this.client.request('sessions.resize', { id: this.sessionId, ...size }).catch(() => {
      if (this.remoteCols === size.cols && this.remoteRows === size.rows) {
        this.remoteCols = 0
        this.remoteRows = 0
      }
    })
  }
}

export async function runTui(client: SocketClient, locale = resolveCliLocale()): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(t(locale, 'interactiveRequired'))
  const tui = new TUI(new ShellinkProcessTerminal())
  let screen: Component
  let reconnecting = false
  let stopped = false
  let finish!: () => void
  const done = new Promise<void>((resolve) => { finish = resolve })
  const dashboard = new Dashboard(client, () => tui.requestRender(), locale, tui)
  screen = dashboard; tui.addChild(screen); tui.setFocus(screen)
  const reconnect = async (): Promise<void> => {
    if (reconnecting || stopped) return
    reconnecting = true
    while (!stopped) {
      try {
        await client.connect()
        if (screen === dashboard) await dashboard.reconnect()
        else if (screen instanceof TerminalScreen) await screen.reconnect()
        reconnecting = false
        tui.requestRender()
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    reconnecting = false
  }
  const onDisconnected = () => { void reconnect() }
  client.on('disconnected', onDisconnected)
  dashboard.onQuit = () => { tui.stop(); finish() }
  const openSession = (id: string) => {
    const terminal = new TerminalScreen(client, id, () => tui.requestRender(), locale, tui)
    tui.removeChild(screen); screen = terminal; tui.addChild(screen); tui.setFocus(screen)
    terminal.onExit = () => void terminal.close().finally(() => {
      tui.removeChild(screen); screen = dashboard; tui.addChild(screen); tui.setFocus(screen); void dashboard.refresh()
    })
    void terminal.start().catch(() => terminal.onExit?.())
  }
  dashboard.onOpenSession = openSession
  dashboard.onOpenProfile = (profileId) => {
    dashboard.setMessage(t(locale, 'creatingSession'), 'info')
    void client.request<{ id: string }>('sessions.create', { profileId, ...currentTerminalSize() })
      .then((session) => openSession(session.id))
      .catch((error) => dashboard.setMessage(
        t(locale, 'createSessionFailed', { message: error instanceof Error ? error.message : String(error) }),
        'error',
      ))
  }
  await dashboard.refresh(); tui.start(); await done
  stopped = true
  client.off('disconnected', onDisconnected)
}
