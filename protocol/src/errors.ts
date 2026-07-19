export const RpcErrorCode = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  TIMEOUT: 'TIMEOUT',
  UNAVAILABLE: 'UNAVAILABLE',
} as const

export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode]

export interface RpcErrorData {
  code: RpcErrorCode | string
  message: string
  status: number
  details?: unknown
}

export class AppError extends Error {
  constructor(
    public readonly code: RpcErrorCode | string,
    message: string,
    public readonly status = 500,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }

  toJSON(): RpcErrorData {
    const result: RpcErrorData = { code: this.code, message: this.message, status: this.status }
    if (this.details !== undefined) result.details = this.details
    return result
  }
}
