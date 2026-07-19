<script setup lang="ts">
import { computed } from 'vue'
import { i18n, setLocale, type Locale } from '../i18n'

const selected = computed({
  get: () => i18n.global.locale.value as Locale,
  set: (locale: Locale) => setLocale(locale),
})
</script>

<template>
  <div class="locale-toggle">
    <button type="button" :class="{ active: selected === 'zh-CN' }" @click="selected = 'zh-CN'">中</button>
    <button type="button" :class="{ active: selected === 'en-US' }" @click="selected = 'en-US'">EN</button>
  </div>
</template>
