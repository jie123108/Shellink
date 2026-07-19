<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NCode, NEmpty, NPopconfirm, NSpace, NTag, useMessage } from 'naive-ui'
import { api, wsUrl, type WebhookMessage } from '../api'
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()
const message = useMessage()
const messages = ref<WebhookMessage[]>([])
const loading = ref(false)
let ws: WebSocket | null = null

const callbackUrl = computed(() => `${window.location.origin}/shellink/webhook/callback`)

async function refresh() {
  loading.value = true
  try {
    messages.value = await api<WebhookMessage[]>('/webhook-messages')
  } catch (error) {
    message.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

async function clearMessages() {
  try {
    await api('/webhook-messages', { method: 'DELETE' })
    messages.value = []
    message.success(t('webhookMessages.cleared'))
  } catch (error) {
    message.error((error as Error).message)
  }
}

async function copyCallbackUrl() {
  try {
    await navigator.clipboard.writeText(callbackUrl.value)
    message.success(t('webhookMessages.copied'))
  } catch {
    message.error(t('webhookMessages.copyFailed'))
  }
}

function eventName(item: WebhookMessage): string | null {
  if (!item.data || typeof item.data !== 'object' || Array.isArray(item.data)) return null
  const event = (item.data as Record<string, unknown>).event
  return typeof event === 'string' ? event : null
}

function formatData(data: unknown): string {
  return JSON.stringify(data, null, 2) ?? String(data)
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(value)
}

onMounted(async () => {
  await refresh()
  ws = new WebSocket(wsUrl('/events'))
  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as WebhookMessage & { type?: string }
      if (payload.type !== 'webhookReceived') return
      messages.value = [payload, ...messages.value.filter((item) => item.id !== payload.id)].slice(0, 200)
    } catch {
      // Ignore unrelated or malformed event messages.
    }
  }
})

onBeforeUnmount(() => ws?.close())
</script>

<template>
  <div class="webhook-page">
    <div class="page-header">
      <h1>{{ t('webhookMessages.title') }}</h1>
      <NSpace>
        <NButton size="small" :loading="loading" @click="refresh">{{ t('common.refresh') }}</NButton>
        <NPopconfirm :disabled="messages.length === 0" @positive-click="clearMessages">
          <template #trigger>
            <NButton size="small" type="error" ghost :disabled="messages.length === 0">
              {{ t('webhookMessages.clear') }}
            </NButton>
          </template>
          {{ t('webhookMessages.clearConfirm') }}
        </NPopconfirm>
      </NSpace>
    </div>

    <div class="callback-bar">
      <span>{{ t('webhookMessages.callbackUrl') }}</span>
      <code>{{ callbackUrl }}</code>
      <NButton size="small" @click="copyCallbackUrl">{{ t('dashboard.copy') }}</NButton>
    </div>

    <NEmpty v-if="messages.length === 0 && !loading" :description="t('webhookMessages.empty')" class="empty" />
    <div v-else class="message-list">
      <article v-for="item in messages" :key="item.id" class="message-item">
        <header>
          <NTag v-if="eventName(item)" size="small" type="info">{{ eventName(item) }}</NTag>
          <span>{{ t('webhookMessages.receivedAt') }}: {{ formatTime(item.receivedAt) }}</span>
        </header>
        <NCode :code="formatData(item.data)" language="json" word-wrap />
      </article>
    </div>
  </div>
</template>

<style scoped>
.webhook-page {
  max-width: 1120px;
  margin: 0 auto;
}
.callback-bar {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) max-content;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  border: 1px solid var(--line);
  background: var(--surface-muted);
  border-radius: var(--radius-lg);
  color: var(--text-soft);
  font-size: 12.5px;
  margin-bottom: 20px;
}
.callback-bar code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text);
  font-family: var(--font-mono);
}
.message-list {
  margin-top: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  overflow: hidden;
}
.message-item {
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}
.message-item:last-child {
  border-bottom: 0;
}
.message-item header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 24px;
  margin-bottom: 8px;
  color: var(--text-muted);
  font-size: 13px;
}
.message-item :deep(pre) {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.empty {
  margin: 64px 0;
}
@media (max-width: 640px) {
  .callback-bar {
    grid-template-columns: 1fr max-content;
  }
  .callback-bar > span {
    grid-column: 1 / -1;
  }
}
</style>
