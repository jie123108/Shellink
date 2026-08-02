import { createRequire } from 'node:module'
import type { Terminal as TerminalType } from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import type { SocketClient } from '../src/SocketClient.js'
import { renderTerminalLine, TerminalScreen } from '../src/tui.js'

const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as { Terminal: new (options?: object) => TerminalType }

describe('headless terminal rendering', () => {
  it('renders ANSI colors and the cursor from the xterm screen model', async () => {
    const terminal = new Terminal({ cols: 10, rows: 3, allowProposedApi: true })
    await new Promise<void>((resolve) => terminal.write('\x1b[31mR\x1b[0m', resolve))
    const line = renderTerminalLine(terminal, 0, 10, true)
    expect(line).toContain('\x1b[31mR\x1b[0m')
    expect(line).toContain('\x1b[7m')
    terminal.dispose()
  })

  it('pages through replayed history and jumps to the first and latest pages', async () => {
    const replay = Array.from({ length: 60 }, (_, index) => `history-${index + 1}\r\n`).join('')
    const unsubscribe = vi.fn(async () => {})
    const subscribe = vi.fn(async () => ({ initial: { state: { mode: 'AUTO' }, replay }, unsubscribe }))
    const request = vi.fn(async () => ({ ok: true }))
    const rerender = vi.fn()
    const screen = new TerminalScreen({ subscribe, request } as unknown as SocketClient, 'history-session', rerender, 'en-US')
    await screen.start()
    expect(request).toHaveBeenCalledWith('sessions.resize', expect.objectContaining({ id: 'history-session', cols: 80 }))
    await vi.waitFor(() => expect(screen.render(80).join('\n')).toContain('history-60'))

    screen.handleInput('\x1b[5~')
    const paged = screen.render(80).join('\n')
    expect(paged).not.toContain('history-60')
    expect(paged).toMatch(/history-\d+/)
    // One page up from the bottom should reveal earlier history, not the latest line.
    expect(paged).toContain('history-27')

    screen.handleInput('\x1b[H')
    expect(screen.render(80).join('\n')).toContain('history-1')

    screen.handleInput('\x1b[F')
    expect(screen.render(80).join('\n')).toContain('history-60')
    await screen.close()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('reconnects the event subscription after a daemon restart', async () => {
    const subscribe = vi.fn(async () => ({ initial: { state: { mode: 'AUTO' }, replay: '' }, unsubscribe: vi.fn(async () => {}), detach: vi.fn() }))
    const screen = new TerminalScreen({ subscribe, request: vi.fn(async () => ({ ok: true })) } as unknown as SocketClient, 'session-1', vi.fn(), 'en-US')
    await screen.start()
    await screen.reconnect()
    expect(subscribe).toHaveBeenCalledTimes(2)
  })

  it('releases MANUAL control with Ctrl+\\ without forwarding the shortcut', async () => {
    const unsubscribe = vi.fn(async () => {})
    const subscribe = vi.fn(async () => ({ initial: { state: { mode: 'AUTO' }, replay: '' }, unsubscribe }))
    const request = vi.fn(async () => ({ ok: true }))
    const rerender = vi.fn()
    const screen = new TerminalScreen({ subscribe, request } as unknown as SocketClient, 'mode-session', rerender, 'en-US')
    await screen.start()

    screen.handleInput('m')
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('sessions.mode', { id: 'mode-session', mode: 'MANUAL' }))
    await vi.waitFor(() => expect(screen.render(80).join('\n')).toContain('MANUAL'))
    expect(screen.render(80).join('\n')).toContain('Ctrl+\\ release control')

    request.mockClear()
    screen.handleInput('\x1c')
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('sessions.mode', { id: 'mode-session', mode: 'AUTO' }))
    expect(request).not.toHaveBeenCalledWith('sessions.input', expect.anything())
    await vi.waitFor(() => expect(screen.render(80).join('\n')).toContain('READ ONLY'))

    request.mockClear()
    await screen.close()
    expect(request).not.toHaveBeenCalledWith('sessions.mode', expect.anything())
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('recognizes kitty CSI-u encodings of Ctrl+] and Ctrl+\\', async () => {
    const subscribe = vi.fn(async () => ({ initial: { state: { mode: 'MANUAL' }, replay: '' }, unsubscribe: vi.fn(async () => {}) }))
    const request = vi.fn(async () => ({ ok: true }))
    const onExit = vi.fn()
    const screen = new TerminalScreen({ subscribe, request } as unknown as SocketClient, 'kitty-session', vi.fn(), 'en-US')
    screen.onExit = onExit
    await screen.start()

    // Kitty progressive enhancement: Ctrl+] → CSI 93 ; 5 u (not legacy \x1d)
    screen.handleInput('\x1b[93;5u')
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalledWith('sessions.input', expect.anything())

    request.mockClear()
    // Ctrl+\ → CSI 92 ; 5 u
    screen.handleInput('\x1b[92;5u')
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('sessions.mode', { id: 'kitty-session', mode: 'AUTO' }))
    expect(request).not.toHaveBeenCalledWith('sessions.input', expect.anything())

    // xterm modifyOtherKeys form should also work
    request.mockClear()
    onExit.mockClear()
    screen.handleInput('\x1b[27;5;93~')
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalledWith('sessions.input', expect.anything())

    await screen.close()
  })

  it('still forwards letter m while in MANUAL mode', async () => {
    const subscribe = vi.fn(async () => ({ initial: { state: { mode: 'MANUAL' }, replay: '' }, unsubscribe: vi.fn(async () => {}) }))
    const request = vi.fn(async () => ({ ok: true }))
    const screen = new TerminalScreen({ subscribe, request } as unknown as SocketClient, 'manual-session', vi.fn(), 'en-US')
    await screen.start()

    screen.handleInput('m')
    expect(request).toHaveBeenCalledWith('sessions.input', {
      id: 'manual-session',
      text: 'm',
      appendNewline: false,
      manual: true,
    })
    expect(request).not.toHaveBeenCalledWith('sessions.mode', expect.anything())

    // Kitty CSI-u printable must be decoded before forwarding to the PTY
    request.mockClear()
    screen.handleInput('\x1b[97u')
    expect(request).toHaveBeenCalledWith('sessions.input', {
      id: 'manual-session',
      text: 'a',
      appendNewline: false,
      manual: true,
    })
    await screen.close()
  })
})
