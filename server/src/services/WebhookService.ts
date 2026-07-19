import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { AppError, RpcErrorCode, webhookCreateSchema } from '@shellink/protocol'
import { db, schema } from '../db/index.js'

export class WebhookService {
  list() { return db.select().from(schema.webhooks).all() }

  create(input: unknown) {
    const parsed = webhookCreateSchema.safeParse(input)
    if (!parsed.success) throw new AppError(RpcErrorCode.INVALID_REQUEST, 'Invalid parameters', 400, parsed.error.flatten())
    const row = { id: crypto.randomUUID(), ...parsed.data, createdAt: Date.now() }
    db.insert(schema.webhooks).values(row).run()
    return row
  }

  delete(id: string): void { db.delete(schema.webhooks).where(eq(schema.webhooks.id, id)).run() }
}

export const webhookService = new WebhookService()
