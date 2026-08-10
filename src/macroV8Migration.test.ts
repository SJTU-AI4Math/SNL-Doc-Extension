import { describe, expect, it, vi } from 'vitest';
vi.mock('vscode', () => ({}));
import { canonicalizeMacroPackageData } from './snlDoc';

describe('Macro package v11 whole-template localization migration', () => {
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
    expect(result.version).toBe('11');
    expect(macro).not.toHaveProperty('default_style');
    expect(macro.kind).toBe('const');
    expect(macro.styles).toHaveLength(2);
    expect(macro.styles[0].template.values['zh-CN']).toMatchObject({
      mode: 'text', body: '#0 是群'
    });
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
            { style_name: 'prose', mode: 'text', template: '#*', separator: ', ', tags: [] },
            { style_name: 'prose_zh_CN', mode: 'text', template: '#*', separator: '、', tags: [] }
          ]
        }
      }
    });
    const macro = (result.macros as Record<string, any>).Legacy;
    expect(result.version).toBe('11');
    expect(macro).not.toHaveProperty('default_style');
    expect(macro.styles[0].template.values).toEqual({
      en: { mode: 'text', body: '#*', separator: ', ' },
      'zh-CN': { mode: 'text', body: '#*', separator: '、' }
    });
    expect(macro.styles.slice(1).map((style: any) => style.style_name)).toEqual(['prose', 'prose_zh_CN']);
  });

  it('moves v10 Style extensions into each complete v11 template projection', () => {
    const result = canonicalizeMacroPackageData('Extensions.json', {
      version: '10', name: 'Extensions', macros: {
        Extensions: {
          description: '', source: { entries: [], urls: [] }, kind: 'const',
          dynamic_arity: false, tags: [],
          styles: [{
            style_name: 'default', mode: 'text', template: '#0', tags: [],
            vendor_style: { keep: true }
          }]
        }
      }
    });
    const style = (result.macros as Record<string, any>).Extensions.styles[0];
    expect(Object.keys(style).sort()).toEqual(['style_name', 'tags', 'template']);
    expect(style.template.vendor_style).toEqual({ keep: true });
  });

  it.each(['body', 'type'] as const)(
    'fails closed when a v10 Style extension collides with TemplateSpec.%s',
    (field) => {
      expect(() => canonicalizeMacroPackageData('Collision.json', {
        version: '10', name: 'Collision', macros: {
          Collision: {
            description: '', source: { entries: [], urls: [] }, kind: 'const',
            dynamic_arity: false, tags: [],
            styles: [{
              style_name: 'default', mode: 'text', template: '#0', tags: [],
              [field]: { opaque: true }
            }]
          }
        }
      })).toThrow(/extension.*collides with TemplateSpec/i);
    }
  );

  it('rejects v8 language defaults with divergent invariant tags', () => {
    expect(() => canonicalizeMacroPackageData('Divergent.json', {
      version: '8', name: 'Divergent', macros: {
        Divergent: {
          description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
          default_style: { en: 'a', 'zh-CN': 'b' },
          styles: [
            { style_name: 'a', mode: 'text', template: '#0', tags: ['alpha'] },
            { style_name: 'b', mode: 'text', template: '#0', tags: ['beta'] }
          ]
        }
      }
    })).toThrow(/selected Style tags cannot be localized/i);

    expect(() => canonicalizeMacroPackageData('FallbackDivergent.json', {
      version: '8', name: 'FallbackDivergent', macros: {
        FallbackDivergent: {
          description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
          default_style: { 'zh-CN': 'b' },
          styles: [
            { style_name: 'fallback', mode: 'text', template: '#0', tags: ['fallback'] },
            { style_name: 'b', mode: 'text', template: '#0', tags: ['localized'] }
          ]
        }
      }
    })).toThrow(/selected Style tags cannot be localized/i);
  });

  it('preserves a prototype-sensitive locale as an own projection', () => {
    const default_style = JSON.parse('{"en":"a","__proto__":"b"}');
    const result = canonicalizeMacroPackageData('Locales.json', {
      version: '8', name: 'Locales', macros: {
        Locales: {
          description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
          default_style,
          styles: [
            { style_name: 'a', mode: 'text', template: 'English #0', tags: [] },
            { style_name: 'b', mode: 'text', template: 'Prototype #0', tags: [] }
          ]
        }
      }
    });
    const values = (result.macros as Record<string, any>).Locales.styles[0].template.values;
    expect(Object.prototype.hasOwnProperty.call(values, '__proto__')).toBe(true);
    expect(values.__proto__.body).toBe('Prototype #0');
  });

  it('rejects current v11 Style-scope extensions', () => {
    expect(() => canonicalizeMacroPackageData('Current.json', {
      version: '11', name: 'Current', macros: {
        Current: {
          description: '', source: { entries: [], urls: [] }, kind: 'const',
          dynamic_arity: false, tags: [],
          styles: [{
            style_name: 'default', tags: [], template: { mode: 'text', body: '#0' },
            vendor_style: { ignored: true }
          }]
        }
      }
    })).toThrow(/Style boundary|outside.*v11|invalid/i);

    expect(() => canonicalizeMacroPackageData('Hybrid.json', {
      version: '11', name: 'Hybrid', macros: {
        Hybrid: {
          description: '', source: { entries: [], urls: [] }, kind: 'const',
          dynamic_arity: false, tags: [],
          styles: [{
            style_name: 'default', tags: [],
            template: {
              type: 'i18n', default_language: 'en',
              values: { en: { mode: 'text', body: '#0' } },
              mode: 'block', body: 'IGNORED'
            }
          }]
        }
      }
    })).toThrow(/invalid localized template/i);
  });

  it('materializes v11 kinds without erasing consumer-defined identities', () => {
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
    expect(result.version).toBe('11');
    expect(macros.Missing.kind).toBe('const');
    expect(macros.LegacySub.kind).toBe('sub');
    expect(macros.DomainKind.kind).toBe('theorem');
  });

  it.each(['7', '8', '9', '10', '11'] as const)('preserves __proto__ as an own Macro key when targeting v%s', (target) => {
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
    if (target === '11') {
      expect(migrated.__proto__.styles[0]).toMatchObject({
        style_name: 'default', template: { mode: 'formula_inline', body: '#0' }
      });
    } else {
      expect(migrated.__proto__.styles).toEqual(macro.styles);
    }
  });

  it.each(['7', '8', '9', '10', '11'] as const)(
    'rejects an explicit future Macro package version before targeting v%s',
    (target) => {
      expect(() => canonicalizeMacroPackageData('Future.json', {
        version: '12', name: 'Future', future_wrapper: { keep: true },
        macros: {
          Future: {
            description: '', source: { entries: [], urls: [] }, kind: 'const',
            dynamic_arity: false, tags: [], future_macro: { keep: true },
            styles: [{
              style_name: 'default', mode: 'text', template: '#0', tags: [],
              future_style: { keep: true }
            }]
          }
        }
      }, target)).toThrow(/unsupported.*version.*12/i);
    }
  );

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
      values: {
        en: { mode: 'text', body: 'Fallback #0' },
        'zh-CN': { mode: 'text', body: '中文 #0' }
      }
    });
  });
});
