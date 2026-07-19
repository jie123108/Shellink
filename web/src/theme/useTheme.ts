import { computed, ref, watch } from 'vue'
import {
  DEFAULT_THEME_ID,
  THEME_STORAGE_KEY,
  THEMES,
  buildNaiveOverrides,
  getTheme,
  isThemeId,
  type ThemeId,
  type ThemeDefinition,
} from './themes'

function readStoredTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    if (isThemeId(raw)) return raw
  } catch {
    /* privacy mode */
  }
  return DEFAULT_THEME_ID
}

function applyThemeAttr(id: ThemeId): void {
  document.documentElement.setAttribute('data-theme', id)
}

const themeId = ref<ThemeId>(readStoredTheme())
applyThemeAttr(themeId.value)

watch(themeId, (id) => {
  applyThemeAttr(id)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id)
  } catch {
    /* privacy mode */
  }
})

export function useTheme() {
  const theme = computed<ThemeDefinition>(() => getTheme(themeId.value))
  const themeOverrides = computed(() => buildNaiveOverrides(theme.value))
  const isDark = computed(() => theme.value.mode === 'dark')

  function setTheme(id: ThemeId) {
    if (!isThemeId(id)) return
    themeId.value = id
  }

  return {
    themes: THEMES,
    themeId,
    theme,
    themeOverrides,
    isDark,
    setTheme,
  }
}

/** Apply stored theme before Vue mounts to avoid a flash of wrong colors. */
export function initThemeEarly(): void {
  applyThemeAttr(readStoredTheme())
}
