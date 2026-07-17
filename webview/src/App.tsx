// SNL Infoview: the READING surface. Two-layer drill-down per cat's
// 2026-07-07 revision:
//
//   Layer 1 (Libraries)  ← default when opened
//   Layer 2 (Library page) ← full outline of one Library, every Entry
//                            rendered inline with expand/collapse to hide
//                            subtrees. Ctrl+click on an entry title still
//                            opens a dedicated per-entry Infoview panel.
//
// Every layer has a "Edit in Dashboard" button (top-right) that jumps to
// the management surface — reader → editor handoff. Layer 2 also has a
// Back button that walks the stack up one step.

import React, { useEffect, useRef, useState } from 'react';
import { getVsCodeApi, PANEL_STYLE, type VsCodeApi } from './vscodeApi';
import { Button } from './components/Button';
import {
  EntrySurface,
  type EntryOption,
  type EntryData,
  type EntryKind
} from './render/EntrySurface';
import { HoverPopoverProvider } from './render/HoverPopoverProvider';
import type { SnlMacroDb } from '@snl-basics/react';

interface LibraryEntry {
  slug: string;
  title: string;
  description?: string;
  hasMeta: boolean;
}

/**
 * One outline node as sent by the host. Mirrors `OutlineNode` in
 * `src/infoviewPanel.ts`. Placeholder nodes (no resolvable Entry) surface
 * as `entry: null`; the webview shows a stub row so the tree structure is
 * still visible.
 */
interface OutlineNode {
  nodeId: string;
  entry: EntryData | null;
  kind: EntryKind | null;
  counterLabel: string | null;
  children: OutlineNode[];
}

type Incoming =
  | { type: 'libraries'; libraries: LibraryEntry[] }
  | {
      type: 'libraryEntries';
      slug: string;
      title: string;
      description?: string;
      entries: EntryOption[];
      outline: OutlineNode[];
      macros?: SnlMacroDb;
      warnings?: string[];
    }
  | undefined;

/** Current position in the 2-layer stack. */
type View =
  | { kind: 'loading' }
  | { kind: 'libraries'; libraries: LibraryEntry[] }
  | {
      kind: 'library';
      slug: string;
      title: string;
      description?: string;
      outline: OutlineNode[];
      warnings: string[];
    };

export function App(): React.ReactElement {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [userMacros, setUserMacros] = useState<SnlMacroDb | undefined>(undefined);
  const [entryPool, setEntryPool] = useState<EntryOption[]>([]);
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as Incoming;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'libraries':
          setView({
            kind: 'libraries',
            libraries: Array.isArray(msg.libraries) ? msg.libraries : []
          });
          break;
        case 'libraryEntries':
          if (msg.macros && typeof msg.macros === 'object') {
            setUserMacros(msg.macros);
          }
          if (Array.isArray(msg.entries)) {
            setEntryPool(msg.entries);
          }
          setView({
            kind: 'library',
            slug: msg.slug,
            title: msg.title,
            description: msg.description,
            outline: Array.isArray(msg.outline) ? msg.outline : [],
            warnings: Array.isArray(msg.warnings) ? msg.warnings : []
          });
          break;
        default:
          break;
      }
    }

    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const postMessage = (message: unknown): void => {
    apiRef.current?.postMessage(message);
  };

  const goBack = (): void => {
    if (view.kind === 'library') {
      // Back from library → libraries root.
      postMessage({ type: 'ready' });
    }
  };

  return (
    <HoverPopoverProvider
      postMessage={postMessage}
      entries={entryPool}
      userMacros={userMacros}
    >
      <main style={PANEL_STYLE}>
        {renderCurrentView(view, {
          postMessage,
          goBack,
          entryPool,
          userMacros
        })}
      </main>
    </HoverPopoverProvider>
  );
}

interface RenderCtx {
  postMessage: (m: unknown) => void;
  goBack: () => void;
  entryPool: EntryOption[];
  userMacros: SnlMacroDb | undefined;
}

