import { describe, expect, it } from 'vitest'
import {
  brand_html_attributes,
  escape_html_attribute,
  panel_content_security_policy,
  panel_script_type_attribute,
  preference_html_attributes,
  workspace_asset_html_attribute,
  WORKSPACE_ASSET_BROKER_BASE
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

  it('allows only the webview origin and blob workers for Monaco', () => {
    const policy = panel_content_security_policy('abc123', 'vscode-webview://unit');
    expect(policy).toContain("script-src 'nonce-abc123' vscode-webview://unit");
    expect(policy).toContain('worker-src vscode-webview://unit blob:');
    expect(policy).not.toContain('unsafe-eval');
  });

  it('loads only the chunked Create Entry bundle as a module', () => {
    expect(panel_script_type_attribute('createEntry')).toBe(' type="module"');
    expect(panel_script_type_attribute('main')).toBe('');
  });

  it('emits escaped shared brand logo URLs for every panel', () => {
    expect(brand_html_attributes('webview://black?a=1&b=2', 'webview://white')).toBe(
      'data-snl-logo-black="webview://black?a=1&amp;b=2" data-snl-logo-white="webview://white"'
    )
  })

  it('bootstraps the safe broker placeholder used by legacy Markdown images', () => {
    expect(WORKSPACE_ASSET_BROKER_BASE).toContain('#snl-workspace-asset')
    expect(WORKSPACE_ASSET_BROKER_BASE).toMatch(/^data:image\/gif;base64,/)
    expect(workspace_asset_html_attribute('vscode-webview://panel/assets?a=1&b=2')).toBe(
      'data-snl-asset-base-uri="vscode-webview://panel/assets?a=1&amp;b=2"'
    )
  })
})
