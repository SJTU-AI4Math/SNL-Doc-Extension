import { paletteToCss } from '@sjtu-ai4math/snl-basics';
import { describe, expect, it } from 'vitest';
import { macroKindsToPalette } from './macroKindPalette';

const coloring = {
  light: { stroke: '#123456', background: '#abcdef' },
  dark: { stroke: '#fedcba', background: '#654321' }
};

describe('macroKindsToPalette', () => {
  it('preserves both configured Macro Kind theme variants', () => {
    const palette = macroKindsToPalette([{ id: 'custom-kind', coloring }]);
    expect(palette).toEqual({ 'custom-kind': coloring });
    const lightCss = paletteToCss(palette!, 'light');
    expect(lightCss).toContain('color: #123456');
    expect(lightCss).toContain('background: rgba(171, 205, 239, 0.5)');
    const darkCss = paletteToCss(palette!, 'dark');
    expect(darkCss).toContain('color: #fedcba');
    expect(darkCss).toContain('background: rgba(101, 67, 33, 0.5)');
  });

  it('preserves a prototype-sensitive valid Macro Kind id', () => {
    const palette = macroKindsToPalette([{ id: '__proto__', coloring }]);
    expect(palette).toBeDefined();
    expect(Object.hasOwn(palette!, '__proto__')).toBe(true);
    expect(palette!.__proto__).toEqual(coloring);
  });

  it('drops unsafe CSS selector ids and returns undefined for an empty palette', () => {
    expect(macroKindsToPalette([{ id: 'bad.kind', coloring }])).toBeUndefined();
  });
});
