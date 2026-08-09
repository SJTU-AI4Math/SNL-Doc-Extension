import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { __testBuildMacroPackageResult, canonicalizeMacroPackageData } from './snlDoc';

describe('Macro package v7 to v10 canonicalization', () => {
  it('does not stamp ordinary package reads as v10 while retaining v8 fields', () => {
    const result = __testBuildMacroPackageResult('Kinds', {
      version: '8', name: 'Kinds', macros: {
        X: {
          description: '', source: { entries: [], urls: [] },
          dynamic_arity: false, tags: [], default_style: { en: 'default' },
          styles: [{ style_name: 'default', mode: 'formula_inline', template: 'X', tags: [] }]
        }
      }
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(result.message);
    expect(result.pkg.version).toBe('10');
    expect(result.pkg.macros.X).toMatchObject({ kind: 'const' });
    expect(result.pkg.macros.X).not.toHaveProperty('default_style');
  });
  it('preserves custom Macro kinds, renames partial to sub, and removes default_style', () => {
    const result = canonicalizeMacroPackageData('Kinds.json', {
      version: '8', name: 'Kinds', macros: {
        Rule: {
          description: '', source: { entries: [], urls: [] }, kind: 'rule',
          dynamic_arity: false, tags: [], default_style: { en: 'default' },
          styles: [{ style_name: 'default', mode: 'formula_inline', template: 'R', tags: [] }],
          backend_extension: { keep: true }
        },
        Transparent: {
          description: '', source: { entries: [], urls: [] }, kind: 'partial',
          dynamic_arity: false, tags: [], default_style: { en: 'default' },
          styles: [{ style_name: 'default', mode: 'formula_inline', template: 'T', tags: [] }]
        }
      }
    }, '10');
    expect(result).toMatchObject({
      version: '10',
      macros: {
        Rule: { kind: 'rule', backend_extension: { keep: true } },
        Transparent: { kind: 'sub' }
      }
    });
    expect((result as any).macros.Rule).not.toHaveProperty('default_style');
  });

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

  it('uses styles[0] implicitly and materializes const for invariant v7 macros', () => {
    const result = canonicalizeMacroPackageData('Plain.json', {
      version: '7', name: 'Plain', macros: {
        Plain: {
          description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
          styles: [{ style_name: 'compact', mode: 'formula_inline', template: '#0', tags: [] }]
        }
      }
    });
    expect((result.macros as Record<string, any>).Plain).toMatchObject({ kind: 'const' });
    expect((result.macros as Record<string, any>).Plain).not.toHaveProperty('default_style');
  });
});
