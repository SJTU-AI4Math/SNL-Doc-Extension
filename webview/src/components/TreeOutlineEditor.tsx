// Generic, entity-agnostic tree outline editor (extracted 2026-07-16 from the
// library entry outline in CreateLibraryApp.tsx).
//
// This component owns the *structural* concerns shared by every tree-shaped
// editor in the webviews:
//   - recursion over roots + children (via `getId` / `getChildren`),
//   - per-node collapse / expand state,
//   - the hover-revealed Button row toolbar
//       (+child / +sibling / ←| outdent / →| indent / ↑ up / ↓ down / ✕),
//   - indent / outdent enablement (needs a previous sibling / a parent),
//   - the depth-tinted row container + hover CSS.
//
// The *content* of each row (numbers, badges, inline inputs, …) is entirely
// caller-controlled via `renderRow`. Callers that need an inline add form or
// popover attached to a row inject it via `renderAfterRow`.
//
// Toolbar clicks are surfaced as a small generic `TreeOp` vocabulary — the
// caller maps each op to its own mutation (post a graphOp, open an add form,
// dispatch a counterOp, …). This keeps the component free of any knowledge
// about graphs, counters, or the host protocol.

import React, { useState } from 'react';
import { Button } from './Button';
import {
  TREE_OUTLINE_TOOLBAR_CSS,
  treeDisclosureA11y,
  treeRowCapabilities,
  treeRowStyle
} from './interactionModel';

/**
 * Structural mutation surfaced by the row toolbar. Generic over the node id;
 * mirrors the counter/entry op vocabulary but carries no seed/payload — the
 * caller owns how each op is realised (immediate mutation vs. add form).
 */
export interface TreeOp {
  kind: 'addChild' | 'addSibling' | 'move' | 'indent' | 'outdent' | 'delete';
  /** The node the toolbar button was on. For `addChild` this is the parent. */
  id: string;
  /** Only present for `kind === 'move'`. */
  direction?: 'up' | 'down';
}

export interface TreeOutlineEditorProps<T> {
  roots: T[];
  getId: (node: T) => string;
  getChildren: (node: T) => T[];
  /** Non-toolbar row content (numbers, badges, title, inline inputs, …). */
  renderRow: (node: T, depth: number) => React.ReactNode;
  /** Toolbar op dispatch. Caller maps each op to its own mutation. */
  onOp: (op: TreeOp) => void;
  /** Shown when `roots.length === 0`. */
  emptyState: React.ReactNode;
  /**
   * Optional slot rendered directly below a row (indented one level) — used
   * by the entry outline to attach its "add child / add sibling" popover.
   */
  renderAfterRow?: (node: T, depth: number) => React.ReactNode;
}

const HOVER_STYLE_TAG_ID = 'snl-tree-outline-hover-style';

function ensureHoverStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(HOVER_STYLE_TAG_ID)) return;
  const tag = document.createElement('style');
  tag.id = HOVER_STYLE_TAG_ID;
  // Keep hidden controls keyboard-focusable, but not mouse-hit-testable.
  // :focus-within reveals the toolbar before a focused control is operated.
  tag.textContent = TREE_OUTLINE_TOOLBAR_CSS;
  document.head.appendChild(tag);
}

export function TreeOutlineEditor<T>({
  roots,
  getId,
  getChildren,
  renderRow,
  onOp,
  emptyState,
  renderAfterRow
}: TreeOutlineEditorProps<T>): React.ReactElement {
  ensureHoverStyle();
  // Collapse state keyed by node id — persists across re-renders / host pushes
  // as long as this component instance is mounted.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleCollapsed = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (roots.length === 0) {
    return <>{emptyState}</>;
  }

  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {roots.map((node, index) => (
        <TreeRow
          key={getId(node)}
          node={node}
          depth={0}
          siblingIndex={index}
          siblingCount={roots.length}
          hasParent={false}
          getId={getId}
          getChildren={getChildren}
          renderRow={renderRow}
          renderAfterRow={renderAfterRow}
          onOp={onOp}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
        />
      ))}
    </ol>
  );
}

interface TreeRowProps<T> {
  node: T;
  depth: number;
  siblingIndex: number;
  siblingCount: number;
  hasParent: boolean;
  getId: (node: T) => string;
  getChildren: (node: T) => T[];
  renderRow: (node: T, depth: number) => React.ReactNode;
  renderAfterRow?: (node: T, depth: number) => React.ReactNode;
  onOp: (op: TreeOp) => void;
  collapsed: Set<string>;
  onToggleCollapsed: (id: string) => void;
}

