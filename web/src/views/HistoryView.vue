<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NSpace, NSpin } from 'naive-ui'
import { api } from '../api'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const router = useRouter()
const sessionId = route.params.id as string
const { t } = useI18n()

const text = ref('')
const loading = ref(false)
let cursor = 0

async function load(reset = false) {
  loading.value = true
  try {
    if (reset) {
      cursor = 0
      text.value = ''
    }
    for (;;) {
      const res = await api<{ cursor: number; text: string }>(
        `/sessions/${sessionId}/history?since=${cursor}&limit=5000`,
      )
      text.value += res.text
      if (res.cursor === cursor) break
      cursor = res.cursor
    }
  } finally {
    loading.value = false
  }
}

onMounted(() => load())
</script>

<template>
  <div>
    <div class="page-header">
      <div style="display: flex; align-items: center; gap: 12px">
        <NButton size="small" quaternary @click="router.back()">
          ← {{ t('common.back') }}
        </NButton>
        <h1>{{ t('history.title') }} · {{ sessionId }}</h1>
      </div>
      <NButton size="small" :loading="loading" @click="load(true)">{{ t('common.refresh') }}</NButton>
    </div>
    <NSpin :show="loading">
      <pre class="history-block">{{ text || t('history.empty') }}</pre>
    </NSpin>
  </div>
</template>
