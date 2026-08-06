import { describe, expect, it } from 'vitest';
import {
  apply_preferences_snapshot,
  create_webview_reader_runtime
} from './preferencesRuntime';

describe('webview preference Reader runtime', () => {
  it('queries the current document attributes on every run', () => {
    document.documentElement.lang = 'en';
    const runtime = create_webview_reader_runtime(document.documentElement);
    const language = ({ language }: { language: string }): string => language;
    expect(runtime.run_reader(language)).toBe('en');
    document.documentElement.lang = 'zh-CN';
    expect(runtime.run_reader(language)).toBe('zh-CN');
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
        motion: 'reduced'
      }
    })).toBe(true);
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(document.documentElement.dataset.snlLanguagePreference).toBe('auto');
    expect(document.documentElement.dataset.snlMotion).toBe('reduced');
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
});
