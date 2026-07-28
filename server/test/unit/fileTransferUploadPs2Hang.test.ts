import { describe, expect, it } from 'vitest'
import { config } from '../../src/config.js'
import { bus } from '../../src/core/events.js'
import { FileTransfer } from '../../src/core/FileTransfer.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { MockSession } from '../helpers/mockSession.js'
import { sleep } from '../helpers/wait.js'

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
  const origWrite = s.write.bind(s)
  s.write = (chunk: string, opts?) => {
    origWrite(chunk, opts)
    if (chunk.includes('SP_CODEC') || chunk.includes('command -v base64')) {
      queueMicrotask(() => s.feed('SP_CODEC:base64\n$ '))
      return
    }
    if (chunk.includes('stty cols')) {
      queueMicrotask(() => s.feed('$ '))
      return
    }
    if (chunk.includes('SP_DRAIN_') || chunk.includes('SP_S_')) {
      const m = chunk.match(/SP_(?:DRAIN|S)_[A-Za-z0-9_]+/)?.[0]
      queueMicrotask(() => s.feed(`${m}\n$ `))
      return
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

    const origWrite = s.write.bind(s)
    s.write = (chunk: string, opts?) => {
      origWrite(chunk, opts)
      if (chunk.includes('SP_CODEC') || chunk.includes('command -v base64')) {
        queueMicrotask(() => s.feed('SP_CODEC:base64\n$ '))
        return
      }
      if (chunk.includes('stty cols')) {
        queueMicrotask(() => s.feed('$ '))
        return
      }
      if (chunk.includes('SP_DRAIN_') || chunk.includes('SP_S_')) {
        const m = chunk.match(/SP_(?:DRAIN|S)_[A-Za-z0-9_]+/)?.[0]
        queueMicrotask(() => s.feed(`${m}\n$ `))
        return
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
