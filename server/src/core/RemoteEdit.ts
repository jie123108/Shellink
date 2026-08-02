import crypto from 'node:crypto'
import { config } from '../config.js'
import type { BaseSession } from './BaseSession.js'
import {
  echoProofEcho,
  hasMarkerLine,
  shellQuote,
  type TransferHistorySource,
  validateRemotePath,
} from './FileTransfer.js'
import { TransferError } from './TransferError.js'
import type { SessionOpLock } from './SessionOpLock.js'

export type EditEngine = 'python3' | 'python' | 'sed'

export interface TextEdit {
  oldText: string
  newText: string
}

export interface RemoteEditResult {
  ok: true
  path: string
  engine: EditEngine
  replaced: number
  durationMs: number
}

/**
 * 远端精确字符串替换脚本（Python 3）。
 * stdin: JSON { "path": "...", "edits": [{ "oldText", "newText" }] }
 * stdout: SP_EDIT:ok:<n> 或 SP_EDIT:err:<code>:<message>
 */
const PYTHON_EDIT_SCRIPT = `
import sys, json, os, tempfile

def fail(code, msg):
    msg = str(msg).replace("\\n", " ").replace("\\r", " ")
    # Leading \\n: local echo is off by the time this runs, so a bare marker can land
    # glued to a no-newline shell prompt and silently fail the line-anchored match.
    sys.stdout.write("\\nSP_EDIT:err:%s:%s\\n" % (code, msg))
    sys.exit(0)

try:
    payload = json.loads(sys.stdin.read())
except Exception as e:
    fail("bad_payload", e)

path = payload.get("path")
edits = payload.get("edits")
if not isinstance(path, str) or not path:
    fail("bad_path", "path required")
if not isinstance(edits, list) or len(edits) == 0:
    fail("bad_edits", "edits must be a non-empty array")

norm_edits = []
for i, e in enumerate(edits):
    if not isinstance(e, dict):
        fail("bad_edits", "edits[%d] must be object" % i)
    old = e.get("oldText")
    new = e.get("newText")
    if not isinstance(old, str) or not isinstance(new, str):
        fail("bad_edits", "edits[%d] oldText/newText must be strings" % i)
    if len(old) == 0:
        fail("empty_old", "edits[%d].oldText must not be empty" % i)
    # normalize CRLF in patterns to LF for matching against LF-normalized content
    old_n = old.replace("\\r\\n", "\\n").replace("\\r", "\\n")
    new_n = new.replace("\\r\\n", "\\n").replace("\\r", "\\n")
    norm_edits.append((i, old_n, new_n))

try:
    with open(path, "rb") as f:
        data = f.read()
except FileNotFoundError:
    fail("missing", "file not found")
except OSError as e:
    fail("io", e)

bom = b""
if data.startswith(b"\\xef\\xbb\\xbf"):
    bom = b"\\xef\\xbb\\xbf"
    data = data[3:]

try:
    text = data.decode("utf-8")
except UnicodeDecodeError as e:
    fail("encoding", "file is not valid utf-8: %s" % e)

ending = "\\n"
if "\\r\\n" in text:
    ending = "\\r\\n"
elif "\\r" in text and "\\n" not in text:
    ending = "\\r"

content = text.replace("\\r\\n", "\\n").replace("\\r", "\\n")

matches = []
for i, old_n, new_n in norm_edits:
    count = content.count(old_n)
    if count == 0:
        if len(norm_edits) == 1:
            fail("not_found", "Could not find the exact text. oldText must match exactly including whitespace.")
        fail("not_found", "Could not find edits[%d]. oldText must match exactly including whitespace." % i)
    if count > 1:
        if len(norm_edits) == 1:
            fail("duplicate", "Found %d occurrences; oldText must be unique. Provide more context." % count)
        fail("duplicate", "Found %d occurrences of edits[%d]; each oldText must be unique." % (count, i))
    idx = content.find(old_n)
    matches.append((i, idx, len(old_n), new_n))

matches.sort(key=lambda m: m[1])
for j in range(1, len(matches)):
    prev = matches[j - 1]
    cur = matches[j]
    if prev[1] + prev[2] > cur[1]:
        fail("overlap", "edits[%d] and edits[%d] overlap. Merge them or target disjoint regions." % (prev[0], cur[0]))

new_content = content
for i, idx, length, new_n in reversed(matches):
    new_content = new_content[:idx] + new_n + new_content[idx + length:]

if new_content == content:
    fail("no_change", "No changes made; replacement produced identical content.")

if ending == "\\r\\n":
    out_text = new_content.replace("\\n", "\\r\\n")
elif ending == "\\r":
    out_text = new_content.replace("\\n", "\\r")
else:
    out_text = new_content

out_bytes = bom + out_text.encode("utf-8")
dir_name = os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(prefix=".shellink-edit-", dir=dir_name)
try:
    with os.fdopen(fd, "wb") as f:
        f.write(out_bytes)
    os.chmod(tmp, os.stat(path).st_mode & 0o7777)
    os.replace(tmp, path)
except Exception as e:
    try:
        os.unlink(tmp)
    except Exception:
        pass
    fail("write", e)

sys.stdout.write("\\nSP_EDIT:ok:%d\\n" % len(matches))
`.trim()

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function escapeSedReplacement(s: string): string {
  // Use | as delimiter; escape \, |, & and newlines (newlines rejected earlier)
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/&/g, '\\&')
}

