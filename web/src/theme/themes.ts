import type { GlobalThemeOverrides } from 'naive-ui'

export type ThemeId =
  | 'current'
  | 'gray'
  | 'slate-indigo'
  | 'nord'
  | 'github-dark'
  | 'dracula'

export type ThemeMode = 'light' | 'dark'

export interface ThemeDefinition {
  id: ThemeId
  name: string
  nameEn: string
  mode: ThemeMode
  swatches: [string, string, string]
  /** Key colors used to build Naive UI themeOverrides. */
  colors: {
    accent: string
    accentStrong: string
    accentSoft: string
    accentContrast: string
    text: string
    textSoft: string
    textMuted: string
    pageBg: string
    surface: string
    surfaceMuted: string
    surfaceHover: string
    line: string
    lineStrong: string
    success: string
    warning: string
    danger: string
    info: string
    sidebarActiveBg: string
    sidebarActiveText: string
    sidebarAccent: string
  }
}

export const THEMES: ThemeDefinition[] = [
  {
    id: 'current',
    name: '翡翠 Emerald',
    nameEn: 'Emerald',
    mode: 'light',
    swatches: ['#0f9f8c', '#f5f9f8', '#0d1b18'],
    colors: {
      accent: '#0f9f8c',
      accentStrong: '#087f71',
      accentSoft: '#e6f7f3',
      accentContrast: '#ffffff',
      text: '#16232a',
      textSoft: '#3f5158',
      textMuted: '#71818a',
      pageBg: '#f5f9f8',
      surface: '#ffffff',
      surfaceMuted: '#f0fdfa',
      surfaceHover: '#ecfdf5',
      line: '#dce8e5',
      lineStrong: '#c2d6d1',
      success: '#0f9f8c',
      warning: '#b7791f',
      danger: '#d14343',
      info: '#3b82c4',
      sidebarActiveBg: 'rgba(15, 159, 140, 0.14)',
      sidebarActiveText: '#087f71',
      sidebarAccent: '#0f9f8c',
    },
  },
  {
    id: 'gray',
    name: '石墨 Graphite',
    nameEn: 'Graphite',
    mode: 'light',
    swatches: ['#3f4653', '#f6f6f7', '#14161a'],
    colors: {
      accent: '#3f4653',
      accentStrong: '#262b34',
      accentSoft: '#eceef1',
      accentContrast: '#ffffff',
      text: '#1b1d21',
      textSoft: '#4a4f58',
      textMuted: '#80858e',
      pageBg: '#f6f6f7',
      surface: '#ffffff',
      surfaceMuted: '#f1f2f3',
      surfaceHover: '#ececee',
      line: '#e2e3e5',
      lineStrong: '#cbccd0',
      success: '#2f8f5b',
      warning: '#a5720f',
      danger: '#c0392f',
      info: '#4a72a8',
      sidebarActiveBg: 'rgba(63, 70, 83, 0.1)',
      sidebarActiveText: '#262b34',
      sidebarAccent: '#3f4653',
    },
  },
  {
    id: 'slate-indigo',
    name: 'Slate 板岩 + Indigo',
    nameEn: 'Slate + Indigo',
    mode: 'light',
    swatches: ['#6366f1', '#f8f9fc', '#0b1020'],
    colors: {
      accent: '#6366f1',
      accentStrong: '#4f46e5',
      accentSoft: '#eef0ff',
      accentContrast: '#ffffff',
      text: '#0f172a',
      textSoft: '#47516b',
      textMuted: '#8992ab',
      pageBg: '#f8f9fc',
      surface: '#ffffff',
      surfaceMuted: '#f2f3f8',
      surfaceHover: '#eef0fa',
      line: '#e6e8f0',
      lineStrong: '#d6d9e6',
      success: '#16a34a',
      warning: '#d97706',
      danger: '#e11d48',
      info: '#3b82f6',
      sidebarActiveBg: 'rgba(99, 102, 241, 0.12)',
      sidebarActiveText: '#4f46e5',
      sidebarAccent: '#6366f1',
    },
  },
  {
    id: 'nord',
    name: 'Nord 北欧',
    nameEn: 'Nord',
    mode: 'dark',
    swatches: ['#88c0d0', '#2e3440', '#1e222a'],
    colors: {
      accent: '#88c0d0',
      accentStrong: '#8fbcbb',
      accentSoft: 'rgba(136, 192, 208, 0.14)',
      accentContrast: '#2e3440',
      text: '#eceff4',
      textSoft: '#d8dee9',
      textMuted: '#9aa5b7',
      pageBg: '#242933',
      surface: '#2e3440',
      surfaceMuted: '#3b4252',
      surfaceHover: '#3b4252',
      line: '#3b4252',
      lineStrong: '#4c566a',
      success: '#a3be8c',
      warning: '#ebcb8b',
      danger: '#bf616a',
      info: '#81a1c1',
      sidebarActiveBg: 'rgba(136, 192, 208, 0.16)',
      sidebarActiveText: '#88c0d0',
      sidebarAccent: '#88c0d0',
    },
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark Dimmed',
    nameEn: 'GitHub Dark Dimmed',
    mode: 'dark',
    swatches: ['#539bf5', '#22272e', '#161b22'],
    colors: {
      accent: '#539bf5',
      accentStrong: '#6cb6ff',
      accentSoft: 'rgba(83, 155, 245, 0.14)',
      accentContrast: '#0d1117',
      text: '#cdd9e5',
      textSoft: '#adbac7',
      textMuted: '#768390',
      pageBg: '#1c2128',
      surface: '#22272e',
      surfaceMuted: '#2d333b',
      surfaceHover: '#2d333b',
      line: '#444c56',
      lineStrong: '#545d68',
      success: '#57ab5a',
      warning: '#c69026',
      danger: '#e5534b',
      info: '#539bf5',
      sidebarActiveBg: 'rgba(83, 155, 245, 0.16)',
      sidebarActiveText: '#6cb6ff',
      sidebarAccent: '#539bf5',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    nameEn: 'Dracula',
    mode: 'dark',
    swatches: ['#bd93f9', '#282a36', '#1e1f2e'],
    colors: {
      accent: '#bd93f9',
      accentStrong: '#ff79c6',
      accentSoft: 'rgba(189, 147, 249, 0.16)',
      accentContrast: '#1e1f29',
      text: '#f8f8f2',
      textSoft: '#d6d6e6',
      textMuted: '#8890b5',
      pageBg: '#24263a',
      surface: '#282a36',
      surfaceMuted: '#343746',
      surfaceHover: '#343746',
      line: '#3d3f52',
      lineStrong: '#4d4f66',
      success: '#50fa7b',
      warning: '#ffb86c',
      danger: '#ff5555',
      info: '#8be9fd',
      sidebarActiveBg: 'rgba(189, 147, 249, 0.2)',
      sidebarActiveText: '#d6b3ff',
      sidebarAccent: '#ff79c6',
    },
  },
]

export const DEFAULT_THEME_ID: ThemeId = 'current'
export const THEME_STORAGE_KEY = 'shellink_theme'

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return THEMES.some((t) => t.id === value)
}