function TreeRow<T>({
  node,
  depth,
  siblingIndex,
  siblingCount,
  hasParent,
  getId,
  getChildren,
  renderRow,
  renderAfterRow,
  onOp,
  collapsed,
  onToggleCollapsed
}: TreeRowProps<T>): React.ReactElement {
  const id = getId(node);
  const kids = getChildren(node);
  const hasKids = kids.length > 0;
  const isCollapsed = collapsed.has(id);

  // Indent needs a previous sibling to nest under; outdent needs a parent to
  // escape to. Roots have no parent (outdent disabled) and indent iff a
  // previous root exists.
  const { canIndent, canOutdent, canMoveUp, canMoveDown } =
    treeRowCapabilities(siblingIndex, siblingCount, hasParent);
  const childrenId = `tree-children-${encodeURIComponent(id)}`;

  return (
    <li style={{ marginBottom: '0.15rem' }}>
      <div
        className="snl-outline-row"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          ...treeRowStyle(depth),
          borderBottom:
            '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
          // Depth-tinted background (matches the macro-style pattern): deeper
          // rows get a subtle white wash, capped so deep nesting doesn't blow
          // out. depth=0 stays transparent.
          background:
            depth === 0
              ? 'transparent'
              : `rgba(255,255,255,${Math.min(0.02 * depth, 0.12)})`
        }}
      >
        {hasKids ? (
          <button
            type="button"
            onClick={() => onToggleCollapsed(id)}
            style={disclosureButtonStyle()}
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
            {...treeDisclosureA11y(!isCollapsed, childrenId)}
            title={isCollapsed ? 'Expand' : 'Collapse'}
          >
            {isCollapsed ? '▶' : '▼'}
          </button>
        ) : (
          <span style={{ width: '1.2rem', display: 'inline-block' }} />
        )}

        {renderRow(node, depth)}

        <div
          className="snl-outline-row-toolbar"
          style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}
        >
          <ToolbarButton
            label="+ child"
            title="Add a child entry"
            onClick={() => onOp({ kind: 'addChild', id })}
          />
          <ToolbarButton
            label="+ sibling"
            title="Add a sibling after this entry"
            onClick={() => onOp({ kind: 'addSibling', id })}
          />
          <ToolbarButton
            label="←|"
            title={
              canOutdent
                ? 'Outdent — promote to sibling of parent'
                : 'Outdent unavailable — already at the top level'
            }
            disabled={!canOutdent}
            onClick={() => onOp({ kind: 'outdent', id })}
          />
          <ToolbarButton
            label="→|"
            title={
              canIndent
                ? 'Indent — make this entry a child of its previous sibling'
                : 'Indent unavailable — no previous sibling to nest under'
            }
            disabled={!canIndent}
            onClick={() => onOp({ kind: 'indent', id })}
          />
          <ToolbarButton
            label="↑"
            title={canMoveUp ? 'Move up (swap with previous sibling)' : 'Move up unavailable — already first among siblings'}
            disabled={!canMoveUp}
            onClick={() => onOp({ kind: 'move', id, direction: 'up' })}
          />
          <ToolbarButton
            label="↓"
            title={canMoveDown ? 'Move down (swap with next sibling)' : 'Move down unavailable — already last among siblings'}
            disabled={!canMoveDown}
            onClick={() => onOp({ kind: 'move', id, direction: 'down' })}
          />
          <ToolbarButton
            label="✕"
            title="Delete this entry from the outline (does not delete the shared-pool entry)"
            destructive
            onClick={() => onOp({ kind: 'delete', id })}
          />
        </div>
      </div>

      {renderAfterRow ? renderAfterRow(node, depth) : null}

      {hasKids ? (
        <ol
          id={childrenId}
          hidden={isCollapsed}
          style={{ listStyle: 'none', padding: 0, margin: 0 }}
        >
          {kids.map((kid, kidIndex) => (
            <TreeRow
              key={getId(kid)}
              node={kid}
              depth={depth + 1}
              siblingIndex={kidIndex}
              siblingCount={kids.length}
              hasParent
              getId={getId}
              getChildren={getChildren}
              renderRow={renderRow}
              renderAfterRow={renderAfterRow}
              onOp={onOp}
              collapsed={collapsed}
              onToggleCollapsed={onToggleCollapsed}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function ToolbarButton({
  label,
  title,
  onClick,
  destructive,
  disabled
}: {
  label: string;
  title: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <Button
      variant={destructive ? 'destructive' : 'secondary'}
      size="sm"
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </Button>
  );
}

function disclosureButtonStyle(): React.CSSProperties {
  return {
    width: '1.2rem',
    height: '1.2rem',
    padding: 0,
    fontSize: '0.7rem',
    lineHeight: 1,
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    flexShrink: 0
  };
}
