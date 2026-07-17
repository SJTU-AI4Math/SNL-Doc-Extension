import { describe, expect, it } from 'vitest';
import { wireMacroToRenderable } from './macroWire';

describe('wireMacroToRenderable', () => {
  it('normalizes one wire shape for editor previews and package rows', () => {
    expect(wireMacroToRenderable({
      name: 'm',
      kind: 'operator',
      dynamic_arity: false,
      source: { entries: ['src'], urls: [] },
      styles: [{ tag: 'default', mode: 'formula_inline', template: '#0' }]
    })).toMatchObject({
      name: 'm', kind: 'operator', source: { entries: ['src'], urls: [] },
      styles: [{ tag: 'default', mode: 'formula_inline', template: '#0' }]
    });
  });

  it('supplies a renderable default style for malformed empty style arrays', () => {
    expect(wireMacroToRenderable({ name: 'm', dynamic_arity: false, styles: [] }).styles).toHaveLength(1);
  });
});
