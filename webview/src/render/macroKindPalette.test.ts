import { paletteToCss } from '@sjtu-ai4math/snl-basics';
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
    expect(css).toContain('background: rgba(171, 205, 239, 0.5)');
    expect(css).toContain('box-shadow: 0 0 0 1px rgba(18, 52, 86, 0.5)');
  });

  it('preserves a prototype-sensitive valid Macro Kind id', () => {
    const palette = macroKindsToPalette([
      { id: '__proto__', coloring: { stroke: '#123456', background: '#abcdef' } }
    ]);
    expect(palette).toBeDefined();
    expect(Object.hasOwn(palette!, '__proto__')).toBe(true);
    expect(palette!.__proto__).toEqual({ stroke: '#123456', background: '#abcdef' });
  });

  it('drops unsafe CSS selector ids and returns undefined for an empty palette', () => {
    expect(
      macroKindsToPalette([
        { id: 'bad.kind', coloring: { stroke: '#111111', background: '#eeeeee' } }
      ])
    ).toBeUndefined();
  });
});
