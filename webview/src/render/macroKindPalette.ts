import type { KindPalette } from '@sjtu-ai4math/snl-basics';
import type { ColorScheme, ThemeColoring } from './themeColoring';

export interface MacroKindPaletteSource {
  id: string;
  coloring: ThemeColoring | { stroke: string; background: string };
}

/** Convert config.macro_kinds into the palette consumed by SnlSyntaxTreeView. */
export function macroKindsToPalette(
  macroKinds: readonly MacroKindPaletteSource[] | undefined,
  scheme?: ColorScheme
): KindPalette | undefined {
  if (!macroKinds || macroKinds.length === 0) return undefined;
  const palette: KindPalette = {};
  for (const kind of macroKinds) {
    // SNL-Basics interpolates kind ids into CSS attribute selectors.
    if (!/^[A-Za-z0-9_-]+$/.test(kind.id)) continue;
    void scheme;
    if ('light' in kind.coloring && 'dark' in kind.coloring) {
      palette[kind.id] = kind.coloring;
    } else {
      const pair = { stroke: kind.coloring.stroke, background: kind.coloring.background };
      palette[kind.id] = { light: { ...pair }, dark: { ...pair } };
    }
  }
  return Object.keys(palette).length > 0 ? palette : undefined;
}
