import { describe, expect, it } from 'vitest';
import type { I18n } from '@snl-basics/react';
import { merge_localized_projection } from './localizedDraft';

const original: I18n<string, string> = {
  type: 'i18n',
  default_language: 'en',
  values: { en: 'Entry' }
};

describe('localized editor projections', () => {
  it('does not materialize fallback text when the locale was not edited', () => {
    expect(merge_localized_projection(original, 'Entry', 'zh-CN', false)).toBe(original);
    expect(original.values['zh-CN']).toBeUndefined();
  });

  it('writes the active locale after an actual edit', () => {
    expect(
      merge_localized_projection(original, '条目', 'zh-CN', true).values['zh-CN']
    ).toBe('条目');
  });
});