function renderCurrentView(view: View, ctx: RenderCtx): React.ReactElement {
  switch (view.kind) {
    case 'loading':
      return <LoadingLayer />;
    case 'libraries':
      return <LibrariesLayer libraries={view.libraries} ctx={ctx} />;
    case 'library':
      return (
        <LibraryLayer
          slug={view.slug}
          title={view.title}
          description={view.description}
          outline={view.outline}
          warnings={view.warnings}
          ctx={ctx}
        />
      );
  }
}

// ---------------------------------------------------------------------------
// Layer components
// ---------------------------------------------------------------------------

function LoadingLayer(): React.ReactElement {
  return (
    <>
      <TopBar title="SNL Infoview" />
      <p style={{ opacity: 0.7 }}>Loading libraries…</p>
    </>
  );
}

function LibrariesLayer({
  libraries,
  ctx
}: {
  libraries: LibraryEntry[];
  ctx: RenderCtx;
}): React.ReactElement {
  return (
    <>
      <TopBar
        title="SNL Infoview"
        subtitle={`${libraries.length} librar${libraries.length === 1 ? 'y' : 'ies'}`}
        actions={
          <>
            <ToolbarButton
              label="View Graph"
              title="Open the pool-wide relationship graph"
              onClick={() =>
                ctx.postMessage({ type: 'openInfoviewGraph' })
              }
            />
            <ToolbarButton
              label="Edit in Dashboard"
              title="Open the Dashboard (management surface)"
              onClick={() => ctx.postMessage({ type: 'openDashboard' })}
            />
          </>
        }
      />
      {libraries.length === 0 ? (
        <p style={{ opacity: 0.8 }}>
          No libraries yet. Create one via <code>SNL: Create Library</code>{' '}
          in the Dashboard, or paste an existing{' '}
          <code>.SNL_Doc/libraries/&lt;slug&gt;/</code> folder in.
        </p>
      ) : (
        <>
          {/* Cat 2026-07-09: hover feedback on Library cards. Pure CSS,
              same pattern as the Library outline hover-toolbar — avoids
              the React-state / pointerEvents drop-bug. */}
          <style>{`
            .snl-library-card {
              transition: background-color 90ms ease-in, border-color 90ms ease-in;
            }
            .snl-library-card:hover,
            .snl-library-card:focus-visible {
              background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.06)) !important;
              border-color: var(--vscode-focusBorder, var(--vscode-contrastActiveBorder, #007fd4)) !important;
            }
          `}</style>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {libraries.map((lib) => (
              <li key={lib.slug} style={{ marginBottom: '0.5rem' }}>
                <Button
                  type="button"
                  className="snl-library-card"
                  onClick={() =>
                    ctx.postMessage({ type: 'selectLibrary', slug: lib.slug })
                  }
                  style={LIBRARY_CARD_STYLE}
                >
                  <div style={{ fontWeight: 600, fontSize: '1rem' }}>
                    {lib.title}
                  </div>
                  <div
                    style={{
                      fontSize: '0.8rem',
                      opacity: 0.7,
                      fontFamily: 'var(--vscode-editor-font-family, monospace)'
                    }}
                  >
                    {lib.slug}
                    {lib.hasMeta ? '' : ' · no meta.json'}
                  </div>
                  {lib.description ? (
                    <div
                      style={{
                        marginTop: '0.35rem',
                        fontSize: '0.85rem',
                        opacity: 0.85
                      }}
                    >
                      {lib.description}
                    </div>
                  ) : null}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/**
 * Layer 2 — the Library page. Renders the outline tree top-to-bottom as a
 * flat sequence of full-Entry cards, one per outline node. Nesting is
 * expressed via left indent + a small expand/collapse control at the
 * corner of each parent card. Ctrl+click on an entry title still spawns a
 * dedicated Infoview panel (Layer 3) for that entry.
 */
function LibraryLayer({
  slug,
  title,
  description,
  outline,
  warnings,
  ctx
}: {
  slug: string;
  title: string;
  description?: string;
  outline: OutlineNode[];
  warnings: string[];
  ctx: RenderCtx;
}): React.ReactElement {
  // Which nodes are currently collapsed. Default = all expanded, so we
  // store the exceptions rather than the whole state. Rebuilt on every
  // `outline` swap so stale nodeIds don't linger.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const outlineKey = React.useMemo(
    () =>
      outline
        .map((n) => n.nodeId)
        .join('|'),
    [outline]
  );
  useEffect(() => {
    setCollapsed(new Set());
  }, [outlineKey, slug]);

  const toggle = React.useCallback((nodeId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  // Count total entries reachable via DFS so the subtitle isn't misleading.
  const totalEntries = React.useMemo(() => countNodes(outline), [outline]);

  return (
    <>
      <TopBar
        title={title}
        subtitle={`${totalEntries} entr${totalEntries === 1 ? 'y' : 'ies'} · ${slug}`}
        actions={
          <>
            <ToolbarButton label="← Back" onClick={ctx.goBack} title="Back to libraries" />
            <ToolbarButton
              label="View Graph"
              title={`Open the induced relationship subgraph for library "${slug}"`}
              onClick={() =>
                ctx.postMessage({
                  type: 'openInfoviewGraphForLibrary',
                  slug
                })
              }
            />
            <ToolbarButton
              label="Edit this Library"
              title={`Open the editor for library "${slug}"`}
              onClick={() =>
                ctx.postMessage({ type: 'editLibrary', slug })
              }
            />
          </>
        }
      />
      {description ? (
        <p style={{ opacity: 0.85, marginTop: 0 }}>{description}</p>
      ) : null}
      {warnings.length > 0 ? <WarningBanner warnings={warnings} /> : null}
      {outline.length === 0 ? (
        <p style={{ opacity: 0.75, fontStyle: 'italic' }}>
          This library has no entries yet. Add some via the Dashboard.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {outline.map((node) => (
            <OutlineTreeNode
              key={node.nodeId}
              node={node}
              depth={0}
              collapsed={collapsed}
              toggle={toggle}
              ctx={ctx}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** Count all descendants (including self) in an outline forest. */
function countNodes(nodes: OutlineNode[]): number {
  let n = 0;
  const walk = (node: OutlineNode): void => {
    n += 1;
    for (const c of node.children) walk(c);
  };
  for (const root of nodes) walk(root);
  return n;
}

// ---------------------------------------------------------------------------
// Outline row — one Entry (or placeholder) + its subtree
// ---------------------------------------------------------------------------

const INDENT_PER_LEVEL = 20; // px

function OutlineTreeNode({
  node,
  depth,
  collapsed,
  toggle,
  ctx
}: {
  node: OutlineNode;
  depth: number;
  collapsed: Set<string>;
  toggle: (nodeId: string) => void;
  ctx: RenderCtx;
}): React.ReactElement {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.nodeId);

  return (
    <div
      style={{
        marginLeft: depth === 0 ? 0 : INDENT_PER_LEVEL,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem'
      }}
    >
      <div style={{ position: 'relative' }}>
        {hasChildren ? (
          <CollapseToggle
            collapsed={isCollapsed}
            onClick={() => toggle(node.nodeId)}
            childCount={countNodes(node.children)}
          />
        ) : null}
        {node.entry ? (
          <EntrySurface
            entry={node.entry}
            kind={node.kind}
            entries={ctx.entryPool}
            postMessage={ctx.postMessage}
            userMacros={ctx.userMacros}
            counterLabel={node.counterLabel ?? undefined}
            disableTitleJump={false}
            onTitleCtrlClick={(entryId) =>
              ctx.postMessage({ type: 'openEntryInfoview', entryId })
            }
          />
        ) : (
          <PlaceholderCard
            nodeId={node.nodeId}
            counterLabel={node.counterLabel}
          />
        )}
      </div>
      {hasChildren && !isCollapsed ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {node.children.map((child) => (
            <OutlineTreeNode
              key={child.nodeId}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              toggle={toggle}
              ctx={ctx}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Small caret in the top-left corner of a parent Entry card. Click flips
 * the collapsed state for that node. Positioned outside the card's left
 * border so it doesn't overlap the entry content or the kind-colored
 * stripe.
 */
function CollapseToggle({
  collapsed,
  onClick,
  childCount
}: {
  collapsed: boolean;
  onClick: () => void;
  childCount: number;
}): React.ReactElement {
  return (
    <Button
      type="button"
      onClick={onClick}
      title={
        collapsed
          ? `Expand ${childCount} sub-entr${childCount === 1 ? 'y' : 'ies'}`
          : `Collapse ${childCount} sub-entr${childCount === 1 ? 'y' : 'ies'}`
      }
      aria-label={collapsed ? 'Expand' : 'Collapse'}
      aria-expanded={!collapsed}
      style={{
        position: 'absolute',
        left: -20,
        top: 8,
        width: 18,
        height: 18,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--vscode-editor-foreground, #ddd)',
        cursor: 'pointer',
        fontSize: '0.85rem',
        opacity: 0.75,
        userSelect: 'none'
      }}
    >
      {collapsed ? '▶' : '▼'}
    </Button>
  );
}

/** Stub row for a graph node that couldn't be resolved to a real Entry. */
function PlaceholderCard({
  nodeId,
  counterLabel
}: {
  nodeId: string;
  counterLabel: string | null;
}): React.ReactElement {
  const label = counterLabel ? `${counterLabel} · ` : '';
  return (
    <section
      style={{
        borderLeft: '5px solid var(--vscode-editorWarning-foreground, #b89500)',
        padding: '0.55rem 0.8rem',
        background: 'transparent',
        opacity: 0.75,
        fontStyle: 'italic',
        fontSize: '0.9rem'
      }}
    >
      {label}(placeholder node · {nodeId})
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared UI bits
// ---------------------------------------------------------------------------

function TopBar({
  title,
  subtitle,
  actions
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '1rem',
        marginBottom: '1rem'
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <h1
          style={{
            margin: '0 0 0.15rem',
            fontSize: '1.25rem',
            wordBreak: 'break-word'
          }}
        >
          {title}
        </h1>
        {subtitle ? (
          <div
            style={{
              opacity: 0.7,
              fontSize: '0.85rem',
              fontFamily: 'var(--vscode-editor-font-family, monospace)'
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

function ToolbarButton({
  label,
  title,
  onClick
}: {
  label: string;
  title?: string;
  onClick: () => void;
}): React.ReactElement {
  // Cat 2026-07-09: unified through shared Button so all clickable
  // affordances share hover / active / focus feedback.
  return (
    <Button variant="secondary" size="md" title={title} onClick={onClick}>
      {label}
    </Button>
  );
}

function WarningBanner({ warnings }: { warnings: string[] }): React.ReactElement {
  return (
    <div
      role="status"
      style={{
        margin: '0 0 1rem',
        padding: '0.55rem 0.75rem',
        borderRadius: '5px',
        border:
          '1px solid var(--vscode-inputValidation-warningBorder, #b89500)',
        background:
          'var(--vscode-inputValidation-warningBackground, rgba(184, 149, 0, 0.15))',
        fontSize: '0.85rem'
      }}
    >
      <div style={{ marginBottom: '0.25rem', fontWeight: 600 }}>
        ⚠️ {warnings.length} warning{warnings.length === 1 ? '' : 's'} in graph.json
      </div>
      <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
        {warnings.slice(0, 5).map((w, i) => (
          <li key={i}>{w}</li>
        ))}
        {warnings.length > 5 ? (
          <li style={{ opacity: 0.7 }}>… {warnings.length - 5} more</li>
        ) : null}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const LIBRARY_CARD_STYLE: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '0.75rem 1rem',
  textAlign: 'left',
  color: 'inherit',
  background:
    'var(--vscode-editorWidget-background, var(--vscode-editor-background, #1e1e1e))',
  border:
    '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
  borderRadius: '6px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '1rem'
};

const TOOLBAR_BUTTON_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  padding: '0.35rem 0.75rem',
  fontFamily: 'inherit',
  fontSize: '0.85rem',
  border:
    '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
  borderRadius: '4px',
  background:
    'var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06))',
  color: 'inherit',
  cursor: 'pointer'
};
