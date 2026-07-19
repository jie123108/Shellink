import crypto from 'node:crypto'

export interface WebhookMessage {
  id: string
  receivedAt: number
  data: unknown
}

const MAX_MESSAGES = 200

export class WebhookInboxService {
  private readonly messages: WebhookMessage[] = []

  list(): WebhookMessage[] {
    return [...this.messages].reverse()
  }

  receive(data: unknown): WebhookMessage {
    const message = { id: crypto.randomUUID(), receivedAt: Date.now(), data }
    this.messages.push(message)
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.splice(0, this.messages.length - MAX_MESSAGES)
    }
    return message
  }

  clear(): void {
    this.messages.length = 0
  }
}

export const webhookInboxService = new WebhookInboxService()