export function parseEditResult(output: string): { ok: true; replaced: number } | { ok: false; code: string; message: string } {
  // 只认行首标记，并取最后一次，避免命中命令回显
  const re = /(?:^|\r?\n)SP_EDIT:(ok|err):([^\r\n]*)/g
  let m: RegExpExecArray | null = null
  let last: RegExpExecArray | null = null
  while ((m = re.exec(output)) !== null) last = m
  if (!last) {
    throw new TransferError('Edit result marker was not found (the remote command may have failed or output was truncated)', 502)
  }
  if (last[1] === 'ok') {
    const replaced = Number(last[2])
    if (!Number.isFinite(replaced) || replaced < 1) {
      throw new TransferError('Unable to parse the edit result', 502)
    }
    return { ok: true, replaced }
  }
  const rest = last[2] ?? ''
  const colon = rest.indexOf(':')
  const code = colon >= 0 ? rest.slice(0, colon) : rest
  const message = colon >= 0 ? rest.slice(colon + 1) : rest
  return { ok: false, code: code || 'error', message: message || 'edit failed' }
}

export function mapEditError(code: string, message: string): TransferError {
  const status =
    code === 'missing'
      ? 404
      : code === 'bad_payload' ||
          code === 'bad_path' ||
          code === 'bad_edits' ||
          code === 'empty_old' ||
          code === 'not_found' ||
          code === 'duplicate' ||
          code === 'overlap' ||
          code === 'no_change' ||
          code === 'sed_unsupported'
        ? 400
        : 502
  return new TransferError(message || code, status)
}

export class RemoteEdit {
  private engineCache = new Map<string, EditEngine>()

  constructor(
    private readonly historySource: TransferHistorySource,
    private readonly opLock: SessionOpLock,
  ) {}

  private decodeCache = new Map<string, 'openssl' | 'base64'>()

  clearSession(sessionId: string): void {
    this.engineCache.delete(sessionId)
    this.decodeCache.delete(sessionId)
  }

  private assertReady(session: BaseSession): void {
    if (session.mode === 'MANUAL') {
      throw new TransferError('Session is in MANUAL mode; file editing was rejected', 409)
    }
    if (session.state !== 'WAITING_INPUT') {
      throw new TransferError(
        `Session state is ${session.state}; files can be edited only while WAITING_INPUT`,
        409,
      )
    }
  }

  /** 加宽 PTY，避免长命令被终端折行插入空格破坏路径/参数 */
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

  private async probeEngine(session: BaseSession, timeoutMs: number, signal?: AbortSignal): Promise<EditEngine> {
    const cached = this.engineCache.get(session.id)
    if (cached) return cached

    // 分行写，避免 80 列折行把标记插空格
    const probe = await this.execCapture(
      session,
      [
        'if command -v python3 >/dev/null 2>&1; then',
        '  echo SP_EDIT_ENGINE:python3',
        'elif command -v python >/dev/null 2>&1 && python -c "import sys; assert sys.version_info[0]>=3" >/dev/null 2>&1; then',
        '  echo SP_EDIT_ENGINE:python',
        'elif command -v sed >/dev/null 2>&1; then',
        '  echo SP_EDIT_ENGINE:sed',
        'else',
        '  echo SP_EDIT_ENGINE:none',
        'fi',
      ].join('\n'),
      Math.min(timeoutMs, 30_000),
      signal,
    )
    if (probe.timedOut) {
      throw new TransferError('Timed out probing remote edit engines', 504)
    }
    const m = (() => {
      const re = /(?:^|\r?\n)SP_EDIT_ENGINE:(python3|python|sed|none)/g
      let last: RegExpExecArray | null = null
      let cur: RegExpExecArray | null
      while ((cur = re.exec(probe.output)) !== null) last = cur
      return last
    })()
    const name = m?.[1]
    if (name === 'python3' || name === 'python' || name === 'sed') {
      this.engineCache.set(session.id, name)
      return name
    }
    throw new TransferError('No remote edit engine is available (requires python3, python>=3, or sed)', 502)
  }

