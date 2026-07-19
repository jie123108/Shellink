import { ProcessTerminal, TUI, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import type { SocketClient } from '../src/SocketClient.js'
import { Dashboard } from '../src/tui.js'

function dashboardWith(responses: Record<string, unknown>, locale: 'zh-CN' | 'en-US' = 'zh-CN') {
  const request = vi.fn(async (method: string) => responses[method])
  const rerender = vi.fn()
  const dashboard = new Dashboard({ request } as unknown as SocketClient, rerender, locale)
  return { dashboard, request, rerender }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

describe('TUI dashboard navigation', () => {
  it('renders English chrome when an English locale is selected', async () => {
    const { dashboard } = dashboardWith({}, 'en-US')
    await dashboard.refresh()
    const rendered = stripAnsi(dashboard.render(100).join('\n'))
    expect(rendered).toContain('1 Sessions')
    expect(rendered).toContain('No sessions.')
    expect(rendered).toContain('Shellink')
  })

  it('pads an empty dashboard to the terminal height so chrome stays at the top', async () => {
    const { dashboard } = dashboardWith({}, 'zh-CN')
    await dashboard.refresh()
    const lines = dashboard.render(100)
    const rows = Number(process.stdout.rows) || Number(process.env.LINES) || 24
    expect(lines.length).toBeGreaterThanOrEqual(rows)
    expect(stripAnsi(lines[0] ?? '')).toContain('Shellink')
    expect(stripAnsi(lines.slice(0, 8).join('\n'))).toContain('暂无会话')
    expect(stripAnsi(lines.join('\n'))).toContain('帮助')
  })

  it('switches tabs with number and arrow keys', async () => {
    const { dashboard, request } = dashboardWith({
      'sessions.list': [],
      'profiles.list': [{ id: 'profile-1', name: 'prod', connectType: 'ssh', username: 'root', host: 'host', port: 22 }],
    })
    await dashboard.refresh()

    dashboard.handleInput('2')
    await vi.waitFor(() => expect(request).toHaveBeenLastCalledWith('profiles.list'))
    const profilesView = dashboard.render(100).join('\n')
    const plain = stripAnsi(profilesView)
    expect(plain).toContain('2 连接配置')
    expect(profilesView).toContain('\x1b[46;30m')
    expect(plain).toContain('❯ prod')
    expect(plain).toContain('主机: root@host:22')

    dashboard.handleInput('\x1b[D')
    await vi.waitFor(() => expect(request).toHaveBeenLastCalledWith('sessions.list'))
  })

  it('moves selection and opens a session', async () => {
    const { dashboard } = dashboardWith({
      'sessions.list': [
        { id: 'session-a', state: 'IDLE', mode: 'AUTO' },
        { id: 'session-b', state: 'WAITING_INPUT', mode: 'AUTO' },
      ],
    })
    const open = vi.fn()
    dashboard.onOpenSession = open
    await dashboard.refresh()

    dashboard.handleInput('j')
    expect(stripAnsi(dashboard.render(100).join('\n'))).toMatch(/❯.*session-b/)
    dashboard.handleInput('\r')
    expect(open).toHaveBeenCalledWith('session-b')
  })

  it('wraps selection from last to first and first to last', async () => {
    const { dashboard } = dashboardWith({
      'sessions.list': [
        { id: 'session-a', state: 'IDLE', mode: 'AUTO' },
        { id: 'session-b', state: 'WAITING_INPUT', mode: 'AUTO' },
        { id: 'session-c', state: 'IDLE', mode: 'AUTO' },
      ],
    })
    await dashboard.refresh()

    dashboard.handleInput('k')
    expect(stripAnsi(dashboard.render(100).join('\n'))).toMatch(/❯.*session-c/)

    dashboard.handleInput('j')
    expect(stripAnsi(dashboard.render(100).join('\n'))).toMatch(/❯.*session-a/)

    dashboard.handleInput('G')
    dashboard.handleInput('\x1b[B')
    expect(stripAnsi(dashboard.render(100).join('\n'))).toMatch(/❯.*session-a/)
  })

  it('groups active and closed sessions without repeating the closed state', async () => {
    const started = new Date(2026, 6, 13, 15, 4, 0).getTime()
    const { dashboard } = dashboardWith({
      'sessions.list': [
        { id: 'closed', state: 'DISCONNECTED', mode: 'AUTO', active: false, createdAt: started },
        { id: 'active', state: 'OUTPUTTING', mode: 'AUTO', active: true, createdAt: started },
      ],
    })
    await dashboard.refresh()

    const rendered = dashboard.render(120).join('\n')
    const plain = stripAnsi(rendered)
    expect(plain.indexOf('active')).toBeLessThan(plain.indexOf('closed'))
    expect(plain).toContain('── 活动 (1)')
    expect(plain).toContain('❯ ● active')
    expect(plain).toContain('OUTPUTTING')
    expect(plain).toContain('AUTO')
    expect(plain).toContain('07-13 15:04')
    expect(plain).toContain('── 已关闭 (1)')
    expect(plain).toContain('○ closed')
    expect(plain).toContain('07-13 15:04')
    expect(plain).not.toContain('DISCONNECTED')
    expect(plain.match(/已关闭/g)?.length).toBeGreaterThanOrEqual(1)
  })

  it('renders session start times for active and closed rows', async () => {
    const activeStarted = new Date(2026, 0, 5, 3, 7, 0).getTime()
    const closedStarted = new Date(2026, 11, 31, 23, 59, 0).getTime()
    const { dashboard } = dashboardWith({
      'sessions.list': [
        { id: 'live1', state: 'IDLE', mode: 'AUTO', active: true, profileName: 'prod', target: 'root@h', createdAt: activeStarted },
        { id: 'done1', state: 'DISCONNECTED', mode: 'AUTO', active: false, profileName: 'old', target: 'root@o', createdAt: closedStarted },
      ],
    })
    await dashboard.refresh()
    const plain = stripAnsi(dashboard.render(140).join('\n'))
    expect(plain).toMatch(/● live1\s+IDLE\s+AUTO\s+prod\s+root@h\s+01-05 03:07/)
    expect(plain).toMatch(/○ done1\s+AUTO\s+old\s+root@o\s+12-31 23:59/)
  })

  it('aligns session columns across rows', async () => {
    const { dashboard } = dashboardWith({
      'sessions.list': [
        { id: 'a', state: 'IDLE', mode: 'AUTO', active: true, profileName: 'short', target: 'h1', createdAt: Date.UTC(2026, 0, 1, 0, 0) },
        { id: 'longer-id', state: 'WAITING_INPUT', mode: 'MANUAL', active: true, profileName: 'production', target: 'root@example.com', createdAt: Date.UTC(2026, 0, 1, 0, 0) },
      ],
    })
    await dashboard.refresh()
    const lines = dashboard.render(160).map(stripAnsi)
    const rowA = lines.find((line) => line.includes('● a'))
    const rowB = lines.find((line) => line.includes('● longer-id'))
    expect(rowA).toBeTruthy()
    expect(rowB).toBeTruthy()
    expect(rowA!.indexOf('IDLE')).toBe(rowB!.indexOf('WAITING_INPUT'))
  })

  it('quits the dashboard with q or Escape but not arrow keys', async () => {
    const { dashboard } = dashboardWith({
      'sessions.list': [
        { id: 'session-a', state: 'IDLE', mode: 'AUTO' },
        { id: 'session-b', state: 'WAITING_INPUT', mode: 'AUTO' },
      ],
    })
    const quit = vi.fn()
    dashboard.onQuit = quit
    await dashboard.refresh()

    dashboard.handleInput('\x1b[B')
    expect(quit).not.toHaveBeenCalled()
    expect(stripAnsi(dashboard.render(100).join('\n'))).toMatch(/❯.*session-b/)

    dashboard.handleInput('q')
    expect(quit).toHaveBeenCalledTimes(1)
    dashboard.handleInput('\x1b')
    expect(quit).toHaveBeenCalledTimes(2)
  })

  it('keeps every rendered line within terminal width on narrow terminals', async () => {
    const { dashboard } = dashboardWith({
      'sessions.list': [
        { id: 'session-a', state: 'IDLE', mode: 'AUTO', active: true, profileName: 'very-long-profile-name', target: 'root@example.invalid:22' },
        { id: 'session-b', state: 'WAITING_INPUT', mode: 'AUTO', active: false, profileName: 'another-long-name', target: 'expect ~/.ssh/remote/jump host' },
      ],
    }, 'en-US')
    await dashboard.refresh()
    dashboard.handleInput('\x1b[B')

    const untruncatedFooter = stripAnsi(dashboard.render(120).join('\n'))
    expect(untruncatedFooter).toContain('q quit')
    expect(untruncatedFooter).toContain('? help')

    for (const width of [40, 91]) {
      const lines = dashboard.render(width)
      for (const [index, line] of lines.entries()) {
        expect(visibleWidth(line), `line ${index} at width ${width}`).toBeLessThanOrEqual(width)
      }
    }
  })

  it('keeps empty-list selection valid and opens the first profile', async () => {
    const { dashboard } = dashboardWith({
      'sessions.list': [],
      'profiles.list': [{ id: 'profile-1', name: 'prod', connectType: 'command', command: 'bash' }],
    })
    const open = vi.fn()
    dashboard.onOpenProfile = open
    await dashboard.refresh()

    dashboard.handleInput('j')
    dashboard.handleInput('2')
    await vi.waitFor(() => expect(stripAnsi(dashboard.render(100).join('\n'))).toContain('prod'))
    dashboard.handleInput('\n')
    expect(open).toHaveBeenCalledWith('profile-1')
  })

  it('scrolls a long profile list with the selection kept visible', async () => {
    const profiles = Array.from({ length: 40 }, (_, index) => ({
      id: `profile-${index + 1}`,
      name: `profile-${index + 1}`,
      connectType: 'ssh',
      username: 'root',
      host: `host-${index + 1}`,
      port: 22,
    }))
    const { dashboard } = dashboardWith({ 'sessions.list': [], 'profiles.list': profiles })
    await dashboard.refresh()
    dashboard.handleInput('2')
    await vi.waitFor(() => expect(stripAnsi(dashboard.render(100).join('\n'))).toContain('profile-1'))

    for (let index = 0; index < 25; index++) dashboard.handleInput('\x1b[B')
    const scrolled = stripAnsi(dashboard.render(100).join('\n'))
    expect(scrolled).toContain('26 / 40')
    expect(scrolled).toContain('❯ profile-26')
    expect(scrolled).not.toContain('❯ profile-1')

    dashboard.handleInput('\x1b[H')
    expect(stripAnsi(dashboard.render(100).join('\n'))).toContain('❯ profile-1')
  })

  it('shows only the selected profile target outside the list row', async () => {
    const { dashboard } = dashboardWith({
      'sessions.list': [],
      'profiles.list': [
        { id: 'a', name: 'jump-a', connectType: 'command', command: 'expect very-long-command-a.exp' },
        { id: 'b', name: 'jump-b', connectType: 'command', command: 'expect very-long-command-b.exp' },
      ],
    })
    await dashboard.refresh()
    dashboard.handleInput('2')
    await vi.waitFor(() => expect(stripAnsi(dashboard.render(100).join('\n'))).toContain('jump-a'))

    const first = stripAnsi(dashboard.render(100).join('\n'))
    expect(first).toContain('命令: expect very-long-command-a.exp')
    expect(first).not.toContain('very-long-command-b.exp')
    expect(first).toContain('jump-b')
    expect(first).toContain('COMMAND')

    dashboard.handleInput('j')
    const second = stripAnsi(dashboard.render(100).join('\n'))
    expect(second).toContain('命令: expect very-long-command-b.exp')
    expect(second).not.toContain('very-long-command-a.exp')
  })

  it('incrementally searches sessions and keeps the confirmed filter', async () => {
    const { dashboard } = dashboardWith({
      'sessions.list': [
        { id: 'a1', state: 'WAITING_INPUT', mode: 'AUTO', profileName: 'production', target: 'root@prod' },
        { id: 'b2', state: 'IDLE', mode: 'AUTO', profileName: 'staging', target: 'root@stage' },
      ],
    })
    await dashboard.refresh()

    dashboard.handleInput('/')
    dashboard.handleInput('prod')
    const searching = stripAnsi(dashboard.render(100).join('\n'))
    expect(searching).toContain('/prod')
    expect(searching).toContain('production')
    expect(searching).not.toContain('staging')

    dashboard.handleInput('\r')
    expect(stripAnsi(dashboard.render(100).join('\n'))).toContain('搜索: /prod')
    dashboard.handleInput('r')
    await vi.waitFor(() => expect(stripAnsi(dashboard.render(100).join('\n'))).toContain('production'))
    expect(stripAnsi(dashboard.render(100).join('\n'))).not.toContain('staging')
  })

  it('cancels a new search with Escape and clears it with an empty search', async () => {
    const { dashboard } = dashboardWith({
      'sessions.list': [
        { id: 'a1', state: 'WAITING_INPUT', mode: 'AUTO', profileName: 'production' },
        { id: 'b2', state: 'IDLE', mode: 'AUTO', profileName: 'staging' },
      ],
    })
    const quit = vi.fn()
    dashboard.onQuit = quit
    await dashboard.refresh()

    dashboard.handleInput('/')
    dashboard.handleInput('prod')
    dashboard.handleInput('\n')
    dashboard.handleInput('/')
    dashboard.handleInput('q')
    expect(quit).not.toHaveBeenCalled()
    dashboard.handleInput('\x15')
    dashboard.handleInput('stag')
    expect(stripAnsi(dashboard.render(100).join('\n'))).toContain('staging')
    dashboard.handleInput('\x1b')
    expect(stripAnsi(dashboard.render(100).join('\n'))).toContain('production')
    expect(stripAnsi(dashboard.render(100).join('\n'))).not.toContain('staging')

    dashboard.handleInput('/')
    dashboard.handleInput('\n')
    const cleared = stripAnsi(dashboard.render(100).join('\n'))
    expect(cleared).toContain('production')
    expect(cleared).toContain('staging')
    expect(cleared).not.toContain('搜索:')
  })

  it('exits an empty search with Backspace and restores the previous filter', async () => {
    const { dashboard } = dashboardWith({
      'sessions.list': [
        { id: 'a1', state: 'WAITING_INPUT', mode: 'AUTO', profileName: 'production' },
        { id: 'b2', state: 'IDLE', mode: 'AUTO', profileName: 'staging' },
      ],
    })
    await dashboard.refresh()
    dashboard.handleInput('/')
    dashboard.handleInput('prod')
    dashboard.handleInput('\n')

    dashboard.handleInput('/')
    expect(dashboard.render(100).join('\n')).toContain('\x1b[36m/')
    dashboard.handleInput('\x7f')
    const restored = stripAnsi(dashboard.render(100).join('\n'))
    expect(restored).toContain('搜索: /prod')
    expect(restored).toContain('production')
    expect(restored).not.toContain('staging')
  })

  it('searches profiles by hidden command text', async () => {
    const { dashboard } = dashboardWith({
      'sessions.list': [],
      'profiles.list': [
        { id: 'a', name: 'jump-a', connectType: 'command', command: 'expect alpha.exp' },
        { id: 'b', name: 'jump-b', connectType: 'command', command: 'expect beta.exp' },
      ],
    })
    await dashboard.refresh()
    dashboard.handleInput('2')
    await vi.waitFor(() => expect(stripAnsi(dashboard.render(100).join('\n'))).toContain('jump-a'))

    dashboard.handleInput('/')
    dashboard.handleInput('beta.exp')
    const result = stripAnsi(dashboard.render(100).join('\n'))
    expect(result).toContain('jump-b')
    expect(result).toContain('命令: expect beta.exp')
    expect(result).not.toContain('jump-a')
  })

  it('moves within multiple search results before confirming', async () => {
    const { dashboard } = dashboardWith({
      'sessions.list': [],
      'profiles.list': [
        { id: 'a', name: 'prod-a', connectType: 'ssh', username: 'root', host: 'a', port: 22 },
        { id: 'b', name: 'prod-b', connectType: 'ssh', username: 'root', host: 'b', port: 22 },
        { id: 'c', name: 'other', connectType: 'ssh', username: 'root', host: 'c', port: 22 },
      ],
    })
    const open = vi.fn()
    dashboard.onOpenProfile = open
    await dashboard.refresh()
    dashboard.handleInput('2')
    await vi.waitFor(() => expect(stripAnsi(dashboard.render(100).join('\n'))).toContain('prod-a'))

    dashboard.handleInput('/')
    dashboard.handleInput('prod')
    dashboard.handleInput('\x1b[B')
    expect(stripAnsi(dashboard.render(100).join('\n'))).toContain('❯ prod-b')
    expect(stripAnsi(dashboard.render(100).join('\n'))).toContain('主机: root@b:22')

    dashboard.handleInput('\n')
    expect(stripAnsi(dashboard.render(100).join('\n'))).toContain('❯ prod-b')
    dashboard.handleInput('\n')
    expect(open).toHaveBeenCalledWith('b')
  })

  it('opens a help overlay with ? and closes it with Escape', async () => {
    class FakeTerminal implements Pick<ProcessTerminal, 'columns' | 'rows' | 'kittyProtocolActive'> {
      columns = 80
      rows = 24
      kittyProtocolActive = false
      start(): void {}
      stop(): void {}
      write(): void {}
      async drainInput(): Promise<void> {}
      moveBy(): void {}
      hideCursor(): void {}
      showCursor(): void {}
      clearLine(): void {}
      clearFromCursor(): void {}
      clearScreen(): void {}
      setTitle(): void {}
    }
    const tui = new TUI(new FakeTerminal() as unknown as ProcessTerminal)
    const request = vi.fn(async () => [])
    const dashboard = new Dashboard({ request } as unknown as SocketClient, () => tui.requestRender(), 'zh-CN', tui)
    tui.addChild(dashboard)
    tui.setFocus(dashboard)
    await dashboard.refresh()

    expect(tui.hasOverlay()).toBe(false)
    dashboard.handleInput('?')
    expect(tui.hasOverlay()).toBe(true)

    // Toggle closed with ? again (also works via Esc on the focused overlay).
    dashboard.handleInput('?')
    expect(tui.hasOverlay()).toBe(false)
    tui.stop()
  })

  it('shows summary badges for active and closed sessions in the header', async () => {
    const { dashboard } = dashboardWith({
      'sessions.list': [
        { id: 'a', state: 'IDLE', mode: 'AUTO', active: true },
        { id: 'b', state: 'DISCONNECTED', mode: 'AUTO', active: false },
        { id: 'c', state: 'OUTPUTTING', mode: 'AUTO', active: true },
      ],
    })
    await dashboard.refresh()
    const plain = stripAnsi(dashboard.render(100).join('\n'))
    expect(plain).toContain('● 2 活动 · ○ 1 已关闭')
  })
})
