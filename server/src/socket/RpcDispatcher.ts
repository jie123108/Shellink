import { AppError, PROTOCOL_VERSION, RpcErrorCode, rpcMethodSchemas, type RpcMethod } from '@shellink/protocol'
import { bus } from '../core/events.js'
import { profileService } from '../services/ProfileService.js'
import { sessionService } from '../services/SessionService.js'
import { SystemService } from '../services/SystemService.js'
import { webhookService } from '../services/WebhookService.js'
import { asAppError } from '../services/errors.js'

export interface SubscriptionSink {
  addSubscription(sessionId: string | undefined, replay: boolean): { subscriptionId: string; initial: unknown }
  removeSubscription(subscriptionId: string): boolean
}

export class RpcDispatcher {
  constructor(private readonly system: SystemService) {}

  async dispatch(method: string, input: unknown, sink: SubscriptionSink): Promise<unknown> {
    if (!(method in rpcMethodSchemas)) throw new AppError(RpcErrorCode.METHOD_NOT_FOUND, `Unknown method: ${method}`, 404)
    const schema = rpcMethodSchemas[method as RpcMethod]
    const parsed = schema.safeParse(input ?? {})
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    const params = parsed.data as Record<string, any>
    try {
      switch (method as RpcMethod) {
        case 'system.hello':
          if (params.protocolVersion !== PROTOCOL_VERSION) throw new AppError(RpcErrorCode.PROTOCOL_ERROR, `Incompatible protocol version: ${params.protocolVersion}`, 400)
          return this.system.hello()
        case 'system.ping': return this.system.ping()
        case 'system.status': return this.system.status()
        case 'system.stop': return this.system.stop()
        case 'profiles.list': return profileService.list(params)
        case 'profiles.get': return profileService.get(params.id)
        case 'profiles.create': return profileService.create(params)
        case 'profiles.update': return profileService.update(params.id, params.profile)
        case 'profiles.delete': profileService.delete(params.id); return { ok: true }
        case 'sessions.list': return sessionService.list()
        case 'sessions.create': return sessionService.create(params)
        case 'sessions.state': return sessionService.state(params.id)
        case 'sessions.history': return sessionService.history(params)
        case 'sessions.input': return sessionService.input(params)
        case 'sessions.exec': return await sessionService.exec(params)
        case 'sessions.download': return await sessionService.download(params.id, params.path, params.timeoutMs)
        case 'sessions.upload': return await sessionService.upload(params.id, params.path, Buffer.from(params.data), { timeoutMs: params.timeoutMs, expectedSha256: params.sha256 })
        case 'sessions.edit': return await sessionService.edit(params.id, params.path, params.edits, params.timeoutMs)
        case 'sessions.mode': return sessionService.mode(params)
        case 'sessions.resize': sessionService.resize(params.id, params.cols, params.rows); return { ok: true }
        case 'sessions.close': return sessionService.close(params.id)
        case 'sessions.removeRecord': return sessionService.removeRecord(params.id)
        case 'webhooks.list': return webhookService.list()
        case 'webhooks.create': return webhookService.create(params)
        case 'webhooks.delete': webhookService.delete(params.id); return { ok: true }
        case 'events.subscribe': return sink.addSubscription(params.sessionId, params.replay)
        case 'events.unsubscribe': return { removed: sink.removeSubscription(params.subscriptionId) }
      }
    } catch (error) {
      throw asAppError(error)
    }
  }
}

export const subscriptionEventNames = Object.freeze([
  'session.data', 'session.state', 'session.mode', 'session.closed', 'session.created', 'session.loginExternal',
] as const)
export type SubscriptionEventName = (typeof subscriptionEventNames)[number]

export function eventBus() { return bus }