  private async probeDecoder(session: BaseSession, timeoutMs: number, signal?: AbortSignal): Promise<'openssl' | 'base64'> {
    const cached = this.decodeCache.get(session.id)
    if (cached) return cached
    // Leading \n on each branch: this probe runs after stty -echo in the caller, so a
    // bare `echo` can land glued to a no-newline shell prompt and fail the line-anchored match.
    const probe = await this.execCapture(
      session,
      [
        "if command -v openssl >/dev/null 2>&1; then printf '\\nSP_DEC:openssl\\n'",
        "elif command -v base64 >/dev/null 2>&1; then printf '\\nSP_DEC:base64\\n'",
        "else printf '\\nSP_DEC:none\\n'; fi",
      ].join('\n'),
      Math.min(timeoutMs, 15_000),
      signal,
    )
    if (probe.timedOut) throw new TransferError('Timed out probing the remote decoder', 504)
    const m = (() => {
      const re = /(?:^|\r?\n)SP_DEC:(openssl|base64|none)/g
      let last: RegExpExecArray | null = null
      let cur: RegExpExecArray | null
      while ((cur = re.exec(probe.output)) !== null) last = cur
      return last
    })()
    if (m?.[1] === 'openssl' || m?.[1] === 'base64') {
      this.decodeCache.set(session.id, m[1])
      return m[1]
    }
    throw new TransferError('No remote base64 decoder is available (requires openssl or base64)', 502)
  }

  private async writeRemoteBase64File(
    session: BaseSession,
    remotePath: string,
    data: Buffer,
    timeoutMs: number,
    decoder: 'openssl' | 'base64',
    signal?: AbortSignal,
  ): Promise<void> {
    const token = crypto.randomBytes(4).toString('hex')
    const out = shellQuote(remotePath)
    const b64Name = `/tmp/e${token}`
    const quotedB64 = shellQuote(b64Name)
    const b64 = data.toString('base64')
    const marker = `SP_WROTE_${token}`

    // One chunk per write, each carrying its own acknowledgement, and never more than
    // one line in flight. A tty input queue only holds ~1024 bytes and an interactive
    // shell drains it slowly, so anything pushed past that is dropped by the kernel
    // mid-line and leaves the shell stuck on a PS2 continuation. See FileTransfer's
    // burstWrite for the failure this pacing was derived from.
    const chunkSize = 768
    session.write(`: > ${quotedB64}\n`)
    for (let i = 0; i < b64.length; i += chunkSize) {
      const chunk = b64.slice(i, i + chunkSize)
      const sync = `SP_S_${token}_${i}`
      const syncSeq = session.lastSeq
      session.write(`printf '%s' '${chunk}' >> ${quotedB64}; ${echoProofEcho(sync)}\n`)
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const { text } = this.historySource.history(session.id, syncSeq, 50_000)
        if (hasMarkerLine(text, sync)) break
        if (signal?.aborted || Date.now() >= deadline || session.state === 'DISCONNECTED') {
          throw new TransferError(signal?.aborted ? 'Edit canceled' : 'Timed out writing the remote temporary file', signal?.aborted ? 499 : 504)
        }
        await sleep(4)
      }
    }

    const decode =
      decoder === 'openssl'
        ? `openssl base64 -d -A -in ${quotedB64} -out ${out}`
        : `base64 -d < ${quotedB64} > ${out}`

    const drain = `SP_DRAIN_${token}`
    let startSeq = session.lastSeq
    session.write(`${echoProofEcho(drain)}\n`)
    const drainDeadline = Date.now() + timeoutMs
    for (;;) {
      const { text } = this.historySource.history(session.id, startSeq, 50_000)
      if (hasMarkerLine(text, drain)) break
      if (signal?.aborted || Date.now() >= drainDeadline || session.state === 'DISCONNECTED') {
        throw new TransferError(signal?.aborted ? 'Edit canceled' : 'Timed out writing the remote temporary file', signal?.aborted ? 499 : 504)
      }
      await sleep(40)
    }

