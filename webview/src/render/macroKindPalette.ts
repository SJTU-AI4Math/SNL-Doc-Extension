import type { KindPalette } from '@sjtu-ai4math/snl-basics';
import type { ThemedKindColoring } from '../../../src/kindColoring';

export interface MacroKindPaletteSource {
  id: string;
  coloring: ThemedKindColoring;
}

/** Convert config.macro_kinds into the palette consumed by SnlSyntaxTreeView. */
export function macroKindsToPalette(
  macroKinds: readonly MacroKindPaletteSource[] | undefined
): KindPalette | undefined {
  if (!macroKinds || macroKinds.length === 0) return undefined;
  const palette = Object.create(null) as KindPalette;
  for (const kind of macroKinds) {
    // SNL-Basics interpolates kind ids into CSS attribute selectors.
    if (!/^[A-Za-z0-9_-]+$/.test(kind.id)) continue;
    palette[kind.id] = {
      light: { ...kind.coloring.light },
      dark: { ...kind.coloring.dark }
    };
  }
  return Object.keys(palette).length > 0 ? palette : undefined;
}
