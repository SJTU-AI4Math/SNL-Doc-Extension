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

  it('preserves complete localized svg_template projections and style identity', () => {
    const svg = {
      asset: { source: 'diagrams/proof.svg', base_identity: 'workspace:.SNL_Doc/assets', revision: 'sha256:abc', request_epoch: 7 },
      generation: 4, producer_revision: 'renderer-v1', accessibility: { label: 'Proof diagram' },
      formula_embed: { total_height_em: 2, baseline_ratio: 0.7, measurement: 'fixed' }
    };
    const rendered = wireMacroToRenderable({
      name: 'diagram', description: '', source: { entries: ['ref'], urls: [] },
      dynamic_arity: false, tags: [], styles: [
        { style_name: 'compact', tags: [], template: { mode: 'block', body: '#0', block_template_name: 'svg_template', svg_template: svg } },
        { style_name: 'localized', tags: [], template: { type: 'i18n', default_language: 'en', values: {
          en: { mode: 'block', body: '#0', block_template_name: 'svg_template', svg_template: { ...svg, accessibility: { label: 'English diagram' } } },
          'zh-CN': { mode: 'block', body: '#0', block_template_name: 'svg_template', svg_template: { ...svg, accessibility: { label: '中文图示' } } }
        } } }
      ]
    }, 'zh-CN');
    expect((rendered.styles[0].template as Record<string, unknown>).svg_template).toEqual(svg);
    expect(rendered.styles[1].style_name).toBe('localized');
    expect((rendered.styles[1].template as { values: Record<string, Record<string, unknown>> }).values['zh-CN'].svg_template)
      .toMatchObject({ accessibility: { label: '中文图示' } });
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
