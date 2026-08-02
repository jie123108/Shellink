import crypto from 'node:crypto'
import path from 'node:path'
import { config } from '../config.js'
import type { BaseSession } from './BaseSession.js'
import type { SessionOpLock } from './SessionOpLock.js'
import { TransferError } from './TransferError.js'

export type TransferCodec = 'base64' | 'openssl' | 'python3' | 'xxd'

export { TransferError }

export interface TransferMeta {
  remotePath: string
  size: number
  sha256: string
  codec: TransferCodec
  durationMs: number
}

export interface DownloadResult extends TransferMeta {
  data: Buffer
}

/** FileTransfer 仅依赖 history 读取，避免与 SessionManager 循环引用 */
export interface TransferHistorySource {
  history(sessionId: string, since?: number, limit?: number): { cursor: number; text: string }
}

interface CodecSpec {
  name: TransferCodec
  encodeCmd: (quotedPath: string, rawPath: string) => string
  /** Decode encoded file at `rawSrc` into destination `rawTmp`. No heredoc/PS2. */
  decodeFileCmd: (quotedSrc: string, quotedTmp: string, rawSrc: string, rawTmp: string) => string
  encodeLocal: (buf: Buffer) => string
  decodeLocal: (text: string) => Buffer
}

const CODECS: CodecSpec[] = [
  {
    name: 'base64',
    encodeCmd: (p) => `base64 < ${p}`,
    decodeFileCmd: (src, tmp) => `base64 -d < ${src} > ${tmp}`,
    encodeLocal: (buf) => buf.toString('base64'),
    decodeLocal: (text) => Buffer.from(text.replace(/\s+/g, ''), 'base64'),
  },
  {
    name: 'openssl',
    encodeCmd: (p) => `openssl base64 -A -in ${p}`,
    decodeFileCmd: (src, tmp) => `openssl base64 -d -A -in ${src} -out ${tmp}`,
    encodeLocal: (buf) => buf.toString('base64'),
    decodeLocal: (text) => Buffer.from(text.replace(/\s+/g, ''), 'base64'),
  },
  {
    name: 'python3',
    encodeCmd: (_q, raw) =>
      `python3 -c ${shellQuote(`import sys,base64; sys.stdout.buffer.write(base64.standard_b64encode(open(${JSON.stringify(raw)},"rb").read()))`)}`,
    decodeFileCmd: (_qs, _qt, rawSrc, rawTmp) =>
      `python3 -c ${shellQuote(`import base64; open(${JSON.stringify(rawTmp)},"wb").write(base64.standard_b64decode(open(${JSON.stringify(rawSrc)},"rb").read()))`)}`,
    encodeLocal: (buf) => buf.toString('base64'),
    decodeLocal: (text) => Buffer.from(text.replace(/\s+/g, ''), 'base64'),
  },
  {
    name: 'xxd',
    encodeCmd: (p) => `xxd -p ${p}`,
    decodeFileCmd: (src, tmp) => `xxd -r -p < ${src} > ${tmp}`,
    encodeLocal: (buf) => buf.toString('hex'),
    decodeLocal: (text) => Buffer.from(text.replace(/\s+/g, ''), 'hex'),
  },
]

/** shell 单引号包裹，内部 ' 写成 '\'' */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True only if `marker` appears on its own output line. A plain `text.includes(marker)`
 * false-positives on the PTY's echo of the `echo <marker>` command itself (the source
 * line contains the marker as a literal substring before the shell even runs it),
 * which made upload/edit sync points resolve prematurely and race the real transfer.
 */
export function hasMarkerLine(text: string, marker: string): boolean {
  return new RegExp(`(?:^|\\r?\\n)${escapeRegExp(marker)}(?:\\r?\\n|$)`).test(text)
}

