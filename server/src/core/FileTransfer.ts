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
  decodeCmd: (quotedTmp: string, rawTmp: string, eofMarker: string) => string
  encodeLocal: (buf: Buffer) => string
  decodeLocal: (text: string) => Buffer
}

const CODECS: CodecSpec[] = [
  {
    name: 'base64',
    encodeCmd: (p) => `base64 < ${p}`,
    decodeCmd: (tmp, _raw, eof) => `base64 -d > ${tmp} <<'${eof}'`,
    encodeLocal: (buf) => buf.toString('base64'),
    decodeLocal: (text) => Buffer.from(text.replace(/\s+/g, ''), 'base64'),
  },
  {
    name: 'openssl',
    encodeCmd: (p) => `openssl base64 -A -in ${p}`,
    decodeCmd: (tmp, _raw, eof) => `openssl base64 -d -A -out ${tmp} <<'${eof}'`,
    encodeLocal: (buf) => buf.toString('base64'),
    decodeLocal: (text) => Buffer.from(text.replace(/\s+/g, ''), 'base64'),
  },
  {
    name: 'python3',
    encodeCmd: (_q, raw) =>
      `python3 -c ${shellQuote(`import sys,base64; sys.stdout.buffer.write(base64.standard_b64encode(open(${JSON.stringify(raw)},"rb").read()))`)}`,
    decodeCmd: (_q, rawTmp, eof) =>
      `python3 -c ${shellQuote(`import sys,base64; open(${JSON.stringify(rawTmp)},"wb").write(base64.standard_b64decode(sys.stdin.buffer.read()))`)} <<'${eof}'`,
    encodeLocal: (buf) => buf.toString('base64'),
    decodeLocal: (text) => Buffer.from(text.replace(/\s+/g, ''), 'base64'),
  },
  {
    name: 'xxd',
    encodeCmd: (p) => `xxd -p ${p}`,
    decodeCmd: (tmp, _raw, eof) => `xxd -r -p > ${tmp} <<'${eof}'`,
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

  private async probeCodec(session: BaseSession, timeoutMs: number): Promise<CodecSpec> {
    const cached = this.codecCache.get(session.id)
    if (cached) return cached

    const probe = await this.execCapture(
      session,
      [
        'if command -v base64 >/dev/null 2>&1; then echo SP_CODEC:base64',
        'elif command -v openssl >/dev/null 2>&1; then echo SP_CODEC:openssl',
        'elif command -v python3 >/dev/null 2>&1; then echo SP_CODEC:python3',
        'elif command -v xxd >/dev/null 2>&1; then echo SP_CODEC:xxd',
        'else echo SP_CODEC:none; fi',
      ].join('; '),
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
      const codec = await this.probeCodec(session, timeoutMs)
      this.assertReady(session)

      const token = crypto.randomUUID().replace(/-/g, '')
      const eof = `SPEOF_${token}`
      const quotedDest = shellQuote(pathClean)
      const tmpName = `/tmp/.shellink-xfer-${token}`
      const quotedTmp = shellQuote(tmpName)
      const encoded = codec.encodeLocal(data)

      await this.execCapture(session, 'stty -echo 2>/dev/null || true', 10_000)
      this.assertReady(session)

      const remaining = Math.max(timeoutMs - (Date.now() - startAt), 10_000)
      const startSeq = session.lastSeq

      session.write(`${codec.decodeCmd(quotedTmp, tmpName, eof)}\n`)

      const chunkSize = 12 * 1024
      for (let i = 0; i < encoded.length; i += chunkSize) {
        session.write(encoded.slice(i, i + chunkSize))
        if (i + chunkSize < encoded.length) await sleep(5)
      }
      session.write(`\n${eof}\n`)

      // Heredoc decode is silent until the prompt returns; do not treat IDLE as done
      // or a slow link will "finish" while bytes are still in flight.
      const { timedOut } = await session.waitForStable(remaining, { acceptIdle: false })
      void this.historySource.history(session.id, startSeq, 50_000)
      if (timedOut) {
        await this.execCapture(
          session,
          `rm -f ${quotedTmp} 2>/dev/null; stty echo 2>/dev/null || true`,
          10_000,
        ).catch(() => {})
        throw new TransferError('Upload decoding timed out', 504)
      }

      const verifyTimeoutMs = Math.max(timeoutMs - (Date.now() - startAt), 10_000)
      const verify = await this.execCapture(
        session,
        [
          `mv -f ${quotedTmp} ${quotedDest} 2>/dev/null || { cp ${quotedTmp} ${quotedDest} && rm -f ${quotedTmp}; }`,
          `echo SP_UP:$(wc -c < ${quotedDest} | tr -d ' ')`,
          'stty echo 2>/dev/null || true',
        ].join('; '),
        verifyTimeoutMs,
      )
      if (verify.timedOut) throw new TransferError('Upload verification timed out', 504)
      const vm = lastLineMarker(verify.output, /SP_UP:(\d+)/)
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
