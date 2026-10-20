const SHIFT = 1
const ALT = 2
const CTRL = 4
const LOCKS = 64 | 128

/** Translate the local TUI's enhanced keyboard protocol for a legacy remote PTY. */
export function remoteTerminalInput(data: string, applicationCursorKeys: boolean): string {
  // Only match a complete key event. In particular, never rewrite pasted text.
  const navigation = /^\x1b\[(\d+);(\d+):([123])([ABCDHFPQRS~])$/.exec(data)
  if (navigation) {
    const [, key, rawModifier, event, final] = navigation
    if (event === '3') return ''
    const modifier = ((Number(rawModifier) - 1) & ~LOCKS) + 1
    if (modifier === 1) {
      if (final === '~') return `\x1b[${key}~`
      if (key === '1') {
        const application = applicationCursorKeys || 'PQRS'.includes(final!)
        return `\x1b${application ? 'O' : '['}${final}`
      }
    }
    return `\x1b[${key};${modifier}${final}`
  }

  // Kitty CSI-u, including alternate shifted/base keys, or xterm modifyOtherKeys.
  const kitty = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+)(?::([123]))?)?u$/.exec(data)
  const xterm = /^\x1b\[27;(\d+);(\d+)~$/.exec(data)
  if (!kitty && !xterm) return data
  if (kitty?.[5] === '3') return ''
  const modifier = (Number(kitty ? (kitty[4] ?? 1) : xterm![1]) - 1) & ~LOCKS
  // Preserve encodings with modifiers that have no legacy equivalent.
  if (modifier & ~(SHIFT | ALT | CTRL)) return data
  let codepoint = Number(kitty ? kitty[1] : xterm![2])
  if (kitty?.[2] && (modifier & SHIFT) && !(modifier & CTRL)) codepoint = Number(kitty[2])
  // Kitty also defines private-use aliases for these four control keys.
  codepoint = ({ 57344: 27, 57345: 13, 57346: 9, 57347: 127 } as Record<number, number>)[codepoint] ?? codepoint
  if (codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) return data

  let text: string
  if (codepoint === 9 && (modifier & SHIFT)) {
    text = '\x1b[Z'
  } else if (modifier & CTRL) {
    if (codepoint === 32 || codepoint === 50 || codepoint === 64) codepoint = 0
    else if (codepoint === 63 || codepoint === 56) codepoint = 127
    else if (codepoint === 127) codepoint = 8
    else if (codepoint >= 51 && codepoint <= 55) codepoint -= 24
    else if ((codepoint >= 65 && codepoint <= 95) || (codepoint >= 97 && codepoint <= 122)) codepoint &= 0x1f
    else if (codepoint > 31) return data
    text = String.fromCodePoint(codepoint)
  } else {
    text = String.fromCodePoint(codepoint)
  }
  return modifier & ALT ? `\x1b${text}` : text
}
