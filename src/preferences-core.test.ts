import { describe, expect, it } from 'vitest'
import {
  is_supported_language,
  language_configuration_target,
  resolve_color_scheme,
  resolve_language,
  resolve_motion,
} from './preferences-core'

describe('preference resolution', () => {
  it('accepts only the built-in language IDs from webview messages', () => {
    expect(is_supported_language('zh-CN')).toBe(true)
    expect(is_supported_language('en')).toBe(true)
    expect(is_supported_language('auto')).toBe(false)
    expect(is_supported_language('../pack')).toBe(false)
  })

  it('updates the effective configuration layer instead of hiding behind a workspace override', () => {
    expect(language_configuration_target(undefined)).toBe('global')
    expect(language_configuration_target({ workspaceValue: 'auto' })).toBe('workspace')
  })

  it('resolves auto language from VS Code and falls back to English', () => {
    expect(resolve_language('auto', 'zh-cn')).toBe('zh-CN')
    expect(resolve_language('auto', 'zh-Hans')).toBe('zh-CN')
    expect(resolve_language('auto', 'fr')).toBe('en')
    expect(resolve_language('zh-CN', 'en')).toBe('zh-CN')
  })

  it('resolves automatic and explicit color schemes', () => {
    expect(resolve_color_scheme('auto', 'high-contrast')).toBe('high-contrast')
    expect(resolve_color_scheme('auto', 'high-contrast-light')).toBe('high-contrast-light')
    expect(resolve_color_scheme('dark', 'light')).toBe('dark')
  })

  it('leaves automatic motion for the webview media query', () => {
    expect(resolve_motion('auto')).toBe('auto')
    expect(resolve_motion('reduced')).toBe('reduced')
  })
})
