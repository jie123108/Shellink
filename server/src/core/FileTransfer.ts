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
  private async widenPty(session: BaseSession, timeoutMs: number): Promise<void> {
    try {
      session.resize(10_000, 50)
    } catch {
      // ignore
    }
    await this.execCapture(
      session,
      'stty cols 10000 rows 50 2>/dev/null || stty cols 2000 rows 50 2>/dev/null || true',
      Math.min(timeoutMs, 10_000),
    ).catch(() => {})
  }

  private async execCapture(
    session: BaseSession,
    command: string,
    timeoutMs: number,
  ): Promise<{ output: string; timedOut: boolean; state: string }> {
    const startSeq = session.lastSeq
    session.write(command.endsWith('\n') || command.endsWith('\r') ? command : command + '\n')
    const { state, timedOut } = await session.waitForStable(timeoutMs)
    const { text } = this.historySource.history(session.id, startSeq, 50_000)
    return { output: text, timedOut, state }
  }

  /**
   * Wait until `history(since=startSeq)` contains `marker`. Unlike waitForStable,
   * this ignores intermediate WAITING_INPUT from a printf storm (or `>>` echo
   * matching the prompt regex).
   */
  private async waitForOutputMarker(
    session: BaseSession,
    startSeq: number,
    marker: string | RegExp,
    timeoutMs: number,
  ): Promise<{ text: string; timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const { text } = this.historySource.history(session.id, startSeq, 50_000)
      const found = typeof marker === 'string' ? text.includes(marker) : marker.test(text)
      if (found) return { text, timedOut: false }
      if (Date.now() >= deadline || session.state === 'DISCONNECTED') {
        return { text, timedOut: true }
      }
      await sleep(40)
    }
  }

  /** Poll until WAITING_INPUT so the next op does not hit a transient 409. */
  private async settleWaitingInput(session: BaseSession, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = session.state
      if (state === 'WAITING_INPUT' || state === 'DISCONNECTED') return
      await sleep(40)
    }
  }

  private async probeCodec(session: BaseSession, timeoutMs: number): Promise<CodecSpec> {
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
  ): Promise<DownloadResult> {
    const pathClean = validateRemotePath(remotePath)
    this.assertReady(session)

    return this.opLock.withLock(session.id, async () => {
      const startAt = Date.now()
      const codec = await this.probeCodec(session, timeoutMs)
      this.assertReady(session)

      const token = crypto.randomUUID().replace(/-/g, '')
      const begin = `SPB_${token}`
      const end = `SPE_${token}`
      const quoted = shellQuote(pathClean)

      const stat = await this.execCapture(
        session,
        `if [ ! -f ${quoted} ]; then echo SP_STAT:missing; elif [ ! -r ${quoted} ]; then echo SP_STAT:unreadable; else echo SP_STAT:ok:$(wc -c < ${quoted} | tr -d ' '); fi`,
        Math.min(timeoutMs, 30_000),
      )
      if (stat.timedOut) throw new TransferError('Timed out checking the remote file', 504)
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
      )
      if (enc.timedOut) throw new TransferError('Download encoding timed out', 504)

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
    })
  }

  async upload(
    session: BaseSession,
    remotePath: string,
    data: Buffer,
    opts: { timeoutMs?: number; expectedSha256?: string } = {},
  ): Promise<TransferMeta> {
    const pathClean = validateRemotePath(remotePath)
    const timeoutMs = opts.timeoutMs ?? config.transferTimeoutMs
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
      const startAt = Date.now()
      // Widen before any long probe/transfer command — Bun LocalPty cannot ioctl-resize,
      // and jump-host shells often stay at 80 columns.
      await this.widenPty(session, timeoutMs)
      this.assertReady(session)

      const codec = await this.probeCodec(session, timeoutMs)
      this.assertReady(session)

      const token = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
      const quotedDest = shellQuote(pathClean)
      const tmpName = `/tmp/x${token}`
      const quotedTmp = shellQuote(tmpName)
      const b64Name = `/tmp/b${token}`
      const quotedB64 = shellQuote(b64Name)
      const encoded = codec.encodeLocal(data)

      // Stream base64 to a temp file via short printf lines. Each line is a
      // complete shell command. Keep the FULL line under 80 columns: Bun's
      // ExpectPty may stay at 80 cols even after remote `stty` widen (local
      // wrap inserts a real newline mid-quote → bash PS2, silent failure).
      // overhead ≈ printf '%s' '…' >> '/tmp/bXXXXXXXX' → ~34 chars → chunk ≤ 40.
      // Sync every N chunks so the local PTY/SSH window cannot overflow and
      // silently drop later printf lines (~32KB loss without pacing).
      const chunkSize = 32
      const syncEvery = 64
      session.write(`: > ${quotedB64}\n`)
      let chunksSinceSync = 0
      for (let i = 0; i < encoded.length; i += chunkSize) {
        const chunk = encoded.slice(i, i + chunkSize)
        session.write(`printf '%s' '${chunk}' >> ${quotedB64}\n`)
        chunksSinceSync += 1
        const isLast = i + chunkSize >= encoded.length
        if (!isLast && chunksSinceSync >= syncEvery) {
          const sync = `SP_S_${token}_${i}`
          const syncSeq = session.lastSeq
          session.write(`echo ${sync}\n`)
          const syncTimeout = Math.max(timeoutMs - (Date.now() - startAt), 10_000)
          const synced = await this.waitForOutputMarker(session, syncSeq, sync, syncTimeout)
          if (synced.timedOut) {
            await this.execCapture(
              session,
              `rm -f ${quotedB64} 2>/dev/null || true`,
              10_000,
            ).catch(() => {})
            throw new TransferError('Upload decoding timed out', 504)
          }
          chunksSinceSync = 0
        } else if (!isLast) {
          await sleep(1)
        }
      }

      const remaining = Math.max(timeoutMs - (Date.now() - startAt), 10_000)
      // Drain the printf queue before finalize. waitForStable would resolve on
      // intermediate prompts between printfs while finalize is still buffered.
      const drain = `SP_DRAIN_${token}`
      let startSeq = session.lastSeq
      session.write(`echo ${drain}\n`)
      {
        const drainWait = await this.waitForOutputMarker(session, startSeq, drain, remaining)
        if (drainWait.timedOut) {
          await this.execCapture(
            session,
            `rm -f ${quotedB64} 2>/dev/null || true`,
            10_000,
          ).catch(() => {})
          throw new TransferError('Upload decoding timed out', 504)
        }
      }

      const decode = codec.decodeFileCmd(quotedB64, quotedTmp, b64Name, tmpName)
      const finalizeCmd = [
        `${decode}`,
        `rm -f ${quotedB64}`,
        `mv -f ${quotedTmp} ${quotedDest} 2>/dev/null || { cp ${quotedTmp} ${quotedDest} && rm -f ${quotedTmp}; }`,
        `echo SP_UP:$(wc -c < ${quotedDest} | tr -d ' ')`,
      ].join('; ')
      startSeq = session.lastSeq
      session.write(`${finalizeCmd}\n`)
      const verifyTimeoutMs = Math.max(timeoutMs - (Date.now() - startAt), 10_000)
      const { text: verifyOutput, timedOut } = await this.waitForOutputMarker(
        session,
        startSeq,
        /SP_UP:\d+/,
        verifyTimeoutMs,
      )
      if (timedOut) {
        await this.execCapture(
          session,
          `rm -f ${quotedB64} ${quotedTmp} 2>/dev/null || true`,
          10_000,
        ).catch(() => {})
        throw new TransferError('Upload decoding timed out', 504)
      }

      // Marker can appear while still OUTPUTTING; wait for the prompt so the
      // next transfer/exec does not see a transient non-WAITING_INPUT 409.
      await this.settleWaitingInput(session, 5_000)

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
