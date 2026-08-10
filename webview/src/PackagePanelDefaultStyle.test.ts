import { describe, expect, it } from 'vitest';
import { defaultStyleForLanguage, type MacroPackageEntry } from './PackagePanelApp';

const macro: MacroPackageEntry = {
  name: 'Greeting',
  description: '',
  source: { entries: [], urls: [] },
  dynamic_arity: false,
  tags: [],
  styles: [
    {
      style_name: 'prose',
      template: {
        type: 'i18n', default_language: 'en',
        values: {
          en: { mode: 'text', body: 'hello #0' },
          'zh-CN': { mode: 'text', body: '你好 #0' }
        }
      },
      tags: []
    },
    {
      style_name: 'compact',
      template: { mode: 'formula_inline', body: '#0' },
      tags: []
    }
  ]
};

describe('Package Panel implicit style', () => {
  it('uses styles[0] in every language', () => {
    expect(defaultStyleForLanguage(macro, 'zh-CN')?.style_name).toBe('prose');
    expect(defaultStyleForLanguage(macro, 'fr')?.style_name).toBe('prose');
  });

  it('returns undefined for a malformed empty style list', () => {
    expect(defaultStyleForLanguage({ ...macro, styles: [] }, 'en')).toBeUndefined();
  });
});
