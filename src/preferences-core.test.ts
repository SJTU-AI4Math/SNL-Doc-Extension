import { describe, expect, it } from 'vitest'
import {
  is_supported_language,
  language_configuration_target,
  resolve_color_scheme,
  resolve_language,
  resolve_motion,
  resolve_formatter_indent_spaces,
  resolve_formatter_inline_parenthesis_depth,
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

  it('accepts only formatter integers within the SNL-Basics constructor bounds', () => {
    expect(resolve_formatter_indent_spaces(8)).toBe(8)
    expect(resolve_formatter_indent_spaces(0)).toBe(0)
    expect(resolve_formatter_indent_spaces(256)).toBe(256)
    expect(resolve_formatter_indent_spaces(-1)).toBe(4)
    expect(resolve_formatter_indent_spaces(257)).toBe(4)
    expect(resolve_formatter_indent_spaces(2.5)).toBe(4)
    expect(resolve_formatter_inline_parenthesis_depth(0)).toBe(0)
    expect(resolve_formatter_inline_parenthesis_depth(12)).toBe(12)
    expect(resolve_formatter_inline_parenthesis_depth(-1)).toBe(3)
    expect(resolve_formatter_inline_parenthesis_depth(Number.MAX_SAFE_INTEGER + 1)).toBe(3)
  })
})