export function getTheme(id: ThemeId): ThemeDefinition {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!
}

export function buildNaiveOverrides(theme: ThemeDefinition): GlobalThemeOverrides {
  const c = theme.colors
  return {
    common: {
      primaryColor: c.accent,
      primaryColorHover: c.accentStrong,
      primaryColorPressed: c.accentStrong,
      primaryColorSuppl: c.accentSoft,
      infoColor: c.info,
      successColor: c.success,
      warningColor: c.warning,
      errorColor: c.danger,
      textColorBase: c.text,
      textColor1: c.text,
      textColor2: c.textSoft,
      textColor3: c.textMuted,
      bodyColor: c.pageBg,
      cardColor: c.surface,
      modalColor: c.surface,
      popoverColor: c.surface,
      tableColor: c.surface,
      borderColor: c.line,
      dividerColor: c.line,
      hoverColor: c.surfaceHover,
      borderRadius: '7px',
      borderRadiusSmall: '4px',
      fontFamily: 'var(--font-ui)',
      fontFamilyMono: 'var(--font-mono)',
    },
    Menu: {
      itemColorActive: c.sidebarActiveBg,
      itemColorActiveHover: c.sidebarActiveBg,
      itemTextColorActive: c.sidebarActiveText,
      itemTextColorHover: c.sidebarActiveText,
      itemIconColorActive: c.sidebarAccent,
      borderRadius: '7px',
    },
    Card: {
      borderColor: c.line,
      borderRadius: '10px',
      boxShadow: '0 1px 2px rgba(15, 23, 30, 0.06)',
      borderColorModal: c.lineStrong,
      color: c.surface,
      colorModal: c.surface,
    },
    Button: {
      borderRadiusMedium: '7px',
      borderRadiusSmall: '4px',
      fontWeight: '600',
    },
    DataTable: {
      borderColor: c.line,
      thColor: c.surfaceMuted,
      tdColor: c.surface,
      tdColorHover: c.surfaceHover,
    },
    Input: {
      borderHover: c.accent,
      borderFocus: c.accent,
      boxShadowFocus: `0 0 0 3px ${c.accentSoft}`,
    },
    Select: {
      peers: {
        InternalSelection: {
          borderHover: c.accent,
          borderFocus: c.accent,
          boxShadowFocus: `0 0 0 3px ${c.accentSoft}`,
        },
      },
    },
    Tag: {
      borderRadius: '999px',
    },
  }
}