/**
 * Build a `printf` command whose typed/echoed source text never literally contains the
 * marker string, and whose output always starts on its own fresh line. Two independent
 * hazards motivate this:
 *  - Bash concatenates adjacent quoted args with no separator, so `printf '%s%s' 'AB' 'CD'`
 *    prints `ABCD` while the typed source line itself reads `'AB' 'CD'` — immune to PTY
 *    local echo regardless of `stty -echo`.
 *  - With local echo *off*, the shell's `$ ` prompt has no trailing newline (that used to
 *    come from the terminal echoing the Enter keystroke), so back-to-back prompts for
 *    commands with no stdout output concatenate on one line (e.g. `$ $ $ $ SP_SZ:123`).
 *    A marker that does not print its own leading `\n` can land glued to that prompt text,
 *    which silently fails the line-anchored `hasMarkerLine`/`lastLineMarker` match and was
 *    observed in real-machine testing to make every sync wait time out.
 */
export function echoProofEcho(marker: string): string {
  const mid = Math.max(1, Math.floor(marker.length / 2))
  return `printf '\\n%s%s\\n' '${marker.slice(0, mid)}' '${marker.slice(mid)}'`
}

/**
 * A BSD/macOS tty input queue holds TTYHOG (1024) bytes; Linux ptys are comparable.
 * Every staging line must fit inside it together with its acknowledgement marker and
 * the surrounding `printf ... >> <path>` scaffolding (~80 bytes), or the kernel drops
 * the overflow while the shell is still reading the earlier bytes.
 */
const STAGING_CHUNK_BYTES = 768

