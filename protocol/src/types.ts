import type { RpcErrorData } from './errors.js'

export interface RpcRequest { id: string | number; method: string; params: unknown }
export type RpcResponse =
  | { id: string | number; ok: true; result: unknown }
  | { id: string | number; ok: false; error: RpcErrorData }
export interface RpcEvent { subscriptionId: string; event: string; data: unknown; seq?: number }

export interface HelloResult {
  serviceVersion: string
  protocolVersion: number
  capabilities: string[]
}
