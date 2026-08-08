import { paletteToCss } from '@sjtu-ai4math/snl-basics';
import { describe, expect, it } from 'vitest';
import { macroKindsToPalette } from './macroKindPalette';

describe('macroKindsToPalette', () => {
  it('preserves configured Macro Kind colors', () => {
    const palette = macroKindsToPalette([
      { id: 'custom-kind', coloring: { light: { stroke: '#123456', background: '#abcdef' }, dark: { stroke: '#654321', background: '#fedcba' } } }
    ], 'dark');
    expect(palette).toEqual({
      'custom-kind': { light: { stroke: '#123456', background: '#abcdef' }, dark: { stroke: '#654321', background: '#fedcba' } }
    });
    const css = paletteToCss(palette!, 'dark');
    expect(css).toContain('color: #654321');
    expect(css).toContain('box-shadow: 0 0 0 1px rgba(101, 67, 33, 0.5)');
  });

  it('drops unsafe CSS selector ids and returns undefined for an empty palette', () => {
    expect(
      macroKindsToPalette([
        { id: 'bad.kind', coloring: { light: { stroke: '#111111', background: '#eeeeee' }, dark: { stroke: '#222222', background: '#dddddd' } } }
      ])
    ).toBeUndefined();
  });
});
