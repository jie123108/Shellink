import { AppError, RpcErrorCode } from '@shellink/protocol'
import { TransferError } from '../core/TransferError.js'

export function asAppError(error: unknown, fallback = 'Operation failed'): AppError {
  if (error instanceof AppError) return error
  if (error instanceof TransferError) {
    const code = error.statusCode === 404
      ? RpcErrorCode.NOT_FOUND
      : error.statusCode === 409
        ? RpcErrorCode.CONFLICT
        : error.statusCode === 413
          ? RpcErrorCode.PAYLOAD_TOO_LARGE
          : RpcErrorCode.INVALID_REQUEST
    return new AppError(code, error.message, error.statusCode)
  }
  return new AppError(
    RpcErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : fallback,
    500,
  )
}