export function validateRemotePath(remotePath: string): string {
  const p = remotePath.trim()
  if (!p) throw new TransferError('path must not be empty', 400)
  if (p.includes('\0')) throw new TransferError('path contains an invalid character', 400)
  if (p.length > 4096) throw new TransferError('path is too long', 400)
  return p
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 从 exec 输出截取标记之间的 payload。
 * 要求 begin/end 各自独占一行；取最后一帧完整标记，避免假帧/重试污染。
 */
export function extractMarkedPayload(output: string, begin: string, end: string): string {
  const beginLine = `${begin}\n`
  const endLine = `\n${end}`
  let lastPayload: string | null = null
  let from = 0
  while (from < output.length) {
    // 行首 begin：字符串开头或前一字符为换行
    let beginAt = output.indexOf(beginLine, from)
    while (beginAt >= 0) {
      if (beginAt === 0 || output[beginAt - 1] === '\n' || output[beginAt - 1] === '\r') break
      beginAt = output.indexOf(beginLine, beginAt + 1)
    }
    if (beginAt < 0) break
    const contentStart = beginAt + beginLine.length
    const endAt = output.indexOf(endLine, contentStart)
    if (endAt < 0) break
    // end 后须为行尾或 EOF
    const afterEnd = endAt + endLine.length
    const okEnd =
      afterEnd >= output.length ||
      output[afterEnd] === '\n' ||
      output[afterEnd] === '\r'
    if (!okEnd) {
      from = contentStart
      continue
    }
    lastPayload = output.slice(contentStart, endAt)
    from = afterEnd
  }
  if (lastPayload === null) {
    throw new TransferError('Transfer marker frame was not found (the remote command may have failed or output was truncated)', 502)
  }
  return lastPayload
}

/**
 * 取输出中「独占一行」的最后一个标记匹配。
 * PTY 会回显命令本身，命令行里常含 `echo SP_STAT:unreadable` 等字面量；
 * 若用普通 String.match，会先命中回显导致误判（文件明明可读却报不可读）。
 */
export function lastLineMarker(
  output: string,
  pattern: RegExp,
): RegExpMatchArray | null {
  const re = new RegExp(`(?:^|\\r?\\n)(?:${pattern.source})`, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  let last: RegExpMatchArray | null = null
  for (const m of output.matchAll(re)) {
    // matchAll 时整段含前导换行；把捕获组对齐到原 pattern
    last = m
  }
  if (!last) return null
  // 去掉前导换行后的分组：last[1] 起对应 pattern 的捕获组
  return last
}

export class FileTransfer {
  private codecCache = new Map<string, CodecSpec>()

  constructor(
    private readonly historySource: TransferHistorySource,
    private readonly opLock: SessionOpLock,
  ) {}

  private assertReady(session: BaseSession): void {
    if (session.mode === 'MANUAL') {
      throw new TransferError('Session is in MANUAL mode; file transfer was rejected', 409)
    }
    if (session.state !== 'WAITING_INPUT') {
      throw new TransferError(
        `Session state is ${session.state}; files can be transferred only while WAITING_INPUT`,
        409,
      )
    }
  }

  /** Widen local + remote PTY so long printf lines are not wrap-corrupted (spaces inserted). */
  private async widenPty(session: BaseSession, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    try {
      session.resize(10_000, 50)
    } catch {
      // ignore
    }
    await this.execCapture(
      session,
      'stty cols 10000 rows 50 2>/dev/null || stty cols 2000 rows 50 2>/dev/null || true',
      Math.min(timeoutMs, 10_000),
      signal,
    ).catch(() => {})
  }

  private async execCapture(
    session: BaseSession,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ output: string; timedOut: boolean; state: string }> {
    const startSeq = session.lastSeq
    session.write(command.endsWith('\n') || command.endsWith('\r') ? command : command + '\n')
    const { state, timedOut } = await session.waitForStable(timeoutMs, { signal })
    const { text } = this.historySource.history(session.id, startSeq, 50_000)
    return { output: text, timedOut, state }
  }

  /**
   * Wait until `history(since=startSeq)` contains `marker` on its own line. Unlike
   * waitForStable, this ignores intermediate WAITING_INPUT from a printf storm (or `>>`
   * echo matching the prompt regex), and unlike a plain substring search it cannot be
   * satisfied early by the PTY's echo of the `echo <marker>` source line.
   */
  private async waitForOutputMarker(
    session: BaseSession,
    startSeq: number,
    marker: string | RegExp,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ text: string; timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs
    const startedAt = Date.now()
    for (;;) {
      const { text } = this.historySource.history(session.id, startSeq, 50_000)
      const found = typeof marker === 'string' ? hasMarkerLine(text, marker) : !!lastLineMarker(text, marker)
      if (found) return { text, timedOut: false }
      if (signal?.aborted || Date.now() >= deadline || session.state === 'DISCONNECTED') {
        return { text, timedOut: true }
      }
      // Staging acknowledges every chunk, so a local session pays this latency
      // hundreds of times: poll tightly at first, then back off for slow links.
      await sleep(Date.now() - startedAt < 300 ? 4 : 40)
    }
  }

  /** Poll until WAITING_INPUT so the next op does not hit a transient 409. */
  private async settleWaitingInput(session: BaseSession, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted) return
      const state = session.state
      if (state === 'WAITING_INPUT' || state === 'DISCONNECTED') return
      await sleep(40)
    }
  }

  /**
   * Leave the internal-transfer region and restore a visible prompt.
   * Must endInternal before the final stty/prompt so observers (Web/history)
   * are not left glued to the pre-transfer prompt line.
   */
  private async finishInternalTransfer(
    session: BaseSession,
    opts: { restoreEcho?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    session.endInternal()
    if (opts.restoreEcho) {
      // Only needed after stty -echo uploads: drop OSC color replies etc. that
      // landed in the readline buffer, then restore echo so its prompt is public.
      session.discardPendingLine()
      await this.execCapture(session, 'stty echo 2>/dev/null || true', 10_000, opts.signal).catch(() => {})
      await this.settleWaitingInput(session, 5_000, opts.signal)
    } else {
      // Download path has no stty -echo; inject a display-only break so the
      // next public prompt/command is not glued to the hidden region.
      session.emitDisplayOutput('\r\n')
    }
  }

  /**
   * Send Ctrl+C and give the shell a moment to settle, then best-effort restore local
   * echo and remove staging files. Must run before every upload error is thrown:
   * a bash PS2 continuation (`>`) still satisfies the default prompt regex, so without
   * this the session is silently left unusable and even the cleanup commands below
   * would just become more PS2 continuation lines.
   */
  private async recoverPrompt(session: BaseSession, opts: { tempPaths?: string[] } = {}): Promise<void> {
    if (session.isClosed() || session.state === 'DISCONNECTED') return
    try {
      session.write('\u0003')
      await session.waitForStable(3_000)
    } catch {
      // best-effort
    }
    if (session.isClosed()) return
    const cleanupCmds = [
      'stty echo 2>/dev/null || true',
      ...(opts.tempPaths ?? []).map((p) => `rm -f ${p} 2>/dev/null || true`),
    ].join('; ')
    await this.execCapture(session, cleanupCmds, 5_000).catch(() => {})
  }

  /** Read back the staged base64 file's byte count via an echo-proof marker. */
  private async verifyStagedSize(
    session: BaseSession,
    quotedB64: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<number | null> {
    // Leading \n guards against landing glued to a prompt with no trailing
    // newline while local echo is off; see echoProofEcho for why.
    const check = await this.execCapture(
      session,
      `printf '\\nSP_SZ:%s\\n' "$(wc -c < ${quotedB64} 2>/dev/null | tr -d ' ')"`,
      Math.min(timeoutMs, 10_000),
      signal,
    )
    const m = lastLineMarker(check.output, /SP_SZ:(\d+)/)
    return m ? Number(m[1]) : null
  }

  /**
   * Stream `encoded` to the remote temp file `quotedB64`, one printf line at a time,
   * with the line's own acknowledgement marker appended to it so a single round trip
   * both stages a chunk and confirms the shell consumed it.
   *
   * Strict one-line-in-flight pacing is what makes this safe. A BSD/macOS tty input
   * queue holds only TTYHOG (1024) bytes, and an interactive shell reading through
   * readline drains it slowly; anything written past that while the reader is behind
   * is silently discarded by the kernel. Real-machine testing showed batching four
   * 512-byte chunks into one ~2190-byte write reliably lost bytes mid-line, leaving an
   * unbalanced quote that dropped bash into a PS2 continuation it never left. Keeping
   * every write (chunk + ack, see MAX_PTY_LINE_BYTES) under that queue size, and never
   * sending the next line until the previous one is acknowledged, removes the overflow
   * window entirely.
   */
  private async burstWrite(
    session: BaseSession,
    quotedB64: string,
    encoded: string,
    token: string,
    chunkSize: number,
    timeoutMs: number,
    startAt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    session.write(`: > ${quotedB64}\n`)
    await session.drain()
    let offset = 0
    let seq = 0
    while (offset < encoded.length) {
      const chunk = encoded.slice(offset, offset + chunkSize)
      offset += chunkSize
      seq += 1

      const ack = `SP_S_${token}_${seq}`
      const ackSeq = session.lastSeq
      session.write(`printf '%s' '${chunk}' >> ${quotedB64}; ${echoProofEcho(ack)}\n`)
      await session.drain()
      const ackTimeout = Math.max(timeoutMs - (Date.now() - startAt), 10_000)
      const acked = await this.waitForOutputMarker(session, ackSeq, ack, ackTimeout, signal)
      if (acked.timedOut) {
        throw new TransferError(signal?.aborted ? 'Upload canceled' : 'Upload decoding timed out', signal?.aborted ? 499 : 504)
      }
    }
  }

  /**
   * Stage the encoded payload and verify its byte count matches before decoding.
   * A mismatch means bytes were dropped in transit (the PS2-hang failure mode); retry
   * once with a smaller chunk size before giving up with a clear error instead of
   * silently decoding a corrupted file.
   */
  private async stageEncodedPayload(
    session: BaseSession,
    quotedB64: string,
    encoded: string,
    token: string,
    timeoutMs: number,
    startAt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const attempts = [{ chunkSize: STAGING_CHUNK_BYTES }, { chunkSize: 256 }]
    let lastError: TransferError | null = null
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      const { chunkSize } = attempts[attempt]!
      try {
        await this.burstWrite(session, quotedB64, encoded, token, chunkSize, timeoutMs, startAt, signal)
        const size = await this.verifyStagedSize(session, quotedB64, timeoutMs, signal)
        if (size === encoded.length) return
        lastError = new TransferError(
          `Upload staging is corrupted (expected ${encoded.length} encoded bytes, got ${size ?? 'unknown'}); the PTY link may be unstable`,
          502,
        )
      } catch (err) {
        lastError = err instanceof TransferError ? err : new TransferError(String(err), 502)
      }
      // Restaging from scratch costs at least as long as the attempt that just
      // failed, so only retry while the caller's budget can still absorb one.
      if (signal?.aborted || Date.now() - startAt >= timeoutMs) break
    }
    throw lastError ?? new TransferError('Upload staging failed', 502)
  }

  private async probeCodec(session: BaseSession, timeoutMs: number, signal?: AbortSignal): Promise<CodecSpec> {
    const cached = this.codecCache.get(session.id)
    if (cached) return cached

    const probe = await this.execCapture(
      session,
      [
        'if command -v base64 >/dev/null 2>&1; then',
        '  echo SP_CODEC:base64',
        'elif command -v openssl >/dev/null 2>&1; then',
        '  echo SP_CODEC:openssl',
        'elif command -v python3 >/dev/null 2>&1; then',
        '  echo SP_CODEC:python3',
        'elif command -v xxd >/dev/null 2>&1; then',
        '  echo SP_CODEC:xxd',
        'else',
        '  echo SP_CODEC:none',
        'fi',
      ].join('\n'),
      Math.min(timeoutMs, 30_000),
      signal,
    )
    if (probe.timedOut) {
      throw new TransferError('Timed out probing remote encoders', 504)
    }
    const m = lastLineMarker(probe.output, /SP_CODEC:(base64|openssl|python3|xxd|none)/)
    const name = m?.[1]
    if (!name || name === 'none') {
      throw new TransferError(
        'No remote encoder is available (requires base64, openssl, python3, or xxd)',
        502,
      )
    }
    const spec = CODECS.find((c) => c.name === name)!
    this.codecCache.set(session.id, spec)
    return spec
  }

  async download(
    session: BaseSession,
    remotePath: string,
    timeoutMs = config.transferTimeoutMs,
    signal?: AbortSignal,
  ): Promise<DownloadResult> {
    const pathClean = validateRemotePath(remotePath)
    this.assertReady(session)

    return this.opLock.withLock(session.id, async () => {
      session.beginInternal()
      try {
        const startAt = Date.now()
        const codec = await this.probeCodec(session, timeoutMs, signal)
        this.assertReady(session)

        const token = crypto.randomUUID().replace(/-/g, '')
        const begin = `SPB_${token}`
        const end = `SPE_${token}`
        const quoted = shellQuote(pathClean)

        const stat = await this.execCapture(
          session,
          `if [ ! -f ${quoted} ]; then echo SP_STAT:missing; elif [ ! -r ${quoted} ]; then echo SP_STAT:unreadable; else echo SP_STAT:ok:$(wc -c < ${quoted} | tr -d ' '); fi`,
          Math.min(timeoutMs, 30_000),
          signal,
        )
        if (stat.timedOut) throw new TransferError(signal?.aborted ? 'Download canceled' : 'Timed out checking the remote file', signal?.aborted ? 499 : 504)
        // 必须行首匹配并取最后一次：命令回显里含 echo SP_STAT:unreadable 字面量
        const sm = lastLineMarker(stat.output, /SP_STAT:(missing|unreadable|ok:(\d+))/)
        if (!sm) throw new TransferError('Unable to read the remote file status', 502)
        if (sm[1] === 'missing') throw new TransferError('Remote file not found', 404)
        if (sm[1] === 'unreadable') throw new TransferError('Remote file is unreadable', 502)
        const remoteSize = Number(sm[2])
        if (!Number.isFinite(remoteSize) || remoteSize < 0) {
          throw new TransferError('Unable to parse the remote file size', 502)
        }
        if (remoteSize > config.transferMaxBytes) {
          throw new TransferError(
            `File is too large (${remoteSize} bytes); limit is ${config.transferMaxBytes} bytes`,
            413,
          )
        }

        this.assertReady(session)
        const remaining = Math.max(timeoutMs - (Date.now() - startAt), 5_000)
        const enc = await this.execCapture(
          session,
          `printf '%s\\n' '${begin}'; ${codec.encodeCmd(quoted, pathClean)}; printf '\\n%s\\n' '${end}'`,
          remaining,
          signal,
        )
        if (enc.timedOut) throw new TransferError(signal?.aborted ? 'Download canceled' : 'Download encoding timed out', signal?.aborted ? 499 : 504)

        const payload = extractMarkedPayload(enc.output, begin, end)
        let data: Buffer
        try {
          data = codec.decodeLocal(payload)
        } catch {
          throw new TransferError('Unable to decode remote data', 502)
        }
        if (data.length !== remoteSize) {
          throw new TransferError(
            `Downloaded size mismatch: expected ${remoteSize}, got ${data.length}`,
            502,
          )
        }
        if (data.length > config.transferMaxBytes) {
          throw new TransferError(`File is too large; limit is ${config.transferMaxBytes} bytes`, 413)
        }

        return {
          remotePath: pathClean,
          data,
          size: data.length,
          sha256: sha256Hex(data),
          codec: codec.name,
          durationMs: Date.now() - startAt,
        }
      } finally {
        await this.finishInternalTransfer(session, { signal }).catch(() => {})
      }
    })
  }

  async upload(
    session: BaseSession,
    remotePath: string,
    data: Buffer,
    opts: { timeoutMs?: number; expectedSha256?: string; signal?: AbortSignal } = {},
  ): Promise<TransferMeta> {
    const pathClean = validateRemotePath(remotePath)
    const timeoutMs = opts.timeoutMs ?? config.transferTimeoutMs
    const signal = opts.signal
    this.assertReady(session)

    if (data.length > config.transferMaxBytes) {
      throw new TransferError(
        `File is too large (${data.length} bytes); limit is ${config.transferMaxBytes} bytes`,
        413,
      )
    }
    const digest = sha256Hex(data)
    if (opts.expectedSha256 && opts.expectedSha256.toLowerCase() !== digest) {
      throw new TransferError('Upload content does not match the sha256 parameter', 400)
    }

    return this.opLock.withLock(session.id, async () => {
      session.beginInternal()
      try {
        const startAt = Date.now()
        // Widen before any long probe/transfer command — Bun LocalPty cannot ioctl-resize,
        // and jump-host shells often stay at 80 columns.
        await this.widenPty(session, timeoutMs, signal)
        this.assertReady(session)

        const codec = await this.probeCodec(session, timeoutMs, signal)
        this.assertReady(session)

        const token = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
        const quotedDest = shellQuote(pathClean)
        const tmpName = `/tmp/x${token}`
        const quotedTmp = shellQuote(tmpName)
        const b64Name = `/tmp/b${token}`
        const quotedB64 = shellQuote(b64Name)
        const encoded = codec.encodeLocal(data)

        // Local echo doubles round-trip volume and lets the PTY's echo of `echo <marker>`
        // race the real marker output; turning it off is best-effort (some shells lack a
        // real tty) and echo-proof markers below remain correct either way.
        await this.execCapture(session, 'stty -echo 2>/dev/null || true', Math.min(timeoutMs, 10_000), signal).catch(() => {})

        try {
          // Stage the base64 payload and verify its staged size before decoding, retrying
          // once with a smaller chunk on corruption instead of silently decoding garbage.
          await this.stageEncodedPayload(session, quotedB64, encoded, token, timeoutMs, startAt, signal)

          // Drain the printf queue before finalize. waitForStable would resolve on
          // intermediate prompts between printfs while finalize is still buffered.
          const drain = `SP_DRAIN_${token}`
          let startSeq = session.lastSeq
          session.write(`${echoProofEcho(drain)}\n`)
          const remaining = Math.max(timeoutMs - (Date.now() - startAt), 10_000)
          const drainWait = await this.waitForOutputMarker(session, startSeq, drain, remaining, signal)
          if (drainWait.timedOut) {
            throw new TransferError(signal?.aborted ? 'Upload canceled' : 'Upload decoding timed out', signal?.aborted ? 499 : 504)
          }

          const decode = codec.decodeFileCmd(quotedB64, quotedTmp, b64Name, tmpName)
          const finalizeCmd = [
            `${decode}`,
            `rm -f ${quotedB64}`,
            `mv -f ${quotedTmp} ${quotedDest} 2>/dev/null || { cp ${quotedTmp} ${quotedDest} && rm -f ${quotedTmp}; }`,
            // Leading \n: local echo is still off here, so a bare `echo` can land
            // glued to a no-newline `$ ` prompt and silently fail the line-anchored match.
            `printf '\\nSP_UP:%s\\n' "$(wc -c < ${quotedDest} | tr -d ' ')"`,
          ].join('; ')
          startSeq = session.lastSeq
          session.write(`${finalizeCmd}\n`)
          const verifyTimeoutMs = Math.max(timeoutMs - (Date.now() - startAt), 10_000)
          const { text: verifyOutput, timedOut } = await this.waitForOutputMarker(
            session,
            startSeq,
            /SP_UP:\d+/,
            verifyTimeoutMs,
            signal,
          )
          if (timedOut) {
            throw new TransferError(signal?.aborted ? 'Upload canceled' : 'Upload decoding timed out', signal?.aborted ? 499 : 504)
          }

          // Marker can appear while still OUTPUTTING; wait for the prompt so the
          // next transfer/exec does not see a transient non-WAITING_INPUT 409.
          await this.settleWaitingInput(session, 5_000, signal)

          const vm = lastLineMarker(verifyOutput, /SP_UP:(\d+)/)
          if (!vm) throw new TransferError('Unable to verify the remote file size after upload', 502)
          const remoteSize = Number(vm[1])
          if (remoteSize !== data.length) {
            throw new TransferError(
              `Uploaded size mismatch: expected ${data.length}, remote size is ${remoteSize}`,
              502,
            )
          }

          return {
            remotePath: pathClean,
            size: data.length,
            sha256: digest,
            codec: codec.name,
            durationMs: Date.now() - startAt,
          }
        } catch (err) {
          await this.recoverPrompt(session, { tempPaths: [quotedB64, quotedTmp] })
          throw err
        }
      } finally {
        // Drop junk buffered while echo was off, then restore echo *outside*
        // the internal region so the resulting prompt is visible in Web/history.
        await this.finishInternalTransfer(session, { restoreEcho: true, signal }).catch(() => {})
      }
    })
  }

  clearSession(sessionId: string): void {
    this.codecCache.delete(sessionId)
  }

  basenameForDisposition(remotePath: string): string {
    const base = path.posix.basename(remotePath) || 'download'
    // Content-Disposition filename is Latin-1 only; strip quotes/CRLF and non-ASCII
    const cleaned = base.replace(/["\r\n]/g, '_').replace(/[^\x20-\x7E]/g, '_')
    return cleaned || 'download'
  }
}
