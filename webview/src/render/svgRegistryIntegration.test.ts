import { describe, expect, it } from 'vitest';
import { defaultRenderers, formulaForeignCapability } from '@sjtu-ai4math/snl-basics';
import { extensionRenderers } from './blockRenderers';

describe('one-registry SVG integration', () => {
  it('preserves every Basics default and opts in exactly one svg-template renderer', () => {
    for (const key of Object.keys(defaultRenderers)) expect(extensionRenderers[key]).toBeTruthy();
    const spread = { ...extensionRenderers };
    expect(spread.svg_template).toBeTypeOf('function');
    expect(formulaForeignCapability(spread.svg_template)).toBeTruthy();
  });
});
