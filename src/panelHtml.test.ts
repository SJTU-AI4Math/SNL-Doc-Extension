import { describe, expect, it } from 'vitest'
import {
  brand_html_attributes,
  escape_html_attribute,
  preference_html_attributes
} from './panelHtml'

describe('panel HTML preference bootstrap', () => {
  it('escapes attribute values', () => {
    expect(escape_html_attribute(`a"b<&`)).toBe('a&quot;b&lt;&amp;')
  })

  it('emits locale, theme and motion attributes', () => {
    expect(preference_html_attributes({
      language: 'zh-CN',
      language_preference: 'zh-CN',
      color_scheme: 'dark',
      motion: 'reduced'
    })).toBe('lang="zh-CN" data-snl-language-preference="zh-CN" data-snl-color-scheme="dark" data-snl-motion="reduced"')
  })

  it('emits escaped shared brand logo URLs for every panel', () => {
    expect(brand_html_attributes('webview://black?a=1&b=2', 'webview://white')).toBe(
      'data-snl-logo-black="webview://black?a=1&amp;b=2" data-snl-logo-white="webview://white"'
    )
  })
})
