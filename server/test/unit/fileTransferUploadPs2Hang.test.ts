import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import { bus } from '../../src/core/events.js'
import { echoProofEcho, FileTransfer, hasMarkerLine } from '../../src/core/FileTransfer.js'
import { LocalPtySession } from '../../src/core/LocalPtySession.js'
import { sessionManager } from '../../src/core/SessionManager.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { extractEchoProofMarker } from '../helpers/echoProofMarker.js'
import { MockSession } from '../helpers/mockSession.js'
import { sleep, waitUntil } from '../helpers/wait.js'

function trackHistory(sessionId: string) {
  const stored: Array<{ seq: number; plain: string }> = []
  const onData = (e: { sessionId: string; seq: number; direction: string; plain: string }) => {
    if (e.sessionId === sessionId && e.direction === 'output') {
      stored.push({ seq: e.seq, plain: e.plain })
    }
  }
  bus.on('session.data', onData)
  return {
    historySource: {
      history(_id: string, since = 0) {
        const parts = stored.filter((c) => c.seq > since)
        return {
          cursor: parts.length ? parts[parts.length - 1]!.seq : since,
          text: parts.map((c) => c.plain).join(''),
        }
      },
    },
    stop: () => bus.off('session.data', onData),
  }
}

function scriptUpload(s: MockSession, data: Buffer): void {
  s.resize = () => {}
  const encoded = data.toString('base64')
  const origWrite = s.write.bind(s)
  s.write = (chunk: string, opts?) => {
    origWrite(chunk, opts)
    if (chunk.includes('SP_CODEC') || chunk.includes('command -v base64')) {
      queueMicrotask(() => s.feed('SP_CODEC:base64\n$ '))
      return
    }
    if (chunk.includes('stty cols') || chunk.includes('stty -echo') || chunk.includes('stty echo')) {
      queueMicrotask(() => s.feed('$ '))
      return
    }
    if (chunk.includes('SP_SZ')) {
      queueMicrotask(() => s.feed(`SP_SZ:${encoded.length}\n$ `))
      return
    }
    if (chunk.includes("printf '\\n%s%s\\n'")) {
      const marker = extractEchoProofMarker(chunk)
      if (marker) {
        queueMicrotask(() => s.feed(`${marker}\n$ `))
        return
      }
    }
    if (chunk.includes('SP_UP')) {
      queueMicrotask(() => { s.feed(`SP_UP:${data.length}\n$ `); s.forceState('WAITING_INPUT') })
    }
  }
}

