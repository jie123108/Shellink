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

  it.each([
    ['down press from Ghostty', '\x1b[1;1:1B', '\x1b[B'],
    ['down repeat from Ghostty', '\x1b[1;1:2B', '\x1b[B'],
    ['up press', '\x1b[1;1:1A', '\x1b[A'],
    ['up repeat', '\x1b[1;1:2A', '\x1b[A'],
    ['right repeat', '\x1b[1;1:2C', '\x1b[C'],
    ['left repeat', '\x1b[1;1:2D', '\x1b[D'],
    ['Ctrl+down repeat', '\x1b[1;5:2B', '\x1b[1;5B'],
    ['down with Caps Lock', '\x1b[1;65:1B', '\x1b[B'],
    ['Home', '\x1b[1;1:1H', '\x1b[H'],
    ['End', '\x1b[1;1:1F', '\x1b[F'],
    ['PageUp repeat', '\x1b[5;1:2~', '\x1b[5~'],
    ['PageDown repeat', '\x1b[6;1:2~', '\x1b[6~'],
    ['Delete', '\x1b[3;1:1~', '\x1b[3~'],
    ['F5 repeat', '\x1b[15;1:2~', '\x1b[15~'],
    ['CSI-u Enter', '\x1b[13u', '\r'],
    ['CSI-u Tab', '\x1b[9u', '\t'],
    ['CSI-u Escape', '\x1b[27u', '\x1b'],
    ['CSI-u Backspace', '\x1b[127u', '\x7f'],
    ['CSI-u Ctrl+C', '\x1b[99;5u', '\x03'],
    ['CSI-u Ctrl+U', '\x1b[117;5u', '\x15'],
    ['CSI-u Ctrl+Space', '\x1b[32;5u', '\x00'],
    ['CSI-u Alt+x', '\x1b[120;3u', '\x1bx'],
    ['CSI-u Shift+Tab', '\x1b[9;2u', '\x1b[Z'],
    ['CSI-u shifted letter', '\x1b[97:65;2u', 'A'],
    ['CSI-u Unicode', '\x1b[20013u', '中'],
    ['modifyOtherKeys Ctrl+C', '\x1b[27;5;99~', '\x03'],
    ['modifyOtherKeys Enter', '\x1b[27;1;13~', '\r'],
    ['legacy down', '\x1b[B', '\x1b[B'],
    ['legacy application down', '\x1bOB', '\x1bOB'],
    ['legacy Ctrl+up', '\x1b[1;5A', '\x1b[1;5A'],
    ['raw control', '\x03', '\x03'],
    ['pasted text containing an event sequence', '\x1b[200~text\x1b[1;1:2B\x1b[201~', '\x1b[200~text\x1b[1;1:2B\x1b[201~'],
  ])('forwards %s as legacy terminal input', async (_label, input, expected) => {
    const subscribe = vi.fn(async () => ({ initial: { state: { mode: 'MANUAL' }, replay: '' }, unsubscribe: vi.fn(async () => {}) }))
    const request = vi.fn(async () => ({ ok: true }))
    const screen = new TerminalScreen({ subscribe, request } as unknown as SocketClient, 'keys-session', vi.fn(), 'en-US')
    await screen.start()

    screen.handleInput(input)
    expect(request).toHaveBeenCalledWith('sessions.input', {
      id: 'keys-session', text: expected, appendNewline: false, manual: true,
    })
    await screen.close()
  })

  it.each(['\x1b[1;1:3B', '\x1b[1;1:3A', '\x1b[13;1:3u', '\x1b[97;1:3u', '\x1b[6;1:3~'])(
    'does not forward key releases %j', async (input) => {
      const subscribe = vi.fn(async () => ({ initial: { state: { mode: 'MANUAL' }, replay: '' }, unsubscribe: vi.fn(async () => {}) }))
      const request = vi.fn(async () => ({ ok: true }))
      const screen = new TerminalScreen({ subscribe, request } as unknown as SocketClient, 'release-session', vi.fn(), 'en-US')
      await screen.start()
      screen.handleInput(input)
      expect(request).not.toHaveBeenCalledWith('sessions.input', expect.anything())
      await screen.close()
    },
  )

  it('uses application cursor sequences when the remote application enables DECCKM', async () => {
    const subscribe = vi.fn(async () => ({ initial: { state: { mode: 'MANUAL' }, replay: '\x1b[?1hready' }, unsubscribe: vi.fn(async () => {}) }))
    const request = vi.fn(async () => ({ ok: true }))
    const screen = new TerminalScreen({ subscribe, request } as unknown as SocketClient, 'application-session', vi.fn(), 'en-US')
    await screen.start()
    await vi.waitFor(() => expect(screen.render(80).join('\n')).toContain('ready'))

    screen.handleInput('\x1b[1;1:2B')
    expect(request).toHaveBeenCalledWith('sessions.input', {
      id: 'application-session', text: '\x1bOB', appendNewline: false, manual: true,
    })
    await screen.close()
  })
})
