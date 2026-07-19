/* eslint-disable no-control-regex */

// CSI, OSC, single-character ESC sequences, and other C0 controls (preserving \n and \t).
const ANSI_PATTERN = new RegExp(
  [
    '\\u001B\\[[0-9;?]*[ -/]*[@-~]', // CSI sequence
    '\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)', // OSC sequence
    '\\u001B[@-Z\\\\-_]', // Other two-character ESC sequences
    '\\u001B\\([AB012]', // Character set switch
  ].join('|'),
  'g',
)

/**
 * Remove ANSI escape sequences and redundant control characters for plain-text history and AI use.
 *
 * Newline convention:
 * - `\r\n` → `\n`
 * - A standalone `\r` returns the terminal to the line start, not a newline, and is discarded.
 *   Converting it to `\n` would add a blank line after every history line.
 */
export function stripAnsi(input: string): string {
  return input
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}
