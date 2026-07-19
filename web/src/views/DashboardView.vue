<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  NButton,
  NCard,
  NTag,
  NEmpty,
  NModal,
  NSelect,
  NSpace,
  NPopconfirm,
  useMessage,
} from 'naive-ui'
import { api, getToken, getSensitiveOpsAuth, type SessionSummary, type Profile } from '../api'
import { useSessionsStore } from '../stores/sessions'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const message = useMessage()
const { t } = useI18n()
const sessionsStore = useSessionsStore()

const profiles = ref<Profile[]>([])
const showCreate = ref(false)
const selectedProfile = ref<string | null>(null)
const creating = ref(false)
const purging = ref(false)
const hasToken = ref(!!getToken())
/** From server policy: whether delete/purge needs a token. Safe default until loaded. */
const requireTokenForDelete = ref(true)
const canDeleteRecords = computed(() => !requireTokenForDelete.value || hasToken.value)

type PurgeScope = '24h' | '7d' | 'all'

const STATE_TAG: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  CONNECTING: 'warning',
  OUTPUTTING: 'info',
  IDLE: 'warning',
  WAITING_INPUT: 'success',
  DISCONNECTED: 'default',
}

const profileOptions = computed(() =>
  profiles.value.map((p) => {
    const target =
      p.connectType === 'command' ? (p.command ?? 'command') : `${p.username}@${p.host}`
    return { label: `${p.name} (${target})`, value: p.id }
  }),
)

async function loadProfiles() {
  profiles.value = await api<Profile[]>('/profiles')
}

async function createSession() {
  if (!selectedProfile.value) return
  creating.value = true
  try {
    const res = await api<{ id: string }>('/sessions', {
      method: 'POST',
      body: { profileId: selectedProfile.value },
    })
    showCreate.value = false
    await sessionsStore.refresh()
    router.push(`/sessions/${res.id}`)
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

async function closeSession(id: string) {
  try {
    await api(`/sessions/${id}`, { method: 'DELETE' })
    await sessionsStore.refresh()
  } catch (e) {
    message.error((e as Error).message)
  }
}

async function deleteSessionRecord(id: string) {
  if (requireTokenForDelete.value && !getToken()) {
    message.warning(t('dashboard.deleteNeedsToken'))
    return
  }
  try {
    await api(`/sessions/${id}/record`, { method: 'DELETE' })
    message.success(t('dashboard.deleted'))
    await sessionsStore.refresh()
  } catch (e) {
    message.error((e as Error).message)
  }
}

async function purgeClosedRecords(olderThan: PurgeScope) {
  if (requireTokenForDelete.value && !getToken()) {
    message.warning(t('dashboard.deleteNeedsToken'))
    return
  }
  if (purging.value) return
  purging.value = true
  try {
    const res = await api<{ ok: boolean; deleted: number }>(
      `/sessions/records?olderThan=${encodeURIComponent(olderThan)}`,
      { method: 'DELETE' },
    )
    message.success(t('dashboard.purged', { count: res.deleted }))
    await sessionsStore.refresh()
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    purging.value = false
  }
}

async function copySessionId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    message.success(t('dashboard.copied', { id }))
  } catch {
    message.error(t('dashboard.copyFailed'))
  }
}

