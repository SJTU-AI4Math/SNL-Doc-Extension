import { describe, expect, it } from 'vitest';
import { defaultRenderers, formulaForeignCapability } from '@sjtu-ai4math/snl-basics';
import { extensionRenderers } from './blockRenderers';

describe('one-registry SVG integration', () => {
  it('preserves every Basics default and opts in exactly one svg-template renderer', () => {
    for (const key of Object.keys(defaultRenderers)) expect(extensionRenderers[key]).toBeTruthy();
    const keys = Reflect.ownKeys(extensionRenderers);
    expect(keys.filter((key) => key === 'svg_template')).toHaveLength(1);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(extensionRenderers)).toContain('svg_template');
    const spread = { ...extensionRenderers };
    expect(spread.svg_template).toBeTypeOf('function');
    expect(formulaForeignCapability(spread.svg_template)).toBeTruthy();
    expect(spread.svg_template).toBe(extensionRenderers.svg_template);
    for (const key of Object.keys(defaultRenderers)) {
      expect(spread[key]).toBe(extensionRenderers[key]);
      expect(formulaForeignCapability(spread[key])).toEqual(formulaForeignCapability(extensionRenderers[key]));
    }
  });
});
