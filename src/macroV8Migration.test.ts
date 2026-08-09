import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { canonicalizeMacroPackageData } from './snlDoc';

describe('Macro package v10 migration with v9 localization correction', () => {
  it('preserves a localized text template inside one semantic style', () => {
    const result = canonicalizeMacroPackageData('Logic.json', {
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
    });
    const macro = (result.macros as Record<string, any>)['Group.is'];
    expect(result.version).toBe('10');
    expect(macro).not.toHaveProperty('default_style');
    expect(macro.kind).toBe('const');
    expect(macro.styles).toHaveLength(2);
    expect(macro.styles[0].template.values['zh-CN']).toBe('#0 是群');
  });

  it('keeps styles[0] as the only implicit default', () => {
    const result = canonicalizeMacroPackageData('Plain.json', {
      version: '7', name: 'Plain', macros: {
        Plain: {
          description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
          styles: [{ style_name: 'compact', mode: 'formula_inline', template: '#0', tags: [] }]
        }
      }
    });
    const macro = (result.macros as Record<string, any>).Plain;
    expect(macro).not.toHaveProperty('default_style');
    expect(macro.styles[0].style_name).toBe('compact');
  });

  it('strips a redundant legacy default_style map', () => {
    const result = canonicalizeMacroPackageData('Plain.json', {
      version: '8', name: 'Plain', macros: {
        Plain: {
          description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
          default_style: { en: 'compact', 'zh-CN': 'compact' },
          styles: [{ style_name: 'compact', mode: 'text', template: 'X', tags: [] }]
        }
      }
    });
    expect((result.macros as Record<string, any>).Plain).not.toHaveProperty('default_style');
  });

  it('upgrades published v8 language defaults while retaining explicit style identities', () => {
    const result = canonicalizeMacroPackageData('Legacy.json', {
      version: '8', name: 'Legacy', macros: {
        Legacy: {
          description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
          default_style: { en: 'prose', 'zh-CN': 'prose_zh_CN' },
          styles: [
            { style_name: 'prose', mode: 'text', template: 'English #0', tags: [] },
            { style_name: 'prose_zh_CN', mode: 'text', template: '中文 #0', tags: [] }
          ]
        }
      }
    });
    const macro = (result.macros as Record<string, any>).Legacy;
    expect(result.version).toBe('10');
    expect(macro).not.toHaveProperty('default_style');
    expect(macro.styles[0].template.values).toEqual({ en: 'English #0', 'zh-CN': '中文 #0' });
    expect(macro.styles.slice(1).map((style: any) => style.style_name)).toEqual(['prose', 'prose_zh_CN']);
  });

  it('materializes v10 kinds without erasing consumer-defined identities', () => {
    const result = canonicalizeMacroPackageData('Kinds.json', {
      version: '9', name: 'Kinds', macros: {
        Missing: {
          description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
          styles: [{ style_name: 'default', mode: 'formula_inline', template: '#0', tags: [] }]
        },
        LegacySub: {
          description: '', source: { entries: [], urls: [] }, kind: 'partial', dynamic_arity: false, tags: [],
          styles: [{ style_name: 'default', mode: 'formula_inline', template: '#0', tags: [] }]
        },
        DomainKind: {
          description: '', source: { entries: [], urls: [] }, kind: 'theorem', dynamic_arity: false, tags: [],
          styles: [{ style_name: 'default', mode: 'formula_inline', template: '#0', tags: [] }]
        }
      }
    });
    const macros = result.macros as Record<string, any>;
    expect(result.version).toBe('10');
    expect(macros.Missing.kind).toBe('const');
    expect(macros.LegacySub.kind).toBe('sub');
    expect(macros.DomainKind.kind).toBe('theorem');
  });

  it.each(['7', '8', '9', '10'] as const)('preserves __proto__ as an own Macro key when targeting v%s', (target) => {
    const macro = {
      description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
      styles: [{ style_name: 'default', mode: 'formula_inline', template: '#0', tags: [] }]
    };
    const macros = JSON.parse(`{"__proto__":${JSON.stringify(macro)}}`);
    const result = canonicalizeMacroPackageData('Prototype.json', {
      version: '7', name: 'Prototype', macros
    }, target);
    const migrated = result.macros as Record<string, any>;
    expect(Object.prototype.hasOwnProperty.call(migrated, '__proto__')).toBe(true);
    expect(migrated.__proto__.styles).toEqual(macro.styles);
  });

  it('preserves styles[0] fallback when a published-v8 map omits en', () => {
    const result = canonicalizeMacroPackageData('Legacy.json', {
      version: '8', name: 'Legacy', macros: {
        Legacy: {
          description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
          default_style: { 'zh-CN': 'chinese' },
          styles: [
            { style_name: 'fallback', mode: 'text', template: 'Fallback #0', tags: [] },
            { style_name: 'chinese', mode: 'text', template: '中文 #0', tags: [] }
          ]
        }
      }
    });
    const template = (result.macros as Record<string, any>).Legacy.styles[0].template;
    expect(template).toEqual({
      type: 'i18n', default_language: 'en',
      values: { en: 'Fallback #0', 'zh-CN': '中文 #0' }
    });
  });
});
