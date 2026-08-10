import { describe, expect, it } from 'vitest';
import {
  apply_preferences_snapshot,
  create_content_language_store,
  create_webview_reader_runtime,
  get_content_language,
  get_formatter_preferences,
  get_kind_color_scheme,
  get_popover_preferences,
  get_supported_languages,
  set_content_language
} from './preferencesRuntime';

describe('webview preference Reader runtime', () => {
  it('uses panel-scoped content language independently from the global UI language', () => {
    expect(get_supported_languages()).toEqual([]);
    document.documentElement.lang = 'en';
    set_content_language('zh-CN');
    const runtime = create_webview_reader_runtime(document.documentElement);
    const language = ({ language }: { language: string }): string => language;
    expect(runtime.run_reader(language)).toBe('zh-CN');
    document.documentElement.lang = 'en';
    expect(runtime.run_reader(language)).toBe('zh-CN');
    set_content_language('fr');
    expect(runtime.run_reader(language)).toBe('fr');
    expect(get_content_language()).toBe('fr');
  });

  it('keeps content-language stores isolated between panels', () => {
    const left = create_content_language_store('en');
    const right = create_content_language_store('en');
    left.set('zh-CN');
    expect(left.get()).toBe('zh-CN');
    expect(right.get()).toBe('en');
  });

  it('applies only newer snapshots and updates document attributes', () => {
    expect(apply_preferences_snapshot({
      type: 'snl.preferences/snapshot',
      generation: 'host-a',
      revision: 2,
      preferences: {
        language: 'zh-CN',
        language_preference: 'auto',
        color_scheme: 'dark',
        motion: 'reduced',
        formatter_indent_spaces: 8,
        formatter_inline_parenthesis_depth: 2,
        popover_hover_enabled: false
      }
    })).toBe(true);
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.documentElement.dataset.snlLanguagePreference).toBe('auto');
    expect(document.documentElement.dataset.snlMotion).toBe('reduced');
    expect(get_kind_color_scheme()).toBe('dark');
    expect(get_formatter_preferences()).toEqual({
      indentSpaces: 8,
      inlineParenthesisDepth: 2
    });
    expect(get_popover_preferences()).toEqual({ hoverEnabled: false });
    expect(apply_preferences_snapshot({
      type: 'snl.preferences/snapshot',
      generation: 'host-a',
      revision: 1,
      preferences: { language: 'en', color_scheme: 'light', motion: 'full' }
    })).toBe(false);
    expect(document.documentElement.lang).toBe('zh-CN');

    expect(apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'host-a', revision: Number.POSITIVE_INFINITY,
      preferences: { language: 'en', color_scheme: 'light', motion: 'full' }
    })).toBe(false);
    expect(apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'host-a', revision: Number.NaN,
      preferences: { language: 'en', color_scheme: 'light', motion: 'full' }
    })).toBe(false);

    expect(apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'host-b', revision: 0,
      preferences: { language: 'en', color_scheme: 'light', motion: 'full' }
    })).toBe(true);
    expect(document.documentElement.lang).toBe('en');
  });

  it('maps VS Code high-contrast themes onto the two Kind palette variants', () => {
    document.documentElement.dataset.snlColorScheme = 'high-contrast-light';
    expect(get_kind_color_scheme()).toBe('light');
    document.documentElement.dataset.snlColorScheme = 'high-contrast';
    expect(get_kind_color_scheme()).toBe('dark');
  });

  it('publishes the repo authoring-language catalog from host snapshots', () => {
    expect(apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'language-host', revision: 1,
      preferences: { language: 'en', color_scheme: 'dark', motion: 'full' },
      supported_languages: [
        { id: 'zh-CN', display_name: '简体中文（中国大陆）' },
        { id: 'en', display_name: 'English (US)' },
        { id: 'fr', display_name: 'Français' }
      ]
    })).toBe(true);
    expect(get_supported_languages()).toEqual([
      { id: 'zh-CN', display_name: '简体中文（中国大陆）' },
      { id: 'en', display_name: 'English (US)' },
      { id: 'fr', display_name: 'Français' }
    ]);
  });
});
