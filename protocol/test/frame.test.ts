import { describe, expect, it } from 'vitest'
import { FrameDecoder, FrameKind, HEADER_SIZE, MAGIC, PROTOCOL_VERSION, ProtocolError, encodeFrame } from '../src/index.js'

describe('socket frame protocol', () => {
  it('matches the fixed hello golden header and round-trips', () => {
    const frame = encodeFrame(FrameKind.Request, { id: 1, method: 'system.ping', params: {} })
    expect(frame.subarray(0, 4)).toEqual(MAGIC)
    expect(frame.readUInt16LE(4)).toBe(PROTOCOL_VERSION)
    expect(frame[6]).toBe(1)
    expect(frame[7]).toBe(0)
    expect(frame.readUInt32LE(8)).toBe(frame.length - HEADER_SIZE)
    expect(frame.toString('hex')).toBe('5350494c010001002000000083a2696401a66d6574686f64ab73797374656d2e70696e67a6706172616d7380')
    expect(new FrameDecoder().push(frame)).toEqual([{ kind: FrameKind.Request, payload: { id: 1, method: 'system.ping', params: {} } }])
  })

  it('handles partial and sticky frames', () => {
    const a = encodeFrame(FrameKind.Request, { id: 'a' })
    const b = encodeFrame(FrameKind.Response, { id: 'a', ok: true })
    const decoder = new FrameDecoder()
    expect(decoder.push(a.subarray(0, 7))).toEqual([])
    expect(decoder.push(Buffer.concat([a.subarray(7), b]))).toHaveLength(2)
    decoder.finish()
  })

  it.each([
    ['magic', (f: Buffer) => { f[0] = 0 }],
    ['version', (f: Buffer) => { f.writeUInt16LE(2, 4) }],
    ['kind', (f: Buffer) => { f[6] = 9 }],
    ['flags', (f: Buffer) => { f[7] = 1 }],
  ])('rejects invalid %s', (_name, mutate) => {
    const frame = encodeFrame(FrameKind.Request, {})
    mutate(frame)
    expect(() => new FrameDecoder().push(frame)).toThrow(ProtocolError)
  })

  it('rejects oversized and truncated frames', () => {
    const frame = encodeFrame(FrameKind.Request, { value: '1234567890' })
    expect(() => new FrameDecoder(2).push(frame)).toThrow(/exceeds/)
    const decoder = new FrameDecoder()
    decoder.push(frame.subarray(0, -1))
    expect(() => decoder.finish()).toThrow(/truncated/)
  })

  it('preserves binary values', () => {
    const frame = encodeFrame(FrameKind.Response, { data: Buffer.from([0, 1, 255]) })
    const decoded = new FrameDecoder().push(frame)[0]!.payload as { data: Uint8Array }
    expect(Buffer.from(decoded.data)).toEqual(Buffer.from([0, 1, 255]))
  })

  it('rejects invalid MessagePack', () => {
    const frame = Buffer.alloc(HEADER_SIZE + 1)
    MAGIC.copy(frame); frame.writeUInt16LE(PROTOCOL_VERSION, 4); frame[6] = FrameKind.Request
    frame.writeUInt32LE(1, 8); frame[HEADER_SIZE] = 0xc1
    expect(() => new FrameDecoder().push(frame)).toThrow(/Invalid MessagePack/)
  })
})
