import { decode, encode } from '@msgpack/msgpack'

export const MAGIC = Buffer.from('SPIL', 'ascii')
export const HEADER_SIZE = 12
export const PROTOCOL_VERSION = 1
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024

export enum FrameKind {
  Request = 1,
  Response = 2,
  Event = 3,
}

export class ProtocolError extends Error {
  constructor(message: string, public readonly fatal = true) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export interface DecodedFrame<T = unknown> {
  kind: FrameKind
  payload: T
}

export function encodeFrame(kind: FrameKind, payload: unknown, maxBytes = DEFAULT_MAX_FRAME_BYTES): Buffer {
  if (![FrameKind.Request, FrameKind.Response, FrameKind.Event].includes(kind)) {
    throw new ProtocolError(`Unknown frame kind: ${kind}`)
  }
  const body = Buffer.from(encode(payload, { ignoreUndefined: true }))
  if (body.length > maxBytes) throw new ProtocolError(`Frame payload exceeds ${maxBytes} bytes`)
  const frame = Buffer.allocUnsafe(HEADER_SIZE + body.length)
  MAGIC.copy(frame, 0)
  frame.writeUInt16LE(PROTOCOL_VERSION, 4)
  frame[6] = kind
  frame[7] = 0
  frame.writeUInt32LE(body.length, 8)
  body.copy(frame, HEADER_SIZE)
  return frame
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0)

  constructor(private readonly maxBytes = DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: Uint8Array): DecodedFrame[] {
    if (chunk.length === 0) return []
    this.buffer = this.buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffer, Buffer.from(chunk)])
    const frames: DecodedFrame[] = []
    while (this.buffer.length >= HEADER_SIZE) {
      if (!this.buffer.subarray(0, 4).equals(MAGIC)) throw new ProtocolError('Invalid frame magic')
      const version = this.buffer.readUInt16LE(4)
      if (version !== PROTOCOL_VERSION) throw new ProtocolError(`Unsupported protocol version: ${version}`)
      const kind = this.buffer[6] as FrameKind
      if (![FrameKind.Request, FrameKind.Response, FrameKind.Event].includes(kind)) throw new ProtocolError(`Unknown frame kind: ${kind}`)
      if (this.buffer[7] !== 0) throw new ProtocolError('Non-zero frame flags are not supported')
      const length = this.buffer.readUInt32LE(8)
      if (length > this.maxBytes) throw new ProtocolError(`Frame payload exceeds ${this.maxBytes} bytes`)
      const frameLength = HEADER_SIZE + length
      if (this.buffer.length < frameLength) break
      const body = this.buffer.subarray(HEADER_SIZE, frameLength)
      let payload: unknown
      try {
        payload = decode(body)
      } catch (error) {
        throw new ProtocolError(`Invalid MessagePack payload: ${error instanceof Error ? error.message : String(error)}`)
      }
      frames.push({ kind, payload })
      this.buffer = this.buffer.subarray(frameLength)
    }
    return frames
  }

  finish(): void {
    if (this.buffer.length > 0) throw new ProtocolError('Connection ended with a truncated frame')
  }
}
