import { describe, expect, it } from 'vitest'
import {
  escapeSedReplacement,
  mapEditError,
  parseEditResult,
  RemoteEdit,
} from '../../src/core/RemoteEdit.js'
import { SessionOpLock } from '../../src/core/SessionOpLock.js'
import { TransferError } from '../../src/core/TransferError.js'
import { MockSession } from '../helpers/mockSession.js'

describe('RemoteEdit helpers', () => {
  it('escapeSedReplacement', () => {
    expect(escapeSedReplacement('a|b&c\\d')).toBe('a\\|b\\&c\\\\d')
  })

  it('parseEditResult ok and err', () => {
    expect(parseEditResult('echo SP_EDIT:ok:1\nSP_EDIT:ok:2\n')).toEqual({
      ok: true,
      replaced: 2,
    })
    expect(parseEditResult('SP_EDIT:err:missing:file not found\n')).toEqual({
      ok: false,
      code: 'missing',
      message: 'file not found',
    })
    expect(() => parseEditResult('no marker')).toThrow(TransferError)
  })

  it('mapEditError status codes', () => {
    expect(mapEditError('missing', 'x').statusCode).toBe(404)
    expect(mapEditError('not_found', 'x').statusCode).toBe(400)
    expect(mapEditError('io', 'x').statusCode).toBe(502)
  })

  it('edit rejects bad inputs and wrong state', async () => {
    const re = new RemoteEdit({ history: () => ({ cursor: 0, text: '' }) }, new SessionOpLock())
    const s = new MockSession({ id: 're1' })
    s.forceState('WAITING_INPUT')
    await expect(re.edit(s, '/tmp/x', [])).rejects.toMatchObject({ statusCode: 400 })
    await expect(re.edit(s, '/tmp/x', [{ oldText: '', newText: 'a' }])).rejects.toMatchObject({
      statusCode: 400,
    })
    s.setMode('MANUAL')
    await expect(re.edit(s, '/tmp/x', [{ oldText: 'a', newText: 'b' }])).rejects.toMatchObject({
      statusCode: 409,
    })
  })
})
