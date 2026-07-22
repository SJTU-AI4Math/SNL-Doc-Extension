import { paletteToCss } from '@snl-basics/react';
import { describe, expect, it } from 'vitest';
import { macroKindsToPalette } from './macroKindPalette';

describe('macroKindsToPalette', () => {
  it('preserves configured Macro Kind colors', () => {
    const palette = macroKindsToPalette([
      { id: 'custom-kind', coloring: { stroke: '#123456', background: '#abcdef' } }
    ]);
    expect(palette).toEqual({
      'custom-kind': { stroke: '#123456', background: '#abcdef' }
    });
    const css = paletteToCss(palette!);
    expect(css).toContain('color: #123456');
    expect(css).toContain('box-shadow: 0 0 0 1px #abcdef');
  });

  it('drops unsafe CSS selector ids and returns undefined for an empty palette', () => {
    expect(
      macroKindsToPalette([
        { id: 'bad.kind', coloring: { stroke: '#111111', background: '#eeeeee' } }
      ])
    ).toBeUndefined();
  });
});
