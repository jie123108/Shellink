import { EventEmitter } from 'node:events'
import type { SessionState, InteractionMode } from './types.js'
import type { WebhookMessage } from '../services/WebhookInboxService.js'

export interface SessionDataEvent {
  sessionId: string
  seq: number
  direction: 'output' | 'input'
  raw: string
  plain: string
}

export interface SessionStateEvent {
  sessionId: string
  state: SessionState
  prevState: SessionState
  at: number
}

export interface SessionModeEvent {
  sessionId: string
  mode: InteractionMode
}

export interface SessionClosedEvent {
  sessionId: string
  reason: string
  exitCode: number | null
}

export interface LoginExternalEvent {
  sessionId: string
  hint: string
}

export interface BusEvents {
  'session.data': (e: SessionDataEvent) => void
  'session.state': (e: SessionStateEvent) => void
  'session.mode': (e: SessionModeEvent) => void
  'session.closed': (e: SessionClosedEvent) => void
  'session.created': (e: { sessionId: string }) => void
  'session.loginExternal': (e: LoginExternalEvent) => void
  'webhook.received': (e: WebhookMessage) => void
}

class TypedBus extends EventEmitter {
  override on<K extends keyof BusEvents>(event: K, listener: BusEvents[K]): this {
    return super.on(event, listener)
  }
  override off<K extends keyof BusEvents>(event: K, listener: BusEvents[K]): this {
    return super.off(event, listener)
  }
  override emit<K extends keyof BusEvents>(event: K, ...args: Parameters<BusEvents[K]>): boolean {
    return super.emit(event, ...args)
  }
}

/** Global in-memory event bus. */
export const bus = new TypedBus()
bus.setMaxListeners(200)
