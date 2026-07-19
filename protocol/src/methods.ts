import { z } from 'zod'
import {
  idSchema,
  profileCreateSchema,
  profileUpdateSchema,
  sessionCreateSchema,
  sessionExecSchema,
  sessionHistorySchema,
  sessionInputSchema,
  sessionModeSchema,
  sessionResizeSchema,
  webhookCreateSchema,
} from './schemas.js'

const empty = z.object({})
export const rpcMethodSchemas = {
  'system.hello': z.object({ protocolVersion: z.number().int(), clientVersion: z.string().optional() }),
  'system.ping': empty,
  'system.status': empty,
  'system.stop': empty,
  'profiles.list': z.object({ q: z.string().optional() }),
  'profiles.get': idSchema,
  'profiles.create': profileCreateSchema,
  'profiles.update': idSchema.extend({ profile: profileUpdateSchema }),
  'profiles.delete': idSchema,
  'sessions.list': empty,
  'sessions.create': sessionCreateSchema,
  'sessions.state': idSchema,
  'sessions.history': sessionHistorySchema,
  'sessions.input': sessionInputSchema,
  'sessions.exec': sessionExecSchema,
  'sessions.download': idSchema.extend({ path: z.string().min(1), timeoutMs: z.number().int().optional() }),
  'sessions.upload': idSchema.extend({ path: z.string().min(1), data: z.instanceof(Uint8Array), timeoutMs: z.number().int().optional(), sha256: z.string().optional() }),
  'sessions.edit': idSchema.extend({ path: z.string().min(1), edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1), timeoutMs: z.number().int().optional() }),
  'sessions.mode': sessionModeSchema,
  'sessions.resize': sessionResizeSchema,
  'sessions.close': idSchema,
  'sessions.removeRecord': idSchema,
  'webhooks.list': empty,
  'webhooks.create': webhookCreateSchema,
  'webhooks.delete': idSchema,
  'events.subscribe': z.object({ sessionId: z.string().optional(), replay: z.boolean().default(false) }),
  'events.unsubscribe': z.object({ subscriptionId: z.string().min(1) }),
} as const

export type RpcMethod = keyof typeof rpcMethodSchemas
export const RPC_METHODS = Object.freeze(Object.keys(rpcMethodSchemas) as RpcMethod[])
