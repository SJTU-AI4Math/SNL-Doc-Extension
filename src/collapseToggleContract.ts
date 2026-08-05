// The collapse toggle's presentation contract, shared by both surfaces.
//
// Lives under `src/` because tsconfig rootDir confines the host build to that
// tree; the webview has no such restriction and imports it from here.
//
// Cat 2026-07-28: 'Collapse 按钮的效果和 Extension 内很不一样？'  It was: the
// export hand-rolled its own glyphs, sizing, and CSS instead of reusing what
// the live Infoview already had. This module is the single source of truth for
// the parts BOTH surfaces can share, so they cannot drift again.
//
// What is shared: glyphs, geometry, the `.snl-btn` class list, and the label
// text. What is NOT shared is the mechanism — the live panel is a React
// component driven by `useState`, the export is a DOM script with no React —
// and that difference is irreducible. So the contract is shared and each
// surface supplies its own driver.

/** Class list every collapse toggle carries. Styling lives in `ui.css`, which
 *  the exported document already inlines via the built stylesheet. */
export const COLLAPSE_TOGGLE_CLASS = 'snl-btn snl-btn--ghost snl-btn--sm snl-collapse-toggle';

/** Collapsed / expanded glyphs. U+25B6 / U+25BC, matching the live panel. */
export const COLLAPSE_GLYPH = { collapsed: '\u25b6', expanded: '\u25bc' } as const;

/** Geometry, kept identical on both surfaces. */
export const COLLAPSE_TOGGLE_GEOMETRY = {
  left: -20,
  top: 8,
  size: 18
} as const;

/** Tooltip text. The child count belongs here, not on the button face: the
 *  live panel keeps the glyph a bare triangle and explains in the tooltip. */
export function collapseToggleTitle(
  collapsed: boolean,
  childCount: number,
  locale = 'en'
): string {
  if (locale.toLowerCase().startsWith('zh')) {
    return `${collapsed ? '展开' : '收起'} ${childCount} 个子条目`;
  }
  const noun = `sub-entr${childCount === 1 ? 'y' : 'ies'}`;
  return `${collapsed ? 'Expand' : 'Collapse'} ${childCount} ${noun}`;
}

/** Accessible name, independent of the child count. */
export function collapseToggleAriaLabel(collapsed: boolean, locale = 'en'): string {
  if (locale.toLowerCase().startsWith('zh')) return collapsed ? '展开' : '收起';
  return collapsed ? 'Expand' : 'Collapse';
}

/** Inline style shared by both surfaces, as a plain object. */
export const COLLAPSE_TOGGLE_STYLE = {
  position: 'absolute',
  left: `${COLLAPSE_TOGGLE_GEOMETRY.left}px`,
  top: `${COLLAPSE_TOGGLE_GEOMETRY.top}px`,
  width: `${COLLAPSE_TOGGLE_GEOMETRY.size}px`,
  height: `${COLLAPSE_TOGGLE_GEOMETRY.size}px`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0',
  fontSize: '0.85rem',
  opacity: '0.75',
  userSelect: 'none'
} as const;