function uptime(s: SessionSummary): string {
  const end = s.closedAt ?? Date.now()
  const secs = Math.floor((end - s.createdAt) / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m${secs % 60}s`
  return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`
}

function formatStartedAt(createdAt: number): string {
  const date = new Date(createdAt)
  if (!Number.isFinite(createdAt) || Number.isNaN(date.getTime())) return ''
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${min}`
}

function initialsOf(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || 'SH'
}

onMounted(async () => {
  hasToken.value = !!getToken()
  const [auth] = await Promise.all([
    getSensitiveOpsAuth(),
    sessionsStore.init(),
    loadProfiles(),
  ])
  requireTokenForDelete.value = auth.requireToken
})
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h1>{{ t('dashboard.title') }}</h1>
        <div class="sub">{{ t('app.dashSub') }}</div>
      </div>
      <NButton type="primary" @click="showCreate = true">{{ t('dashboard.newSession') }}</NButton>
    </div>

    <div class="section-heading">
      <h2>{{ t('dashboard.activeSessions') }} · {{ sessionsStore.activeSessions.length }}</h2>
    </div>
    <NEmpty
      v-if="sessionsStore.activeSessions.length === 0"
      :description="t('dashboard.noActive')"
      style="margin: 32px 0"
    />
    <div class="grid">
      <NCard
        v-for="s in sessionsStore.activeSessions"
        :key="s.id"
        size="small"
        hoverable
        class="session-card active"
        @click="router.push(`/sessions/${s.id}`)"
      >
        <template #header>
          <span class="card-title">
            <span class="session-card-avatar">{{ initialsOf(s.profileName) }}</span>
            {{ s.profileName }}
          </span>
        </template>
        <template #header-extra>
          <NTag :type="STATE_TAG[s.state] ?? 'default'" size="small" round>
            {{ s.state }}
          </NTag>
        </template>
        <div class="meta mono">{{ s.target }}</div>
        <div class="meta-row">
          <span>ID</span>
          <span
            class="id-chip"
            :title="t('dashboard.copy')"
            @click.stop="copySessionId(s.id)"
          >{{ s.id }}</span>
          <NTag size="tiny" :type="s.mode === 'AUTO' ? 'info' : 'warning'" round>{{ s.mode }}</NTag>
          <span>{{ t('dashboard.startedAt') }} {{ formatStartedAt(s.createdAt) }}</span>
          <span>{{ t('dashboard.alive') }} {{ uptime(s) }}</span>
        </div>
        <template #action>
          <NSpace justify="end">
            <NButton size="tiny" @click.stop="router.push(`/sessions/${s.id}/history`)">
              {{ t('common.history') }}
            </NButton>
            <NPopconfirm @positive-click="closeSession(s.id)">
              <template #trigger>
                <NButton size="tiny" type="error" ghost @click.stop>{{ t('common.close') }}</NButton>
              </template>
              {{ t('dashboard.closeConfirm') }}
            </NPopconfirm>
            <NPopconfirm v-if="canDeleteRecords" @positive-click="deleteSessionRecord(s.id)">
              <template #trigger>
                <NButton size="tiny" type="error" @click.stop>{{ t('common.delete') }}</NButton>
              </template>
              {{ t('dashboard.deleteConfirm') }}
            </NPopconfirm>
          </NSpace>
        </template>
      </NCard>
    </div>

    <div class="section-heading">
      <h2>{{ t('dashboard.recentSessions') }}</h2>
      <NSpace v-if="canDeleteRecords" :size="8">
        <NPopconfirm :disabled="purging" @positive-click="purgeClosedRecords('7d')">
          <template #trigger>
            <NButton size="small" type="error" ghost :loading="purging" :disabled="purging">
              {{ t('dashboard.purgeOlderWeek') }}
            </NButton>
          </template>
          {{ t('dashboard.purgeOlderWeekConfirm') }}
        </NPopconfirm>
        <NPopconfirm :disabled="purging" @positive-click="purgeClosedRecords('24h')">
          <template #trigger>
            <NButton size="small" type="error" ghost :loading="purging" :disabled="purging">
              {{ t('dashboard.purgeOlderDay') }}
            </NButton>
          </template>
          {{ t('dashboard.purgeOlderDayConfirm') }}
        </NPopconfirm>
        <NPopconfirm :disabled="purging" @positive-click="purgeClosedRecords('all')">
          <template #trigger>
            <NButton size="small" type="error" :loading="purging" :disabled="purging">
              {{ t('dashboard.purgeAll') }}
            </NButton>
          </template>
          {{ t('dashboard.purgeAllConfirm') }}
        </NPopconfirm>
      </NSpace>
    </div>
    <NEmpty
      v-if="sessionsStore.closedSessions.length === 0"
      :description="t('dashboard.noRecords')"
      style="margin: 32px 0"
    />
    <div class="grid">
      <NCard v-for="s in sessionsStore.closedSessions" :key="s.id" size="small" class="session-card closed">
        <template #header>
          <span class="card-title">
            <span class="session-card-avatar">{{ initialsOf(s.profileName) }}</span>
            {{ s.profileName }}
          </span>
        </template>
        <template #header-extra>
          <NTag size="small" round>{{ t('dashboard.disconnected') }}</NTag>
        </template>
        <div class="meta mono">{{ s.target }}</div>
        <div class="meta-row">
          <span>ID</span>
          <span
            class="id-chip"
            :title="t('dashboard.copy')"
            @click.stop="copySessionId(s.id)"
          >{{ s.id }}</span>
          <span>{{ t('dashboard.startedAt') }} {{ formatStartedAt(s.createdAt) }}</span>
          <span>{{ t('dashboard.duration') }} {{ uptime(s) }}</span>
          <span v-if="s.closeReason">· {{ s.closeReason }}</span>
        </div>
        <template #action>
          <NSpace justify="end">
            <NButton size="tiny" @click="router.push(`/sessions/${s.id}/history`)">{{ t('common.history') }}</NButton>
            <NPopconfirm v-if="canDeleteRecords" @positive-click="deleteSessionRecord(s.id)">
              <template #trigger>
                <NButton size="tiny" type="error" ghost>{{ t('common.delete') }}</NButton>
              </template>
              {{ t('dashboard.deleteConfirm') }}
            </NPopconfirm>
          </NSpace>
        </template>
      </NCard>
    </div>

    <NModal
      v-model:show="showCreate"
      preset="dialog"
      :title="t('dashboard.newSession')"
      :positive-text="t('common.create')"
      :negative-text="t('common.cancel')"
      :loading="creating"
      @positive-click="createSession"
    >
      <NSelect
        v-model:value="selectedProfile"
        :options="profileOptions"
        filterable
        clearable
        :placeholder="t('dashboard.profileSearch')"
        style="margin-top: 12px"
      />
    </NModal>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.session-card {
  cursor: pointer;
}
.session-card.active {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
}
.session-card.closed {
  cursor: default;
  opacity: 0.72;
}
.card-title {
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.meta {
  font-size: 12.5px;
  color: var(--text-muted);
  margin-top: 4px;
}
.meta.mono {
  font-family: var(--font-mono);
}
.meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 8px;
}
</style>
