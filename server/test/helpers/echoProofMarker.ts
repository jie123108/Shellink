/**
 * Reconstruct the marker text from an echo-proof `printf '\n%s%s\n' 'A' 'B'` command
 * (see `FileTransfer.echoProofEcho`). A naive regex like `/MARKER_PREFIX_[\w]+/` run
 * against the raw written chunk stops at the first `'` and only captures half of
 * the marker, so scripted-session tests must use this instead.
 */
export function extractEchoProofMarker(chunk: string): string | null {
  const m = /printf '\\n%s%s\\n' '([^']*)' '([^']*)'/.exec(chunk)
  return m ? `${m[1] ?? ''}${m[2] ?? ''}` : null
}
