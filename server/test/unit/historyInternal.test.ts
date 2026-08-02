import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bus } from '../../src/core/events.js'
import { renderHistoryWithoutInternal, sessionManager } from '../../src/core/SessionManager.js'
import { db, schema } from '../../src/db/index.js'
import { sessionService } from '../../src/services/SessionService.js'
import { MockSession } from '../helpers/mockSession.js'
import { resetDb } from '../helpers/resetDb.js'

describe('renderHistoryWithoutInternal', () => {
  it('collapses consecutive internal chunks into one placeholder', () => {
    const text = renderHistoryWithoutInternal([
      { dataRaw: 'before\n', internal: 0 },
      { dataRaw: 'SP_S_1\n', internal: 1 },
      { dataRaw: 'SP_S_2\n', internal: 1 },
      { dataRaw: 'after\n', internal: 0 },
      { dataRaw: 'SP_S_3\n', internal: 1 },
    ])
    expect(text).toBe(
      'before\n\n[shellink] hidden 2 internal transfer output chunks\nafter\n\n[shellink] hidden 1 internal transfer output chunks\n',
    )
    expect(text).not.toContain('SP_S_')
  })

  it('returns empty string for empty input', () => {
    expect(renderHistoryWithoutInternal([])).toBe('')
  })
})

describe('BaseSession internal traffic', () => {
  it('marks chunks internal and excludes them from recentOutput', () => {
    const events: Array<{ plain: string; internal: boolean }> = []
    const onData = (e: { sessionId: string; direction: string; plain: string; internal: boolean }) => {
      if (e.sessionId === 'hist-int-1' && e.direction === 'output') {
        events.push({ plain: e.plain, internal: e.internal })
      }
    }
    bus.on('session.data', onData)
    try {
      const s = new MockSession({ id: 'hist-int-1' })
      s.feed('hello\n')
      s.beginInternal()
      s.feed('SP_S_abc_1\n')
      s.endInternal()
      s.feed('world\n')
      expect(events.map((e) => e.internal)).toEqual([false, true, false])
      expect(s.isInternal()).toBe(false)
      expect(s.recentOutput()).toContain('hello')
      expect(s.recentOutput()).toContain('world')
      expect(s.recentOutput()).not.toContain('SP_S_')
    } finally {
      bus.off('session.data', onData)
    }
  })

  it('nests beginInternal/endInternal by depth', () => {
    const s = new MockSession({ id: 'hist-int-nest' })
    s.beginInternal()
    s.beginInternal()
    expect(s.isInternal()).toBe(true)
    s.endInternal()
    expect(s.isInternal()).toBe(true)
    s.endInternal()
    expect(s.isInternal()).toBe(false)
    s.endInternal()
    expect(s.isInternal()).toBe(false)
  })
})

describe('SessionManager/Service history includeInternal', () => {
  beforeEach(() => resetDb())
  afterEach(() => resetDb())

  it('hides internal transfer output on display paths', () => {
    const now = Date.now()
    db.insert(schema.sessions)
      .values({
        id: 'histint01',
        profileId: 'p1',
        profileName: 'p',
        target: 'local',
        state: 'WAITING_INPUT',
        mode: 'AUTO',
        cols: 80,
        rows: 24,
        createdAt: now,
      })
      .run()

    const s = new MockSession({ id: 'histint01' })
    s.feed('prompt$\n')
    s.beginInternal()
    s.feed('SP_CODEC:base64\n')
    s.feed('SP_S_2e569ae8_1\n')
    s.feed('SP_S_2e569ae8_2\n')
    s.endInternal()
    s.feed('done\n')

    const full = sessionManager.history('histint01', 0, 10_000)
    expect(full.text).toContain('SP_S_2e569ae8_1')
    expect(full.text).toContain('SP_CODEC:base64')

    const filtered = sessionManager.history('histint01', 0, 10_000, { includeInternal: false })
    expect(filtered.text).not.toContain('SP_S_')
    expect(filtered.text).not.toContain('SP_CODEC')
    expect(filtered.text).toContain('hidden 3 internal transfer output chunks')
    expect(filtered.text).toContain('prompt$')
    expect(filtered.text).toContain('done')

    const svc = sessionService.history({ id: 'histint01' })
    expect(svc.text).not.toContain('SP_S_')
    expect(svc.text).toContain('hidden 3 internal transfer output chunks')

    const withFlag = sessionService.history({ id: 'histint01', includeInternal: true })
    expect(withFlag.text).toContain('SP_S_2e569ae8_1')

    const raw = sessionService.rawHistory('histint01')
    expect(raw).not.toContain('SP_S_')
    expect(raw).toContain('hidden 3 internal transfer output chunks')
  })
})
