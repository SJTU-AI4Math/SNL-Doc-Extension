import { describe, expect, it } from 'vitest'
import {
  resolve_color_scheme,
  resolve_language,
  resolve_motion,
} from './preferences-core'

describe('preference resolution', () => {
  it('resolves auto language from VS Code and falls back to English', () => {
    expect(resolve_language('auto', 'zh-cn')).toBe('zh-CN')
    expect(resolve_language('auto', 'zh-Hans')).toBe('zh-CN')
    expect(resolve_language('auto', 'fr')).toBe('en')
    expect(resolve_language('zh-CN', 'en')).toBe('zh-CN')
  })

  it('resolves automatic and explicit color schemes', () => {
    expect(resolve_color_scheme('auto', 'high-contrast')).toBe('high-contrast')
    expect(resolve_color_scheme('dark', 'light')).toBe('dark')
  })

  it('leaves automatic motion for the webview media query', () => {
    expect(resolve_motion('auto')).toBe('auto')
    expect(resolve_motion('reduced')).toBe('reduced')
  })
})
