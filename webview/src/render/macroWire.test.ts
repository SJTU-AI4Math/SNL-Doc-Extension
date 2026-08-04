import { describe, expect, it } from 'vitest';
import { wireMacroToRenderable } from './macroWire';

describe('wireMacroToRenderable', () => {
  it('normalizes one wire shape for editor previews and package rows', () => {
    expect(wireMacroToRenderable({
      name: 'm',
      description: '',
      kind: 'operator',
      dynamic_arity: false,
      default_style: { en: 'default' },
      source: { entries: ['src'], urls: [] },
      styles: [{ style_name: 'default', mode: 'formula_inline', template: '#0', tags: [] }],
      tags: []
    })).toMatchObject({
      name: 'm', kind: 'operator', source: { entries: ['src'], urls: [] },
      styles: [{ style_name: 'default', mode: 'formula_inline', template: '#0', tags: [] }],
      tags: []
    });
  });

  it('supplies a renderable default style for malformed empty style arrays', () => {
    expect(wireMacroToRenderable({
      name: 'm', description: '', source: { entries: [], urls: [] },
      dynamic_arity: false, default_style: { en: 'default' }, styles: [], tags: []
    }).styles).toHaveLength(1);
  });
});
