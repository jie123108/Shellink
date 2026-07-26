import { describe, expect, it } from 'vitest'
import { formatHelp } from '../src/help.js'
import { resolveCliLocale } from '../src/i18n.js'

describe('CLI localization', () => {
  it('prefers LC_ALL, then LC_MESSAGES, then LANG', () => {
    expect(resolveCliLocale({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh-CN')
    expect(resolveCliLocale({ LC_MESSAGES: 'zh-CN', LANG: 'en_US.UTF-8' })).toBe('zh-CN')
    expect(resolveCliLocale({ LANG: 'C' })).toBe('en-US')
  })

  it('localizes help descriptions without changing command syntax', () => {
    expect(formatHelp('profile', 'en-US', '0.1.0')).toContain('List or search profiles')
    expect(formatHelp('profile', 'zh-CN', '0.1.0')).toContain('列出或搜索配置')
    expect(formatHelp('profile', 'en-US', '0.1.0')).toContain('create --input <FILE|->')
    expect(formatHelp('upgrade', 'en-US', '0.1.0')).toContain('shellink upgrade')
    expect(formatHelp('upgrade', 'zh-CN', '0.1.0')).toContain('--check')
    expect(formatHelp('root', 'en-US', '0.1.0')).toContain('upgrade')
  })
})
