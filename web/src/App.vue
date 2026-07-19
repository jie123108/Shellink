<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  darkTheme,
  lightTheme,
  enUS,
  dateEnUS,
  zhCN,
  dateZhCN,
} from 'naive-ui'
import { getToken, getSensitiveOpsAuth } from './api'
import { i18n } from './i18n'
import { useI18n } from 'vue-i18n'
import { useTheme } from './theme/useTheme'
import { useSessionsStore } from './stores/sessions'
import ThemeSwitcher from './components/ThemeSwitcher.vue'
import LocaleToggle from './components/LocaleToggle.vue'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { themeOverrides, isDark } = useTheme()
const sessionsStore = useSessionsStore()

const isLogin = computed(() => route.path === '/login')
const isTerminal = computed(() => /^\/sessions\/[^/]+$/.test(route.path))
const hasToken = ref(!!getToken())
/** Show token chip / login entry only when the server requires a token. */
const showTokenEntry = ref(false)

watch(
  () => route.fullPath,
  () => {
    hasToken.value = !!getToken()
  },
)

async function leaveLoginIfTokenNotRequired() {
  if (!showTokenEntry.value && isLogin.value) {
    await router.replace((route.query.redirect as string) || '/')
  }
}

onMounted(async () => {
  const auth = await getSensitiveOpsAuth()
  showTokenEntry.value = auth.requireToken
  await leaveLoginIfTokenNotRequired()
  if (!isLogin.value) {
    void sessionsStore.init()
  }
})

watch(isLogin, (login) => {
  if (login) {
    void leaveLoginIfTokenNotRequired()
    return
  }
  void sessionsStore.init()
})

const selectedLocale = computed(() => i18n.global.locale.value)
const naiveLocale = computed(() => (selectedLocale.value === 'zh-CN' ? zhCN : enUS))
const naiveDateLocale = computed(() => (selectedLocale.value === 'zh-CN' ? dateZhCN : dateEnUS))
const naiveTheme = computed(() => (isDark.value ? darkTheme : lightTheme))

const navItems = computed(() => [
  { key: '/', label: t('app.dashboard'), icon: 'grid' as const },
  { key: '/profiles', label: t('app.profiles'), icon: 'server' as const },
  { key: '/webhook-messages', label: t('app.webhookMessages'), icon: 'webhook' as const },
])

const activeKey = computed(() => {
  if (route.path.startsWith('/sessions')) return '/'
  if (route.path.startsWith('/profiles')) return '/profiles'
  if (route.path.startsWith('/webhook-messages')) return '/webhook-messages'
  return route.path
})

const pageMeta = computed(() => {
  if (route.path.startsWith('/profiles')) {
    return { title: t('app.profiles'), subtitle: t('app.profilesSub') }
  }
  if (route.path.startsWith('/webhook-messages')) {
    return { title: t('app.webhookMessages'), subtitle: '' }
  }
  if (route.path.includes('/history')) {
    return { title: t('history.title'), subtitle: '' }
  }
  return { title: t('app.dashboard'), subtitle: t('app.dashSub') }
})

function goSetToken() {
  router.push({ path: '/login', query: { redirect: route.fullPath } })
}

function isNavActive(key: string) {
  return activeKey.value === key
}
</script>

<template>
  <NConfigProvider
    :theme="naiveTheme"
    :theme-overrides="themeOverrides"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
  >
    <NMessageProvider>
      <NDialogProvider>
        <template v-if="isLogin">
          <router-view />
        </template>
        <div v-else class="app-shell">
          <aside class="sidebar">
            <div class="sidebar-brand">
              <img src="/shellink-logo.png" alt="" width="26" height="26" />
              <span class="name">Shellink</span>
              <span class="tag">{{ t('app.brandTag') }}</span>
            </div>

            <div class="sidebar-stat">
              <div class="label">{{ t('app.activeSessions') }}</div>
              <div class="value">
                <span class="dot" />
                {{ sessionsStore.activeCount }}
              </div>
            </div>

            <div class="sidebar-section-label">{{ t('app.navigate') }}</div>
            <nav class="sidebar-nav">
              <RouterLink
                v-for="item in navItems"
                :key="item.key"
                :to="item.key"
                class="sidebar-nav-item"
                :class="{ active: isNavActive(item.key) }"
              >
                <svg v-if="item.icon === 'grid'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="3" width="7" height="9" rx="1.5" />
                  <rect x="14" y="3" width="7" height="5" rx="1.5" />
                  <rect x="14" y="12" width="7" height="9" rx="1.5" />
                  <rect x="3" y="16" width="7" height="5" rx="1.5" />
                </svg>
                <svg v-else-if="item.icon === 'server'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="4" width="18" height="7" rx="1.5" />
                  <rect x="3" y="13" width="18" height="7" rx="1.5" />
                  <circle cx="7" cy="7.5" r="0.9" fill="currentColor" stroke="none" />
                  <circle cx="7" cy="16.5" r="0.9" fill="currentColor" stroke="none" />
                </svg>
                <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 17a4 4 0 1 1 3.4-6.2" />
                  <circle cx="17" cy="7" r="2.3" />
                  <circle cx="7" cy="17" r="2.3" />
                  <circle cx="17" cy="17" r="2.3" />
                  <path d="M13.8 8.7 15.5 15.1" />
                </svg>
                <span>{{ item.label }}</span>
              </RouterLink>
            </nav>

            <div class="sidebar-spacer" />

            <div class="sidebar-footer">
              <div v-if="showTokenEntry" class="sidebar-token-row">
                <button
                  type="button"
                  class="token-chip"
                  :class="{ set: hasToken }"
                  @click="goSetToken"
                >
                  <span class="dot" />
                  <span>{{ hasToken ? t('app.tokenSet') : t('app.tokenUnset') }}</span>
                </button>
                <button type="button" class="link-btn" @click="goSetToken">{{ t('app.setToken') }}</button>
              </div>
              <LocaleToggle />
            </div>
          </aside>

          <div class="main-col">
            <template v-if="isTerminal">
              <router-view />
            </template>
            <template v-else>
              <header class="topbar">
                <div>
                  <div class="page-title">{{ pageMeta.title }}</div>
                  <div v-if="pageMeta.subtitle" class="page-desc">{{ pageMeta.subtitle }}</div>
                </div>
                <div class="topbar-spacer" />
                <div class="topbar-actions">
                  <ThemeSwitcher />
                </div>
              </header>
              <div class="content-scroll">
                <router-view />
              </div>
            </template>
          </div>
        </div>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
