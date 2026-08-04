import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { canonicalizeMacroPackageData } from './snlDoc';

describe('Macro package v7 to v8 canonicalization', () => {
  it('rejects localized templates instead of silently changing explicit [style] semantics', () => {
    expect(() => canonicalizeMacroPackageData('Logic.json', {
      version: '7',
      name: 'Logic',
      custom: 'preserve',
      macros: {
        'Group.is': {
          description: '',
          source: { entries: [], urls: [] },
          dynamic_arity: false,
          tags: [],
          styles: [
            {
              style_name: 'prose',
              mode: 'text',
              template: {
                type: 'i18n',
                default_language: 'en',
                values: { en: '#0 is a group', 'zh-CN': '#0 是群' }
              },
              tags: []
            },
            {
              style_name: 'formula',
              mode: 'formula_inline',
              template: '\\operatorname{Group}(#0)',
              tags: []
            }
          ]
        }
      }
    })).toThrow(/cannot preserve.*explicit \[style\] semantics/i);
  });

  it('adds English → styles[0] for invariant v7 macros', () => {
    const result = canonicalizeMacroPackageData('Plain.json', {
      version: '7', name: 'Plain', macros: {
        Plain: {
          description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
          styles: [{ style_name: 'compact', mode: 'formula_inline', template: '#0', tags: [] }]
        }
      }
    });
    expect((result.macros as Record<string, any>).Plain.default_style).toEqual({ en: 'compact' });
  });
});
