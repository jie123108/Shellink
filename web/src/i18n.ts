import { createI18n } from 'vue-i18n'

export const locales = ['zh-CN', 'en-US'] as const
export type Locale = (typeof locales)[number]

const STORAGE_KEY = 'shellink_locale'

export function resolveLocale(
  stored: string | null = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY),
  languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages,
): Locale {
  if (locales.includes(stored as Locale)) return stored as Locale
  return languages.some((language) => language.toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en-US'
}

const messages = {
  'zh-CN': {
    app: {
      dashboard: '会话仪表盘', profiles: '连接配置', webhookMessages: 'Webhook 消息', tokenSet: '已设置 Token', tokenUnset: '未设置 Token',
      clearToken: '清除 Token', setToken: '设置 / 清除', language: '语言',
      brandTag: '控制台', navigate: '导航', activeSessions: '活跃会话',
      colorScheme: '配色方案', light: '浅色', dark: '深色',
      dashSub: '管理正在运行与近期结束的 SSH / 命令会话',
      profilesSub: '管理 SSH 与自定义命令的连接配置',
    },
    common: {
      create: '创建', cancel: '取消', save: '保存', delete: '删除', edit: '编辑', close: '关闭',
      refresh: '刷新', history: '历史', download: '下载', upload: '上传', back: '返回', actions: '操作',
      name: '名称', target: '目标', command: '命令', host: '主机', port: '端口', username: '用户名',
      password: '密码', privateKey: '私钥', passphrase: '私钥口令', authentication: '认证方式',
      connectionType: '连接类型', terminalType: '终端类型', columnsRows: '列 x 行',
    },
    login: {
      title: 'Shellink 控制台', hint: '可设置 Token 登录（支持删除会话等管理操作），也可不设置 Token 直接使用（本机访问通常可免鉴权）。',
      tokenPlaceholder: '访问令牌 (SHELLINK_TOKEN)', submit: '设置 Token 并进入', skip: '不使用 Token 进入',
      required: '请输入 Token', saved: '已保存 Token', invalid: 'Token 无效',
    },
    dashboard: {
      title: '会话仪表盘', newSession: '新建会话', activeSessions: '活跃会话', noActive: '暂无活跃会话',
      recentSessions: '最近结束的会话', noRecords: '暂无记录', active: '活动', disconnected: '已断开',
      copy: '点击复制', mode: '模式', alive: '存活', duration: '持续', startedAt: '开始',
      closeConfirm: '确认关闭该会话？',
      deleteConfirm: '将关闭并彻底删除该会话及历史记录，确认？', profileSearch: '输入关键词筛选连接配置',
      deleteNeedsToken: '删除会话需要先设置 Token', deleted: '会话已删除', copied: '已复制会话 ID：{id}',
      copyFailed: '复制失败，请手动选择',
      purgeOlderWeek: '删除一周前', purgeOlderDay: '删除 24 小时前', purgeAll: '删除全部',
      purgeOlderWeekConfirm: '将永久删除一周前结束的会话及历史（不影响活跃会话），确认？',
      purgeOlderDayConfirm: '将永久删除 24 小时前结束的会话及历史（不影响活跃会话），确认？',
      purgeAllConfirm: '将永久删除全部已结束会话及历史（不影响活跃会话），确认？',
      purged: '已删除 {count} 条会话记录',
    },
    profiles: {
      title: '连接配置', newProfile: '新建配置', editProfile: '编辑配置', filter: '关键词过滤（名称 / 目标 / 唯一 ID）',
      namePlaceholder: '如：迅雷跳板机-a019177', commandPlaceholder: '如：expect ~/.ssh/remote/jump-script host01',
      uniqueId: '唯一 ID', uniqueIdPlaceholder: '可选：主机名、IP，或外部系统 Guid',
      ssh: 'SSH 直连', commandType: '命令 (expect 脚本等)', command: '命令', key: '私钥',
      newSession: '新建会话', deleteConfirm: '确认删除该配置？',
      unchanged: '留空表示不修改', promptRegex: 'Prompt 正则', promptPlaceholder: '留空使用内置规则 [$#>%]\\s*$',
      updated: '已更新',
      created: '已创建', deleted: '已删除',
    },
    session: {
      newSession: '新建会话', profileSearch: '输入关键词筛选连接配置', monitoringDisconnected: '监控连接断开',
      manualControl: '手动接管', closeSession: '关闭会话', closeConfirm: '确认关闭该会话？',
      downloadTitle: '从远端下载', uploadTitle: '上传到远端', remotePath: '远程路径', remoteTargetPath: '远程目标路径',
      localFile: '本机文件', dropFile: '点击或拖拽文件到此处', closed: '会话已关闭',
      downloadRequired: '请输入远程路径', uploadPathRequired: '请输入远程目标路径', uploadFileRequired: '请选择要上传的文件',
      downloaded: '已下载 {filename}（{size} 字节）', uploaded: '已上传到 {path}（{size} 字节）',
      closedTerminal: '[会话已断开: {reason}]',
    },
    history: { title: '会话历史审查', empty: '（暂无输出记录）' },
    webhookMessages: {
      title: 'Webhook 消息', callbackUrl: '回调地址', empty: '暂未收到 Webhook 消息',
      receivedAt: '接收时间', copied: '回调地址已复制', copyFailed: '复制失败', clear: '清空',
      clearConfirm: '确认清空当前内存中的 Webhook 消息？', cleared: '已清空',
    },
    api: { unauthorized: '未授权', requestFailed: '请求失败 ({status})' },
  },
  'en-US': {
    app: {
      dashboard: 'Dashboard', profiles: 'Profiles', webhookMessages: 'Webhook Messages', tokenSet: 'Token set', tokenUnset: 'No token',
      clearToken: 'Clear token', setToken: 'Set / clear', language: 'Language',
      brandTag: 'Console', navigate: 'Navigate', activeSessions: 'Active sessions',
      colorScheme: 'Color scheme', light: 'light', dark: 'dark',
      dashSub: 'Manage running and recently closed SSH / command sessions',
      profilesSub: 'Manage SSH and custom-command connection profiles',
    },
    common: {
      create: 'Create', cancel: 'Cancel', save: 'Save', delete: 'Delete', edit: 'Edit', close: 'Close',
      refresh: 'Refresh', history: 'History', download: 'Download', upload: 'Upload', back: 'Back', actions: 'Actions',
      name: 'Name', target: 'Target', command: 'Command', host: 'Host', port: 'Port', username: 'Username',
      password: 'Password', privateKey: 'Private key', passphrase: 'Passphrase', authentication: 'Authentication',
      connectionType: 'Connection type', terminalType: 'Terminal type', columnsRows: 'Columns x rows',
    },
    login: {
      title: 'Shellink Console', hint: 'Set a token for administrative actions such as deleting sessions, or continue without one. Local access usually does not require authentication.',
      tokenPlaceholder: 'Access token (SHELLINK_TOKEN)', submit: 'Set token and continue', skip: 'Continue without token',
      required: 'Enter a token', saved: 'Token saved', invalid: 'Invalid token',
    },
    dashboard: {
      title: 'Session Dashboard', newSession: 'New session', activeSessions: 'Active sessions', noActive: 'No active sessions',
      recentSessions: 'Recently closed sessions', noRecords: 'No records', active: 'Active', disconnected: 'Disconnected',
      copy: 'Copy', mode: 'Mode', alive: 'Uptime', duration: 'Duration', startedAt: 'Started',
      closeConfirm: 'Close this session?',
      deleteConfirm: 'Close and permanently delete this session and its history?', profileSearch: 'Filter connection profiles',
      deleteNeedsToken: 'Set a token before deleting a session', deleted: 'Session deleted', copied: 'Copied session ID: {id}',
      copyFailed: 'Copy failed. Select the ID manually.',
      purgeOlderWeek: 'Delete older than 1 week', purgeOlderDay: 'Delete older than 24h', purgeAll: 'Delete all',
      purgeOlderWeekConfirm: 'Permanently delete closed sessions older than 1 week and their history (active sessions are kept). Continue?',
      purgeOlderDayConfirm: 'Permanently delete closed sessions older than 24 hours and their history (active sessions are kept). Continue?',
      purgeAllConfirm: 'Permanently delete all closed sessions and their history (active sessions are kept). Continue?',
      purged: 'Deleted {count} session record(s)',
    },
    profiles: {
      title: 'Connection Profiles', newProfile: 'New profile', editProfile: 'Edit profile', filter: 'Filter by name, target, or unique ID',
      namePlaceholder: 'Example: bastion-a019177', commandPlaceholder: 'Example: expect ~/.ssh/remote/jump-script host01',
      uniqueId: 'Unique ID', uniqueIdPlaceholder: 'Optional: hostname, IP, or external Guid',
      ssh: 'Direct SSH', commandType: 'Command (expect script, etc.)', command: 'Command', key: 'Private key',
      newSession: 'New session', deleteConfirm: 'Delete this profile?',
      unchanged: 'Leave empty to keep the current value', promptRegex: 'Prompt regex', promptPlaceholder: 'Leave empty to use the built-in rule [$#>%]\\s*$',
      updated: 'Profile updated',
      created: 'Profile created', deleted: 'Profile deleted',
    },
    session: {
      newSession: 'New session', profileSearch: 'Filter connection profiles', monitoringDisconnected: 'Monitoring connection closed',
      manualControl: 'Manual control', closeSession: 'Close session', closeConfirm: 'Close this session?',
      downloadTitle: 'Download from remote', uploadTitle: 'Upload to remote', remotePath: 'Remote path', remoteTargetPath: 'Remote target path',
      localFile: 'Local file', dropFile: 'Click or drag a file here', closed: 'Session closed',
      downloadRequired: 'Enter a remote path', uploadPathRequired: 'Enter a remote target path', uploadFileRequired: 'Choose a file to upload',
      downloaded: 'Downloaded {filename} ({size} bytes)', uploaded: 'Uploaded to {path} ({size} bytes)',
      closedTerminal: '[Session closed: {reason}]',
    },
    history: { title: 'Session History', empty: '(No output recorded)' },
    webhookMessages: {
      title: 'Webhook Messages', callbackUrl: 'Callback URL', empty: 'No webhook messages received',
      receivedAt: 'Received', copied: 'Callback URL copied', copyFailed: 'Copy failed', clear: 'Clear',
      clearConfirm: 'Clear all webhook messages currently held in memory?', cleared: 'Cleared',
    },
    api: { unauthorized: 'Unauthorized', requestFailed: 'Request failed ({status})' },
  },
} as const

export const i18n = createI18n({
  legacy: false,
  locale: resolveLocale(),
  fallbackLocale: 'en-US',
  messages,
})

export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale
  localStorage.setItem(STORAGE_KEY, locale)
  document.documentElement.lang = locale
}

document.documentElement.lang = i18n.global.locale.value
