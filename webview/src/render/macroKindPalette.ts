import type { KindPalette } from '@snl-basics/react';

export interface MacroKindPaletteSource {
  id: string;
  coloring: { stroke: string; background: string };
}

/** Convert config.macro_kinds into the palette consumed by SnlSyntaxTreeView. */
export function macroKindsToPalette(
  macroKinds: readonly MacroKindPaletteSource[] | undefined
): KindPalette | undefined {
  if (!macroKinds || macroKinds.length === 0) return undefined;
  const palette: KindPalette = {};
  for (const kind of macroKinds) {
    // SNL-Basics interpolates kind ids into CSS attribute selectors.
    if (!/^[A-Za-z0-9_-]+$/.test(kind.id)) continue;
    palette[kind.id] = {
      stroke: kind.coloring.stroke,
      background: kind.coloring.background
    };
  }
  return Object.keys(palette).length > 0 ? palette : undefined;
}
