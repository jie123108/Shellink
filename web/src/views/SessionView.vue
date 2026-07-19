<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NTabs, NTab, NModal, NSelect, useMessage } from 'naive-ui'
import { api, type SessionSummary, type Profile } from '../api'
import { useTabsStore } from '../stores/tabs'
import { useSessionsStore } from '../stores/sessions'
import SessionTerminal from '../components/SessionTerminal.vue'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const tabsStore = useTabsStore()
const sessionsStore = useSessionsStore()
const { t } = useI18n()

const showCreate = ref(false)
const creating = ref(false)
const selectedProfile = ref<string | null>(null)
const profiles = ref<Profile[]>([])

const STATE_DOT: Record<string, string> = {
  CONNECTING: 'var(--warning)',
  OUTPUTTING: 'var(--info)',
  IDLE: 'var(--warning)',
  WAITING_INPUT: 'var(--success)',
  DISCONNECTED: 'var(--text-muted)',
}

const profileOptions = computed(() =>
  profiles.value.map((p) => {
    const target =
      p.connectType === 'command' ? (p.command ?? 'command') : `${p.username}@${p.host}`
    return { label: `${p.name} (${target})`, value: p.id }
  }),
)

function tabState(id: string): string {
  return sessionsStore.stateOf(id) ?? 'WAITING_INPUT'
}

function stateColor(id: string): string {
  return STATE_DOT[tabState(id)] ?? STATE_DOT.WAITING_INPUT!
}

async function resolveTitle(id: string) {
  try {
    const sessions = await api<SessionSummary[]>('/sessions')
    const s = sessions.find((x) => x.id === id)
    if (s) tabsStore.setTitle(id, s.profileName)
  } catch {
    /* A title lookup failure must not prevent use of the workspace. */
  }
}

watch(
  () => route.params.id,
  (id) => {
    if (typeof id !== 'string' || !id) return
    const known = tabsStore.tabs.some((tab) => tab.id === id)
    tabsStore.open(id)
    if (!known) resolveTitle(id)
    void sessionsStore.init()
  },
  { immediate: true },
)

function onSwitch(id: string | number) {
  const sid = String(id)
  tabsStore.activeId = sid
  router.replace(`/sessions/${sid}`)
}

function onClose(id: string | number) {
  const nextId = tabsStore.close(String(id))
  if (nextId) {
    router.replace(`/sessions/${nextId}`)
  } else {
    router.push('/')
  }
}

async function openCreate() {
  showCreate.value = true
  if (profiles.value.length === 0) {
    profiles.value = await api<Profile[]>('/profiles')
  }
}

async function createSession() {
  if (!selectedProfile.value) return
  creating.value = true
  try {
    const res = await api<{ id: string }>('/sessions', {
      method: 'POST',
      body: { profileId: selectedProfile.value },
    })
    const profile = profiles.value.find((p) => p.id === selectedProfile.value)
    tabsStore.open(res.id, profile?.name)
    showCreate.value = false
    await sessionsStore.refresh()
    router.replace(`/sessions/${res.id}`)
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="workspace">
    <div class="tabbar">
      <button type="button" class="back-btn" :title="t('common.back')" @click="router.push('/')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5" />
          <path d="M11 18l-6-6 6-6" />
        </svg>
      </button>
      <NTabs
        type="card"
        size="small"
        closable
        addable
        :value="tabsStore.activeId"
        class="tabs"
        @update:value="onSwitch"
        @close="onClose"
        @add="openCreate"
      >
        <NTab v-for="tab in tabsStore.tabs" :key="tab.id" :name="tab.id">
          <span class="session-tab-label">
            <span class="state-dot" :style="{ background: stateColor(tab.id) }" />
            <span class="label">{{ tab.title }}</span>
          </span>
        </NTab>
      </NTabs>
    </div>

    <div class="panes">
      <SessionTerminal
        v-for="tab in tabsStore.tabs"
        v-show="tab.id === tabsStore.activeId"
        :key="tab.id"
        :session-id="tab.id"
        :active="tab.id === tabsStore.activeId"
      />
    </div>

    <NModal
      v-model:show="showCreate"
      preset="dialog"
      :title="t('session.newSession')"
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
        :placeholder="t('session.profileSearch')"
        style="margin-top: 12px"
      />
    </NModal>
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--terminal-bg);
}
.tabbar {
  display: flex;
  align-items: stretch;
  gap: 0;
  background: var(--terminal-panel);
  border-bottom: 1px solid var(--terminal-line);
  padding: 0 8px;
  flex-shrink: 0;
  height: 42px;
  position: relative;
}
.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  color: var(--terminal-fg);
  opacity: 0.7;
  background: none;
  border: none;
  cursor: pointer;
  flex-shrink: 0;
}
.back-btn:hover { opacity: 1; }
.tabs {
  flex: 1;
  min-width: 0;
}
.tabs :deep(.n-tabs-nav) {
  --n-tab-gap: 2px;
  height: 42px;
  padding-top: 5px;
  box-sizing: border-box;
  border-bottom: none !important;
}
.tabs :deep(.n-tabs-tab) {
  background: transparent !important;
  border-color: transparent !important;
  color: var(--text-muted) !important;
  border-radius: var(--radius-md) var(--radius-md) 0 0 !important;
  height: 32px;
  max-width: 200px;
}
.tabs :deep(.n-tabs-tab--active) {
  background: var(--terminal-bg) !important;
  color: var(--terminal-fg) !important;
  border-color: var(--terminal-line) !important;
  font-weight: 600;
}
.tabs :deep(.n-tabs-tab__close) {
  color: var(--terminal-fg);
}
.session-tab-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 160px;
}
.session-tab-label .state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.session-tab-label .label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panes {
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
