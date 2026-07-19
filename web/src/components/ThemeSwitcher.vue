<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTheme } from '../theme/useTheme'
import type { ThemeId } from '../theme/themes'

const { locale } = useI18n()
const { themes, themeId, theme, setTheme } = useTheme()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)

function toggle() {
  open.value = !open.value
}

function pick(id: ThemeId) {
  setTheme(id)
  open.value = false
}

function onDocDown(e: MouseEvent) {
  if (!open.value || !rootRef.value) return
  if (!rootRef.value.contains(e.target as Node)) open.value = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onDocDown)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="rootRef" class="popover-anchor">
    <button type="button" class="theme-trigger" @click="toggle">
      <span class="swatch" :style="{ background: theme.swatches[0] }" />
      {{ locale === 'zh-CN' ? theme.name : theme.nameEn }}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
    <div v-if="open" class="theme-popover">
      <div class="theme-menu-title">{{ $t('app.colorScheme') }}</div>
      <button
        v-for="t in themes"
        :key="t.id"
        type="button"
        class="theme-option"
        :class="{ active: t.id === themeId }"
        @click="pick(t.id)"
      >
        <span class="swatch-group">
          <span v-for="(c, i) in t.swatches" :key="i" :style="{ background: c }" />
        </span>
        <span class="name">{{ locale === 'zh-CN' ? t.name : t.nameEn }}</span>
        <span class="mode-badge">{{ t.mode === 'dark' ? $t('app.dark') : $t('app.light') }}</span>
        <svg v-if="t.id === themeId" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 13l4 4L19 7" />
        </svg>
      </button>
    </div>
  </div>
</template>
