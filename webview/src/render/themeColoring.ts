export type ColorScheme = 'light' | 'dark';

export interface ThemeColorPair {
  stroke: string;
  background: string;
}

export interface ThemeColoring {
  light: ThemeColorPair;
  dark: ThemeColorPair;
}

const FALLBACK: ThemeColorPair = { stroke: '#888888', background: '#eeeeee' };

export function currentColorScheme(): ColorScheme {
  return typeof document !== 'undefined' && document.body.classList.contains('vscode-dark') ? 'dark' : 'light';
}

export function webviewContextReader(): { color_scheme: ColorScheme } {
  return { color_scheme: currentColorScheme() };
}

export function resolveThemeColoring(coloring: ThemeColoring | ThemeColorPair | null | undefined, scheme: ColorScheme = currentColorScheme()): ThemeColorPair {
  if (!coloring) return { ...FALLBACK };
  const nested = coloring as ThemeColoring;
  const selected = nested[scheme];
  if (selected && typeof selected.stroke === 'string' && typeof selected.background === 'string') return selected;
  const legacy = coloring as ThemeColorPair;
  return {
    stroke: typeof legacy.stroke === 'string' ? legacy.stroke : FALLBACK.stroke,
    background: typeof legacy.background === 'string' ? legacy.background : FALLBACK.background
  };
}
