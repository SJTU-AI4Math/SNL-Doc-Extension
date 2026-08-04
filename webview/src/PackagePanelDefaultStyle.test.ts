import { describe, expect, it } from 'vitest';
import { defaultStyleForLanguage, type MacroPackageEntry } from './PackagePanelApp';

const macro: MacroPackageEntry = {
  name: 'Greeting',
  description: '',
  source: { entries: [], urls: [] },
  dynamic_arity: false,
  default_style: { en: 'english', 'zh-CN': 'chinese' },
  tags: [],
  styles: [
    { style_name: 'fallback', mode: 'formula_inline', template: 'F', tags: [] },
    { style_name: 'english', mode: 'text', template: 'hello #0', tags: [] },
    { style_name: 'chinese', mode: 'text', template: '你好 #0', tags: [] }
  ]
};

describe('Package Panel language default style', () => {
  it('uses current language, then English, then styles[0]', () => {
    expect(defaultStyleForLanguage(macro, 'zh-CN')?.style_name).toBe('chinese');
    expect(defaultStyleForLanguage(macro, 'fr')?.style_name).toBe('english');
    expect(defaultStyleForLanguage({ ...macro, default_style: {} }, 'fr')?.style_name).toBe('fallback');
  });

  it('rejects dangling current-locale and English mappings like the renderer', () => {
    expect(() => defaultStyleForLanguage({
      ...macro,
      default_style: { ...macro.default_style, 'zh-CN': 'missing' }
    }, 'zh-CN')).toThrow(/default style "missing"/);
    expect(() => defaultStyleForLanguage({
      ...macro,
      default_style: { en: 'missing' }
    }, 'fr')).toThrow(/default style "missing"/);
  });
});