    startSeq = session.lastSeq
    session.write(`${decode}; rm -f ${quotedB64}; ${echoProofEcho(marker)}\n`)
    const writeDeadline = Date.now() + timeoutMs
    for (;;) {
      const { text } = this.historySource.history(session.id, startSeq, 50_000)
      if (hasMarkerLine(text, marker)) break
      if (signal?.aborted || Date.now() >= writeDeadline || session.state === 'DISCONNECTED') {
        throw new TransferError(signal?.aborted ? 'Edit canceled' : 'Timed out writing the remote temporary file', signal?.aborted ? 499 : 504)
      }
      await sleep(40)
    }
    {
      const settleDeadline = Date.now() + 5_000
      while (Date.now() < settleDeadline) {
        if (signal?.aborted) break
        const state = session.state
        if (state === 'WAITING_INPUT' || state === 'DISCONNECTED') break
        await sleep(40)
      }
    }
  }

  private async runPythonEdit(
    session: BaseSession,
    engine: 'python3' | 'python',
    pathClean: string,
    edits: TextEdit[],
    timeoutMs: number,
    startAt: number,
    signal?: AbortSignal,
  ): Promise<RemoteEditResult> {
    const id = crypto.randomBytes(4).toString('hex')
    const payloadObj = { path: pathClean, edits }
    const payloadBytes = Buffer.from(JSON.stringify(payloadObj), 'utf-8')
    const scriptBytes = Buffer.from(PYTHON_EDIT_SCRIPT, 'utf-8')
    const pyBin = engine === 'python3' ? 'python3' : 'python'
    // 短路径，降低 PTY 折行破坏概率
    const scriptPath = `/tmp/spe${id}.py`
    const payloadPath = `/tmp/spe${id}.json`

    await this.widenPty(session, timeoutMs, signal)
    await this.execCapture(session, 'stty -echo 2>/dev/null || true', 10_000, signal)
    this.assertReady(session)

    const decoder = await this.probeDecoder(session, timeoutMs, signal)
    this.assertReady(session)

    try {
      const stepTimeout = Math.max(Math.floor((timeoutMs - (Date.now() - startAt)) / 3), 10_000)
      await this.writeRemoteBase64File(session, scriptPath, scriptBytes, stepTimeout, decoder, signal)
      this.assertReady(session)
      await this.writeRemoteBase64File(session, payloadPath, payloadBytes, stepTimeout, decoder, signal)
      this.assertReady(session)

      const remaining = Math.max(timeoutMs - (Date.now() - startAt), 10_000)
      const r = await this.execCapture(
        session,
        [
          `${pyBin} ${shellQuote(scriptPath)} < ${shellQuote(payloadPath)}`,
          `rm -f ${shellQuote(scriptPath)} ${shellQuote(payloadPath)}`,
          'stty echo 2>/dev/null || true',
        ].join('; '),
        remaining,
        signal,
      )
      if (r.timedOut) {
        await this.execCapture(session, 'stty echo 2>/dev/null || true', 10_000).catch(() => {})
        throw new TransferError(signal?.aborted ? 'Edit canceled' : 'Remote edit timed out', signal?.aborted ? 499 : 504)
      }
      const parsed = parseEditResult(r.output)
      if (!parsed.ok) throw mapEditError(parsed.code, parsed.message)
      return {
        ok: true,
        path: pathClean,
        engine,
        replaced: parsed.replaced,
        durationMs: Date.now() - startAt,
      }
    } catch (err) {
      await this.execCapture(
        session,
        `rm -f ${shellQuote(scriptPath)} ${shellQuote(payloadPath)}; stty echo 2>/dev/null || true`,
        10_000,
      ).catch(() => {})
      throw err
    }
  }

  private async runSedEdit(
    session: BaseSession,
    pathClean: string,
    edits: TextEdit[],
    timeoutMs: number,
    startAt: number,
    signal?: AbortSignal,
  ): Promise<RemoteEditResult> {
    if (edits.length !== 1) {
      throw new TransferError(
        'Only sed is available remotely and it does not support multiple edits; install python3 or split this into single-edit operations',
        400,
      )
    }
    const { oldText, newText } = edits[0]!
    if (!oldText) {
      throw new TransferError('oldText must not be empty', 400)
    }
    if (oldText.includes('\n') || oldText.includes('\r') || newText.includes('\n') || newText.includes('\r')) {
      throw new TransferError('Only sed is available remotely and it does not support replacements containing newlines; install python3', 400)
    }

    const quoted = shellQuote(pathClean)
    const token = crypto.randomUUID().replace(/-/g, '')
    const tmp = `/tmp/.shellink-edit-${token}`
    const oldB64 = Buffer.from(oldText, 'utf-8').toString('base64')
    const newEsc = escapeSedReplacement(newText)
    const oldEsc = escapeSedReplacement(oldText)

    // 用 python-free 方式：把 oldText 经 base64 落到临时文件，再用 grep -F -c 计次
    const remaining = Math.max(timeoutMs - (Date.now() - startAt), 10_000)
    const cmd = [
      `OLD=$(printf '%s' ${shellQuote(oldB64)} | (base64 -d 2>/dev/null || openssl base64 -d -A))`,
      `if [ ! -f ${quoted} ]; then echo SP_EDIT:err:missing:file not found; exit 0; fi`,
      `if [ ! -r ${quoted} ] || [ ! -w ${quoted} ]; then echo SP_EDIT:err:io:file not readable/writable; exit 0; fi`,
      // grep -F -c：固定字符串计数；无匹配时部分 grep 返回 exit 1，用 || true
      `CNT=$(grep -F -c -- "$OLD" ${quoted} 2>/dev/null || true)`,
      `CNT=\${CNT:-0}`,
      `if [ "$CNT" = "0" ]; then echo SP_EDIT:err:not_found:Could not find the exact text; exit 0; fi`,
      `if [ "$CNT" != "1" ]; then echo SP_EDIT:err:duplicate:Found $CNT occurrences\\; oldText must be unique; exit 0; fi`,
      `sed ${shellQuote(`s|${oldEsc}|${newEsc}|`)} ${quoted} > ${shellQuote(tmp)}`,
      `if cmp -s ${quoted} ${shellQuote(tmp)}; then rm -f ${shellQuote(tmp)}; echo SP_EDIT:err:no_change:No changes made; exit 0; fi`,
      `mv -f ${shellQuote(tmp)} ${quoted} 2>/dev/null || { cp ${shellQuote(tmp)} ${quoted} && rm -f ${shellQuote(tmp)}; }`,
      `echo SP_EDIT:ok:1`,
    ].join('; ')

    const r = await this.execCapture(session, cmd, remaining, signal)
    if (r.timedOut) throw new TransferError(signal?.aborted ? 'Edit canceled' : 'Remote edit timed out', signal?.aborted ? 499 : 504)
    const parsed = parseEditResult(r.output)
    if (!parsed.ok) throw mapEditError(parsed.code, parsed.message)
    return {
      ok: true,
      path: pathClean,
      engine: 'sed',
      replaced: parsed.replaced,
      durationMs: Date.now() - startAt,
    }
  }

  async edit(
    session: BaseSession,
    remotePath: string,
    edits: TextEdit[],
    timeoutMs = config.editTimeoutMs,
    signal?: AbortSignal,
  ): Promise<RemoteEditResult> {
    const pathClean = validateRemotePath(remotePath)
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new TransferError('edits must contain at least one replacement', 400)
    }
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]!
      if (typeof e.oldText !== 'string' || typeof e.newText !== 'string') {
        throw new TransferError(`edits[${i}].oldText and newText must be strings`, 400)
      }
      if (e.oldText.length === 0) {
        throw new TransferError(`edits[${i}].oldText must not be empty`, 400)
      }
    }

    this.assertReady(session)

    return this.opLock.withLock(session.id, async () => {
      session.beginInternal()
      try {
        const startAt = Date.now()
        const engine = await this.probeEngine(session, timeoutMs, signal)
        this.assertReady(session)

        if (engine === 'python3' || engine === 'python') {
          return this.runPythonEdit(session, engine, pathClean, edits, timeoutMs, startAt, signal)
        }
        return this.runSedEdit(session, pathClean, edits, timeoutMs, startAt, signal)
      } finally {
        // Clear buffered OSC junk, leave the internal region, then restore echo
        // publicly so the prompt is visible again in Web/history.
        session.discardPendingLine()
        session.endInternal()
        if (!session.isClosed() && session.state !== 'DISCONNECTED') {
          await this.execCapture(session, 'stty echo 2>/dev/null || true', 10_000, signal).catch(() => {})
        }
      }
    })
  }
}
