<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NInput, NButton, NSpace, useMessage } from 'naive-ui'
import { setToken, clearToken, api, getSensitiveOpsAuth } from '../api'
import { useI18n } from 'vue-i18n'
import ThemeSwitcher from '../components/ThemeSwitcher.vue'
import LocaleToggle from '../components/LocaleToggle.vue'

const token = ref('')
const loading = ref(false)
const ready = ref(false)
const router = useRouter()
const route = useRoute()
const message = useMessage()
const { t } = useI18n()

function goHome() {
  router.replace((route.query.redirect as string) ?? '/')
}

onMounted(async () => {
  const auth = await getSensitiveOpsAuth()
  if (!auth.requireToken) {
    goHome()
    return
  }
  ready.value = true
})

async function login() {
  if (!token.value.trim()) {
    message.warning(t('login.required'))
    return
  }
  loading.value = true
  setToken(token.value.trim())
  try {
    await api('/sessions')
    message.success(t('login.saved'))
    goHome()
  } catch {
    clearToken()
    message.error(t('login.invalid'))
  } finally {
    loading.value = false
  }
}

function enterWithoutToken() {
  clearToken()
  goHome()
}
</script>

<template>
  <div v-if="ready" class="login-wrap">
    <div class="login-theme">
      <ThemeSwitcher />
    </div>
    <div class="login-card">
      <div class="login-brand">
        <img src="/shellink-logo.png" alt="" width="30" height="30" />
        <span class="name">{{ t('login.title') }}</span>
      </div>
      <LocaleToggle style="margin-bottom: 14px" />
      <p class="login-hint">{{ t('login.hint') }}</p>
      <NInput
        v-model:value="token"
        type="password"
        show-password-on="click"
        :placeholder="t('login.tokenPlaceholder')"
        @keyup.enter="login"
      />
      <NSpace vertical style="margin-top: 16px" :size="10">
        <NButton type="primary" block :loading="loading" @click="login">
          {{ t('login.submit') }}
        </NButton>
        <NButton block quaternary @click="enterWithoutToken">{{ t('login.skip') }}</NButton>
      </NSpace>
    </div>
  </div>
</template>

<style scoped>
.login-theme {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 10;
}
</style>
