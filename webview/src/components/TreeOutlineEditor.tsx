// Generic, entity-agnostic tree outline editor (extracted 2026-07-16 from the
// library entry outline in CreateLibraryApp.tsx).
//
// This component owns the *structural* concerns shared by every tree-shaped
// editor in the webviews:
//   - recursion over roots + children (via `getId` / `getChildren`),
//   - per-node collapse / expand state,
//   - the shared hover/focus-revealed TreeNodeActionDashboard,
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
import { IconButton } from './IconButton';
import {
  TreeNodeActionDashboard,
  type TreeNodeActionCommand
} from './TreeNodeActionDashboard';
import {
  TREE_OUTLINE_TOOLBAR_CSS,
  treeDisclosureA11y,
  treeRowCapabilities,
  treeRowStyle
} from './interactionModel';
import {
  defineUiMessages,
  useUiMessages,
  type UiTranslator
} from '../i18n/uiMessages';

const MESSAGES = defineUiMessages(
  'treeOutline',
  { expand: 'Expand', collapse: 'Collapse' },
  { expand: '展开', collapse: '折叠' }
);

/**
 * Structural mutation surfaced by the row toolbar. Generic over the node id;
 * mirrors the counter/entry op vocabulary but carries no seed/payload — the
 * caller owns how each op is realised (immediate mutation vs. add form).
 */
export interface TreeOp {
  kind: 'addParent' | 'addChild' | 'addSibling' | 'move' | 'indent' | 'outdent' | 'delete';
  /** The node the toolbar button was on. For `addChild` this is the parent. */
  id: string;
  /** Only present for `kind === 'move'`. */
  direction?: 'up' | 'down';
  /** Ctrl/Cmd-click on a move button jumps directly to that sibling edge. */
  toEdge?: boolean;
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
  /** Optional domain action inserted before the shared structural dial. */
  renderDashboardLeadingActions?: (node: T, depth: number) => React.ReactNode;
  /** Enable Ctrl/Cmd-click on move buttons to jump to the sibling edge. */
  moveToEdge?: boolean;
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
  renderAfterRow,
  renderDashboardLeadingActions,
  moveToEdge = false
}: TreeOutlineEditorProps<T>): React.ReactElement {
  ensureHoverStyle();
  const t = useUiMessages(MESSAGES);
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
    <ol
      style={{
        listStyle: 'none',
        padding: 0,
        margin: 0,
        containerType: 'inline-size',
        containerName: 'snl-outline'
      }}
    >
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
          renderDashboardLeadingActions={renderDashboardLeadingActions}
          onOp={onOp}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          moveToEdge={moveToEdge}
          t={t}
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
  /** Optional domain action inserted before the shared structural dial. */
  renderDashboardLeadingActions?: (node: T, depth: number) => React.ReactNode;
  onOp: (op: TreeOp) => void;
  collapsed: Set<string>;
  onToggleCollapsed: (id: string) => void;
  moveToEdge: boolean;
  t: UiTranslator<typeof MESSAGES.catalogs.en>;
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
  renderDashboardLeadingActions,
  onOp,
  collapsed,
  onToggleCollapsed,
  moveToEdge,
  t
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
          flexWrap: 'wrap',
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
          <IconButton
            icon={isCollapsed ? 'chevron-right' : 'chevron-down'}
            label={isCollapsed ? t('expand') : t('collapse')}
            variant="ghost"
            size="sm"
            onClick={() => onToggleCollapsed(id)}
            style={disclosureButtonStyle()}
            {...treeDisclosureA11y(!isCollapsed, childrenId)}
            title={isCollapsed ? t('expand') : t('collapse')}
          />
        ) : (
          <span style={{ width: '1.2rem', display: 'inline-block' }} />
        )}

        <div
          className="snl-outline-row-content"
          style={{
            display: 'flex',
            alignItems: 'center',
            flex: '1 1 30rem',
            minWidth: 0,
            gap: '0.4rem',
            flexWrap: 'wrap'
          }}
        >
          {renderRow(node, depth)}
        </div>

        <div
          className="snl-outline-row-toolbar"
          style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}
        >
          <TreeNodeActionDashboard
            capabilities={{
              canMoveUp,
              canMoveDown,
              canIndent,
              canOutdent,
              canAddParent: true,
              canAddChild: true,
              canAddSibling: true,
              canDelete: true
            }}
            leadingActions={renderDashboardLeadingActions?.(node, depth)}
            onAction={(command: TreeNodeActionCommand) => {
              switch (command.kind) {
                case 'addParent': onOp({ kind: 'addParent', id }); break;
                case 'addChild': onOp({ kind: 'addChild', id }); break;
                case 'addSibling': onOp({ kind: 'addSibling', id }); break;
                case 'outdent': onOp({ kind: 'outdent', id }); break;
                case 'indent': onOp({ kind: 'indent', id }); break;
                case 'moveUp':
                  onOp({
                    kind: 'move', id, direction: 'up',
                    toEdge: moveToEdge && command.toEdge
                  });
                  break;
                case 'moveDown':
                  onOp({
                    kind: 'move', id, direction: 'down',
                    toEdge: moveToEdge && command.toEdge
                  });
                  break;
                case 'delete': onOp({ kind: 'delete', id }); break;
              }
            }}
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
              renderDashboardLeadingActions={renderDashboardLeadingActions}
              onOp={onOp}
              collapsed={collapsed}
              onToggleCollapsed={onToggleCollapsed}
              moveToEdge={moveToEdge}
              t={t}
            />
          ))}
        </ol>
      ) : null}
    </li>
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
