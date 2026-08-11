import { describe, expect, it } from 'vitest';
import { wireMacroEntriesToRenderable, wireMacroToRenderable } from './macroWire';

describe('wireMacroToRenderable', () => {
  it('normalizes one wire shape for editor previews and package rows', () => {
    expect(wireMacroToRenderable({
      name: 'm',
      description: '',
      kind: 'operator',
      dynamic_arity: false,
      source: { entries: ['src'], urls: [] },
      styles: [{ style_name: 'default',  template: { mode: 'formula_inline', body: '#0' }, tags: [] }],
      tags: []
    }, 'en')).toMatchObject({
      name: 'm', kind: 'operator', source: { entries: ['src'], urls: [] },
      styles: [{
        style_name: 'default', tags: [],
        template: { mode: 'formula_inline', body: '#0' }
      }],
      tags: []
    });
  });

  it('preserves every complete v11 template projection for the 0.2.1 renderer', () => {
    const rendered = wireMacroToRenderable({
      name: 'm', description: '', source: { entries: [], urls: [] },
      dynamic_arity: true,
      styles: [{
        style_name: 'default', tags: [],
        template: {
          type: 'i18n', default_language: 'en',
          values: {
            en: { mode: 'formula_inline', body: '#*', separator: ', ', custom: 'en' },
            'zh-CN': { mode: 'text', body: '#*', separator: '、', custom: 'zh' }
          }
        }
      }],
      tags: []
    }, 'zh-CN');
    expect(rendered.styles[0]).toEqual({
      style_name: 'default', tags: [],
      template: {
        type: 'i18n', default_language: 'en',
        values: {
          en: { mode: 'formula_inline', body: '#*', separator: ', ', custom: 'en' },
          'zh-CN': { mode: 'text', body: '#*', separator: '、', custom: 'zh' }
        }
      }
    });
  });

  it('preserves prototype-sensitive Macro names as own render-map keys', () => {
    const macro = {
      name: '__proto__', description: '', source: { entries: [], urls: [] },
      dynamic_arity: false,
      styles: [{ style_name: 'default',  template: { mode: 'formula_inline' as const, body: '#0' }, tags: [] }],
      tags: []
    };
    const rendered = wireMacroEntriesToRenderable([['__proto__', macro]], 'en');
    expect(Object.prototype.hasOwnProperty.call(rendered, '__proto__')).toBe(true);
    expect(rendered.__proto__.styles[0].template).toEqual({ mode: 'formula_inline', body: '#0' });
  });

  it('supplies a renderable default style for malformed empty style arrays', () => {
    expect(wireMacroToRenderable({
      name: 'm', description: '', source: { entries: [], urls: [] },
      dynamic_arity: false, styles: [], tags: []
    }, 'en').styles).toEqual([{
      style_name: 'default', tags: [],
      template: { mode: 'formula_inline', body: '' }
    }]);
  });
});