describe('upload PS2 hang regression', () => {
  it('default prompt regex still classifies a lone PS2 `>` as WAITING_INPUT (known limitation)', async () => {
    const s = new MockSession({ id: 'ps2-prompt' })
    s.completeLoginPublic()
    s.feed('>')
    await sleep(config.silenceThresholdMs + 40)
    expect(s.state).toBe('WAITING_INPUT')
  })

  it('waitForStable times out when already WAITING_INPUT and no output arrives', async () => {
    const s = new MockSession({ id: 'ps2-already-waiting' })
    s.forceState('WAITING_INPUT')
    const r = await s.waitForStable(200, { acceptIdle: false })
    expect(r.timedOut).toBe(true)
    expect(r.state).toBe('WAITING_INPUT')
  })

  it('upload succeeds on a slow path (no heredoc, no PS2, no hang)', async () => {
    const sessionId = 'up-ps2-fixed'
    const { historySource, stop } = trackHistory(sessionId)
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: sessionId })
    s.forceState('WAITING_INPUT')
    const data = Buffer.from('shellink-ps2-repro\n')
    scriptUpload(s, data)

    try {
      const meta = await ft.upload(s, '/tmp/shellink-ps2-repro.txt', data, { timeoutMs: 5_000 })
      expect(meta.size).toBe(data.length)
      expect(meta.codec).toBe('base64')
    } finally {
      stop()
    }
  }, 15_000)

  it('upload succeeds even with slow decode (verify echo provides the transition)', async () => {
    const sessionId = 'up-ps2-slow-decode'
    const { historySource, stop } = trackHistory(sessionId)
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: sessionId })
    s.forceState('WAITING_INPUT')
    s.resize = () => {}
    const data = Buffer.from('slow-decode-repro\n')
    const encoded = data.toString('base64')

    const origWrite = s.write.bind(s)
    s.write = (chunk: string, opts?) => {
      origWrite(chunk, opts)
      if (chunk.includes('SP_CODEC') || chunk.includes('command -v base64')) {
        queueMicrotask(() => s.feed('SP_CODEC:base64\n$ '))
        return
      }
      if (chunk.includes('stty cols') || chunk.includes('stty -echo') || chunk.includes('stty echo')) {
        queueMicrotask(() => s.feed('$ '))
        return
      }
      if (chunk.includes('SP_SZ')) {
        queueMicrotask(() => s.feed(`SP_SZ:${encoded.length}\n$ `))
        return
      }
      if (chunk.includes("printf '\\n%s%s\\n'")) {
        const marker = extractEchoProofMarker(chunk)
        if (marker) {
          queueMicrotask(() => s.feed(`${marker}\n$ `))
          return
        }
      }
      if (chunk.includes('SP_UP')) {
        void (async () => {
          await sleep(config.silenceThresholdMs + 100)
          s.feed(`SP_UP:${data.length}\n$ `); s.forceState('WAITING_INPUT')
        })()
      }
    }

    try {
      const meta = await ft.upload(s, '/tmp/slow-decode.txt', data, { timeoutMs: 5_000 })
      expect(meta.size).toBe(data.length)
    } finally {
      stop()
    }
  }, 15_000)

  it('detects mid-stream byte loss via the staged-size check and self-heals with Ctrl+C instead of hanging', async () => {
    const sessionId = 'up-corrupt-recover'
    const { historySource, stop } = trackHistory(sessionId)
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: sessionId })
    s.forceState('WAITING_INPUT')
    s.resize = () => {}
    const data = Buffer.from('x'.repeat(2_000))
    const encoded = data.toString('base64')

    const orig = s.write.bind(s)
    s.write = (chunk: string, opts?) => {
      orig(chunk, opts)
      if (chunk.includes('\u0003')) {
        // The shell prints ^C and a fresh prompt once Ctrl+C is delivered.
        queueMicrotask(() => s.feed('^C\n$ '))
        return
      }
      if (chunk.includes('SP_CODEC') || chunk.includes('command -v base64')) {
        queueMicrotask(() => s.feed('SP_CODEC:base64\n$ '))
        return
      }
      if (chunk.includes('stty cols') || chunk.includes('stty -echo') || chunk.includes('stty echo')) {
        queueMicrotask(() => s.feed('$ '))
        return
      }
      if (chunk.includes('SP_SZ')) {
        // Simulate the PS2-hang failure mode: some bytes were silently dropped
        // in transit, so the staged file is shorter than what was sent. This
        // must happen on every attempt (including the smaller-chunk retry) so
        // stageEncodedPayload exhausts its retries and reports a clear error.
        queueMicrotask(() => s.feed(`SP_SZ:${encoded.length - 7}\n$ `))
        return
      }
      if (chunk.includes("printf '\\n%s%s\\n'")) {
        const marker = extractEchoProofMarker(chunk)
        if (marker) {
          queueMicrotask(() => s.feed(`${marker}\n$ `))
          return
        }
      }
      // printf staging writes need no reply.
    }

    try {
      const start = Date.now()
      await expect(ft.upload(s, '/tmp/corrupt.txt', data, { timeoutMs: 20_000 })).rejects.toMatchObject({
        message: expect.stringContaining('corrupted'),
        statusCode: 502,
      })
      // Must fail fast on the integrity check, not hang until timeoutMs.
      expect(Date.now() - start).toBeLessThan(5_000)
      expect(s.writes).toContain('\u0003')
    } finally {
      stop()
    }
  }, 15_000)

  it('a bare status marker glued to a no-newline prompt is undetectable, which is why every marker now prints its own leading newline', () => {
    // Real-machine failure mode found via e2e testing: once `stty -echo` is on,
    // bash's "$ " prompt has no trailing newline (the Enter keystroke that used
    // to supply it is no longer echoed), so back-to-back no-output commands
    // (staging printfs, stty probes) pile their prompts onto a single line.
    const marker = 'SP_SZ:1368'
    const gluedNoLeadingNewline = '$ $ $ $ $ ' + marker // pre-fix: bare `echo SP_SZ:...`
    const gluedWithLeadingNewline = '$ $ $ $ $ \n' + marker // post-fix: `printf '\\nSP_SZ:...\\n'`
    expect(hasMarkerLine(gluedNoLeadingNewline, marker)).toBe(false)
    expect(hasMarkerLine(gluedWithLeadingNewline, marker)).toBe(true)
  })

  it('finds sync/verify markers even when no-op prompts glue together with no separating newline (local echo off)', async () => {
    const sessionId = 'up-glued-prompts'
    const { historySource, stop } = trackHistory(sessionId)
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: sessionId })
    s.forceState('WAITING_INPUT')
    s.resize = () => {}
    const data = Buffer.from('glued-prompt-repro\n')
    const encoded = data.toString('base64')

    const orig = s.write.bind(s)
    s.write = (chunk: string, opts?) => {
      orig(chunk, opts)
      if (chunk.includes('SP_CODEC') || chunk.includes('command -v base64')) {
        queueMicrotask(() => s.feed('SP_CODEC:base64\n$ '))
        return
      }
      if (chunk.includes('SP_SZ')) {
        // Leading \n mirrors the real `printf '\nSP_SZ:%s\n' ...` fix: its own
        // output supplies the newline the glued no-op prompts below never do.
        queueMicrotask(() => s.feed(`\nSP_SZ:${encoded.length}\n$ `))
        return
      }
      const marker = extractEchoProofMarker(chunk)
      if (marker) {
        queueMicrotask(() => s.feed(`\n${marker}\n$ `))
        return
      }
      if (chunk.includes('SP_UP')) {
        queueMicrotask(() => { s.feed(`\nSP_UP:${data.length}\n$ `); s.forceState('WAITING_INPUT') })
        return
      }
      // Every other command (stty cols/-echo/echo, printf staging writes)
      // produces no stdout of its own, so real bash's "$ " prompt has no
      // trailing newline once local echo is off — simulate the worst case
      // where dozens of these pile up back-to-back on a single line.
      queueMicrotask(() => s.feed('$ '))
    }

    try {
      const meta = await ft.upload(s, '/tmp/glued-prompt.txt', data, { timeoutMs: 5_000 })
      expect(meta.size).toBe(data.length)
      expect(meta.codec).toBe('base64')
    } finally {
      stop()
    }
  }, 15_000)

  it('a sync marker is not falsely satisfied by the terminal echoing its own `echo \'A\'\'B\'` source line', () => {
    const marker = 'SP_DRAIN_abc123'
    const echoCmd = echoProofEcho(marker)
    expect(echoCmd).not.toContain(marker)
    // The PTY's local echo of the typed command line must not itself satisfy the marker wait.
    expect(hasMarkerLine(`${echoCmd}\n`, marker)).toBe(false)
    // Only the shell's *executed* output (the concatenated marker on its own line) matches.
    expect(hasMarkerLine(`${echoCmd}\n${marker}\n`, marker)).toBe(true)
  })

  it('stages a 10KB payload through a tty whose input queue silently drops anything past TTYHOG (1024 bytes)', async () => {
    // Real-machine failure mode: batching four 512-byte chunks into one ~2190-byte
    // write overflowed the kernel's tty input queue while interactive bash was still
    // reading the earlier bytes. The overflow is discarded without any error, so a
    // printf line lost its closing quote and bash sat in a PS2 continuation until the
    // upload timed out. 1KB survived (one ~1470-byte batch, a race it usually won)
    // while 10KB failed every time, which is why this covers the 10KB size.
    const TTYHOG = 1024
    const sessionId = 'up-ttyhog-overflow'
    const { historySource, stop } = trackHistory(sessionId)
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: sessionId })
    s.forceState('WAITING_INPUT')
    s.resize = () => {}
    const data = Buffer.alloc(10 * 1024, 'A')
    const encoded = data.toString('base64')

    let staged = 0
    let inPs2 = false
    let maxWriteBytes = 0
    let pending = ''
    const orig = s.write.bind(s)
    s.write = (chunk: string, opts?) => {
      orig(chunk, opts)
      maxWriteBytes = Math.max(maxWriteBytes, Buffer.byteLength(chunk))
      // The kernel accepts only what still fits in the queue and drops the rest.
      const accepted = chunk.slice(0, Math.max(0, TTYHOG - pending.length))
      pending += accepted
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      queueMicrotask(() => {
        for (const line of lines) {
          // A truncated line leaves an unbalanced quote: bash drops to PS2 and
          // everything after it is swallowed as continuation input.
          if (inPs2 || (line.split("'").length - 1) % 2 !== 0) {
            inPs2 = true
            s.feed('> ')
            continue
          }
          const marker = extractEchoProofMarker(line)
          const stagedChunk = /printf '%s' '([^']*)'/.exec(line)
          if (stagedChunk) staged += stagedChunk[1]!.length
          if (line.includes('SP_CODEC') || line.includes('command -v base64')) s.feed('\nSP_CODEC:base64\n')
          else if (line.includes('SP_SZ')) s.feed(`\nSP_SZ:${staged}\n`)
          else if (line.includes('SP_UP')) {
            s.feed(`\nSP_UP:${data.length}\n`)
            s.forceState('WAITING_INPUT')
          } else if (marker) s.feed(`\n${marker}\n`)
          s.feed('$ ')
        }
      })
    }

    try {
      const meta = await ft.upload(s, '/tmp/ttyhog.bin', data, { timeoutMs: 20_000 })
      expect(inPs2).toBe(false)
      expect(staged).toBe(encoded.length)
      expect(meta.size).toBe(data.length)
      expect(maxWriteBytes).toBeLessThanOrEqual(TTYHOG)
    } finally {
      stop()
    }
  }, 30_000)

  it('upload times out rather than proceeding when a stalled shell only echoes the sync command, never runs it', async () => {
    const sessionId = 'up-echo-only-no-exec'
    const { historySource, stop } = trackHistory(sessionId)
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: sessionId })
    s.forceState('WAITING_INPUT')
    s.resize = () => {}
    const data = Buffer.from('echo-repro-data\n')
    const encoded = data.toString('base64')

    const orig = s.write.bind(s)
    s.write = (chunk: string, opts?) => {
      orig(chunk, opts)
      if (chunk.includes('SP_CODEC') || chunk.includes('command -v base64')) {
        queueMicrotask(() => s.feed('SP_CODEC:base64\n$ '))
        return
      }
      if (chunk.includes('stty cols') || chunk.includes('stty -echo') || chunk.includes('stty echo')) {
        queueMicrotask(() => s.feed('$ '))
        return
      }
      if (chunk.includes('SP_SZ')) {
        queueMicrotask(() => s.feed(`SP_SZ:${encoded.length}\n$ `))
        return
      }
      if (chunk.includes("printf '\\n%s%s\\n'")) {
        // A stalled/buffered shell that only echoes the typed line back without
        // ever executing it: the raw source text literally contains the marker
        // (split by empty-string concatenation), which must not satisfy the wait.
        queueMicrotask(() => s.feed(`${chunk}$ `))
        return
      }
      // printf staging writes need no reply.
    }

    try {
      // burstWrite/drain floor the remaining wait at 10s regardless of timeoutMs,
      // so this still takes ~10s to time out even with a tiny requested budget.
      await expect(ft.upload(s, '/tmp/echo-only.txt', data, { timeoutMs: 300 })).rejects.toMatchObject({
        statusCode: 504,
      })
    } finally {
      stop()
    }
  }, 15_000)

  it('drain() waits for stdin backpressure to clear so a large write burst is not dropped (Bun pipe fallback)', async () => {
    const runtime = globalThis as typeof globalThis & { Bun?: unknown }
    const previousBun = runtime.Bun
    const previousPath = process.env.PATH
    runtime.Bun = {}
    // Force the plain-pipe fallback (no `expect` on PATH) so the child's stdin
    // is a real Writable we can drive past its highWaterMark, with no PTY echo
    // to muddy the byte-for-byte comparison below.
    process.env.PATH = ''
    const sessionId = 'pty-backpressure'
    let received = ''
    const onData = (e: { sessionId: string; direction: string; plain: string }) => {
      if (e.sessionId === sessionId && e.direction === 'output') received += e.plain
    }
    bus.on('session.data', onData)
    try {
      const s = new LocalPtySession({
        id: sessionId,
        profileId: 'p',
        profileName: 'pipe',
        term: 'xterm',
        cols: 80,
        rows: 24,
        command: 'cat',
      })
      s.connect()
      await sleep(200)

      const lines: string[] = []
      for (let i = 0; i < 4_000; i++) lines.push(`line-${i}-${'x'.repeat(40)}`)
      const payload = lines.map((l) => `${l}\n`).join('')

      // One large synchronous write (well past the default 16KB highWaterMark)
      // so stdin.write() returns false and PipeProcess queues via trackDrain.
      s.write(payload)
      await s.drain()
      await waitUntil(() => received.length >= payload.length, {
        timeoutMs: 10_000,
        message: `child only echoed back ${received.length} of ${payload.length} bytes`,
      })

      expect(received).toBe(payload)
    } finally {
      bus.off('session.data', onData)
      process.env.PATH = previousPath
      if (previousBun === undefined) delete runtime.Bun
      else runtime.Bun = previousBun
    }
  }, 20_000)

  it('history() flushes the batched write queue before reading, so a rapid burst is never lost', () => {
    const sessionId = `hist-batch-${Date.now()}`
    const s = new MockSession({ id: sessionId })
    s.forceState('WAITING_INPUT')
    const total = 250
    for (let i = 0; i < total; i++) {
      s.feed(`line-${i}\n`)
    }
    // No await: the batched insert is scheduled via setImmediate and has not
    // run yet, so history() must flush the pending buffer itself before reading.
    const { text } = sessionManager.history(sessionId, 0, 10_000)
    for (let i = 0; i < total; i++) {
      expect(text).toContain(`line-${i}\n`)
    }
  })

  it('upload no longer sends heredoc (`<<`) in any write', async () => {
    const sessionId = 'up-no-heredoc'
    const { historySource, stop } = trackHistory(sessionId)
    const ft = new FileTransfer(historySource, new SessionOpLock())
    const s = new MockSession({ id: sessionId })
    s.forceState('WAITING_INPUT')
    const data = Buffer.from('heredoc-check\n')
    let sawHeredoc = false
    scriptUpload(s, data)
    const orig = s.write.bind(s)
    s.write = (chunk: string, opts?) => {
      if (chunk.includes('<<')) sawHeredoc = true
      orig(chunk, opts)
    }

    try {
      await ft.upload(s, '/tmp/no-heredoc.txt', data, { timeoutMs: 5_000 })
      expect(sawHeredoc).toBe(false)
      expect(s.writes.some((w) => w.includes("printf '%s'"))).toBe(true)
    } finally {
      stop()
    }
  }, 15_000)
})
