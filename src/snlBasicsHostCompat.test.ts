import { describe, expect, it } from 'vitest';
import {
  isSnlIdentifier as hostIsSnlIdentifier,
  migrateMacroDocument as hostMigrateMacroDocument,
  migrateMacroV7toV8 as hostMigrateMacroV7toV8
} from './snlBasicsHostCompat';
import {
  migrateMacroDocument,
  migrateMacroV7toV8
} from '@sjtu-ai4math/snl-basics';
import { isSnlIdentifier } from '@sjtu-ai4math/snl-basics/core';

describe('CommonJS SNL-Basics host bridge', () => {
  it('matches the published identifier parser', () => {
    for (const value of [
      '', 'Set.mem', '_x', 'α', '中文', 'a-b', 'a b', 'a/b', '1x',
      '__proto__', 'foo.bar_baz', '猫.定理', '😀', '@bad', '#0'
    ]) {
      expect(hostIsSnlIdentifier(value), value).toBe(isSnlIdentifier(value));
    }
  });

  it('matches the published v8-to-current document migration', () => {
    const document = {
      X: {
        name: 'X', description: '', source: { entries: [], urls: [] },
        dynamic_arity: false, tags: [], default_style: { en: 'english', 'zh-CN': 'chinese' },
        styles: [
          { style_name: 'english', mode: 'text', template: 'English', tags: [] },
          { style_name: 'chinese', mode: 'text', template: '中文', tags: [] }
        ]
      }
    };
    expect(hostMigrateMacroDocument(document)).toEqual(migrateMacroDocument(document));
  });

  it('matches the published v7-to-v8 migration', () => {
    const macro = {
      name: 'X', description: '', source: { entries: [], urls: [] },
      dynamic_arity: false, tags: [],
      styles: [{ style_name: 'default', mode: 'formula_inline', template: '#0', tags: [] }]
    };
    expect(hostMigrateMacroV7toV8(macro)).toEqual(migrateMacroV7toV8(macro));
  });
});
