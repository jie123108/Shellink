import { eq } from 'drizzle-orm'
import { db, schema } from '../../src/db/index.js'
import { sessionManager } from '../../src/core/SessionManager.js'
import { webhookInboxService } from '../../src/services/WebhookInboxService.js'

/** Clear all tables and close any live sessions between tests. */
export function resetDb(): void {
  webhookInboxService.clear()
  for (const s of sessionManager.list()) {
    if (s.active && typeof s.id === 'string') {
      sessionManager.remove(s.id)
    }
  }
  db.delete(schema.historyChunks).run()
  db.delete(schema.sessions).run()
  db.delete(schema.webhooks).run()
  db.delete(schema.profiles).run()
}

export function deleteProfile(id: string): void {
  db.delete(schema.profiles).where(eq(schema.profiles.id, id)).run()
}
