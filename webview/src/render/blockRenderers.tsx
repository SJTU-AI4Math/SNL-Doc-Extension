// Extension-owned block renderers, plus the registry the Extension hands to
// SNL-Basics's view.
//
// ── Why the registry must spread `defaultRenderers` ──────────────────────────
// `SnlSyntaxTreeView` merges hooks as `{ ...defaultRenderHooks, ...hooksOverride }`
// — a SHALLOW merge. So the moment a consumer passes `renderers` at all, that
// object REPLACES the built-in registry wholesale; it is not merged key-by-key.
// Passing `{ collapsible: CollapsibleRenderer }` alone would therefore silently
// kill `list` / `enumerate` / `table` / `centered` everywhere in the Extension.
// Hence `extensionRenderers` below always spreads `defaultRenderers` first, and
// `blockRenderers.test.tsx` locks that invariant with an explicit assertion.
//
// ── Why the collapse chrome comes from `collapseToggleContract` ──────────────
// The glyphs, `.snl-btn` class list and geometry are shared with the static
// HTML export (see `src/collapseToggleContract.ts`), so the triangle looks and
// sits identically on every surface. The *title* text there says "sub-entries",
// which is Entry-tree vocabulary and wrong for a block macro, so this module
// supplies its own local title function rather than mutating the shared
// contract (both the Infoview and the export read it; changing it breaks the
// parity test that keeps the two honest).

import React, { useState } from 'react';
import {
  defaultRenderers,
  type SnlBlockRenderer,
  type SnlRendererRegistry,
  type SnlSyntaxTree
} from '@sjtu-ai4math/snl-basics';
import {
  COLLAPSE_GLYPH,
  COLLAPSE_TOGGLE_CLASS,
  COLLAPSE_TOGGLE_STYLE,
  collapseToggleAriaLabel
} from '../../../src/collapseToggleContract';

/**
 * Tooltip text for a collapsible *block macro*. Deliberately NOT
 * `collapseToggleTitle` from the shared contract: that one counts
 * "sub-entries" (Entry tree), while here the hidden children are body parts of
 * one block.
 */
export function collapsibleBlockTitle(collapsed: boolean, hiddenCount: number): string {
  const noun = `part${hiddenCount === 1 ? '' : 's'}`;
  return `${collapsed ? 'Expand' : 'Collapse'} ${hiddenCount} ${noun}`;
}

/**
 * Author intent for the initial fold state, read from `node.mdata.collapsed`.
 *
 * This is read-only: the expanded/collapsed state the *reader* produces by
 * clicking is transient UI state held in `useState` and is never written back
 * to the node, its `mdata`, or any serialized form. The syntax tree is the
 * document, not a UI store.
 */
function initiallyCollapsed(node: SnlSyntaxTree): boolean {
  const mdata = node.mdata;
  return (
    typeof mdata === 'object' &&
    mdata !== null &&
    (mdata as { collapsed?: unknown }).collapsed === true
  );
}

/**
 * `collapsible` block renderer.
 *
 * Semantics: `children[0]` is the always-visible summary / heading;
 * `children.slice(1)` is the foldable body. With fewer than 2 children there is
 * nothing to fold, so it degrades to a plain block (no toggle) instead of
 * erroring.
 */
export const CollapsibleRenderer: SnlBlockRenderer = ({ node, renderChild }) => {
  const children = Array.isArray(node.children) ? node.children : [];
  const [collapsed, setCollapsed] = useState(() => initiallyCollapsed(node));

  // Degenerate case: no separable body → plain block, no chrome.
  if (children.length < 2) {
    return (
      <div className="snl-collapsible snl-collapsible--flat">
        {children.map((child, i) => (
          <React.Fragment key={i}>{renderChild(child)}</React.Fragment>
        ))}
      </div>
    );
  }

  const [summary, ...body] = children;
  const toggle = (): void => setCollapsed((c) => !c);

  return (
    <div
      className="snl-collapsible"
      data-collapsed={collapsed ? 'true' : 'false'}
      style={{ position: 'relative' }}
    >
      <div
        className="snl-collapsible__summary"
        onClick={toggle}
        style={{ cursor: 'pointer' }}
      >
        <button
          type="button"
          className={COLLAPSE_TOGGLE_CLASS}
          style={COLLAPSE_TOGGLE_STYLE as React.CSSProperties}
          aria-expanded={!collapsed}
          aria-label={collapseToggleAriaLabel(collapsed)}
          title={collapsibleBlockTitle(collapsed, body.length)}
          onClick={(e) => {
            // The summary row is itself clickable; stop the bubble so one
            // click is not counted twice.
            e.stopPropagation();
            toggle();
          }}
        >
          {collapsed ? COLLAPSE_GLYPH.collapsed : COLLAPSE_GLYPH.expanded}
        </button>
        {renderChild(summary)}
      </div>
      {/* Not rendered while collapsed: guarantees the hidden body holds no
          tab stops (a `display:none` container would also work, but this is
          unconditionally safe). */}
      {collapsed ? null : (
        <div className="snl-collapsible__body">
          {body.map((child, i) => (
            <React.Fragment key={i}>{renderChild(child)}</React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * The registry the Extension passes as `hooks.renderers`.
 *
 * MUST spread `defaultRenderers` — see the module header. Dropping the spread
 * silently disables every SNL-Basics built-in block renderer.
 */
export const extensionRenderers: SnlRendererRegistry = {
  ...defaultRenderers,
  collapsible: CollapsibleRenderer
};
