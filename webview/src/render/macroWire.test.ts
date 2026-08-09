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
      styles: [{ style_name: 'default', mode: 'formula_inline', template: '#0', tags: [] }],
      tags: []
    })).toMatchObject({
      name: 'm', kind: 'operator', source: { entries: ['src'], urls: [] },
      styles: [{ style_name: 'default', mode: 'formula_inline', template: '#0', tags: [] }],
      tags: []
    });
  });

  it('preserves prototype-sensitive Macro names as own render-map keys', () => {
    const macro = {
      name: '__proto__', description: '', source: { entries: [], urls: [] },
      dynamic_arity: false,
      styles: [{ style_name: 'default', mode: 'formula_inline' as const, template: '#0', tags: [] }],
      tags: []
    };
    const rendered = wireMacroEntriesToRenderable([['__proto__', macro]]);
    expect(Object.prototype.hasOwnProperty.call(rendered, '__proto__')).toBe(true);
    expect(rendered.__proto__.styles[0].template).toBe('#0');
  });

  it('supplies a renderable default style for malformed empty style arrays', () => {
    expect(wireMacroToRenderable({
      name: 'm', description: '', source: { entries: [], urls: [] },
      dynamic_arity: false, styles: [], tags: []
    }).styles).toHaveLength(1);
  });
});
