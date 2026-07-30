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
import type { KindPalette } from '@sjtu-ai4math/snl-basics';
import type { MacroRecord } from './render/macroData';
import {
  macroKindsToPalette,
  type MacroKindPaletteSource
} from './render/macroKindPalette';
import { use_localized, type LocalizedString } from './runtime/useLocalized';
import { resolveMarkdownAssetUrl } from './render/markdownAssets';
import { harvestLibraryHtml } from './export/htmlExport';
import { createEntryDetailLoader } from './export/entryDetailBridge';
import { prerenderPopovers } from './export/popoverPrerender';
import {
  COLLAPSE_GLYPH,
  COLLAPSE_TOGGLE_STYLE,
  collapseToggleAriaLabel,
  collapseToggleTitle
} from '../../src/collapseToggleContract';

function ui(en: string, zhCN: string): LocalizedString {
  return {
    type: 'i18n',
    default_language: 'en',
    values: { en, 'zh-CN': zhCN }
  };
}

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
export interface OutlineNode {
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
      macros?: MacroRecord;
      macroKinds?: MacroKindPaletteSource[];
      assetBaseUri?: string;
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
  const [userMacros, setUserMacros] = useState<MacroRecord | undefined>(undefined);
  const [kindPalette, setKindPalette] = useState<KindPalette | undefined>(undefined);
  const [entryPool, setEntryPool] = useState<EntryOption[]>([]);
  const [assetBaseUri, setAssetBaseUri] = useState('');
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
          setKindPalette(macroKindsToPalette(msg.macroKinds));
          setAssetBaseUri(typeof msg.assetBaseUri === 'string' ? msg.assetBaseUri : '');
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

  const outlineRef = useRef<HTMLDivElement | null>(null);

  const postMessage = (message: unknown): void => {
    apiRef.current?.postMessage(message);
  };

  const exportGenerationRef = useRef(0);

  /**
   * Export the Library the reader is currently looking at.
   *
   * We harvest the live DOM instead of re-rendering: by this point every Entry
   * has settled (SNL context resolved, KaTeX painted), so the snapshot is
   * exactly what the reader sees. A fresh render would have to redo that
   * asynchronous work and could not be captured synchronously anyway —
   * `renderToStaticMarkup` cannot render this tree at all, because the hover
   * popover layer mounts a portal.
   *
   * Callers must expand the outline first: collapse is rendered by *omitting*
   * the subtree, so a collapsed branch is absent from the DOM and would be
   * silently dropped from the export.
   */
  const exportHtml = (slug: string, title: string, entryCount: number): void => {
    const generation = ++exportGenerationRef.current;
    const root = outlineRef.current;
    if (!root) return;
    const { html, assets } = harvestLibraryHtml(root, assetBaseUri);
    const send = (
      popovers: Record<string, string>,
      extraAssets: typeof assets
    ): void => {
      // A later click or navigation owns the export panel now. The old async
      // closure may finish, but it must not overwrite the newer payload.
      if (generation !== exportGenerationRef.current) return;
      const merged = new Map(assets.map((a) => [a.path, a] as const));
      for (const asset of extraAssets) if (!merged.has(asset.path)) merged.set(asset.path, asset);
      postMessage({
        type: 'exportLibraryHtml',
        slug,
        title,
        subtitle: `${entryCount} entr${entryCount === 1 ? 'y' : 'ies'} \u00b7 ${slug}`,
        body: html,
        assets: [...merged.values()],
        popovers
      });
    };

    // Popovers are pre-rendered HERE rather than shipped as a renderer,
    // because an Entry body needs React + KaTeX and the webview already has
    // both loaded (see export/popoverPrerender.tsx). This is asynchronous —
    // each Entry must settle — so the export message is sent afterwards. A
    // failure degrades to a popover-less document instead of aborting.
    void prerenderPopovers(html, {
      loadDetail: createEntryDetailLoader({ postMessage }),
      entries: entryPool,
      userMacros,
      kindPalette,
      markdownImageUrlTransform: assetBaseUri
        ? (source: string) => resolveMarkdownAssetUrl(source, assetBaseUri)
        : undefined,
      isCancelled: () => generation !== exportGenerationRef.current,
      // A corrupt or machine-generated graph must not make Export disappear
      // for hours. This cap is deliberately high enough for real documents;
      // the closure remains transitive within it.
      maxEntries: 1000
    }).then(
      (closure) => {
        // Fragments can embed workspace images too. Reuse the harvest so
        // their srcs are rewritten and their assets collected exactly like
        // the body's, rather than a second near-copy of that logic.
        const popovers: Record<string, string> = {};
        const extra: typeof assets = [];
        for (const [entryId, fragment] of Object.entries(closure.fragments)) {
          const holder = document.createElement('div');
          holder.innerHTML = fragment;
          const harvested = harvestLibraryHtml(holder, assetBaseUri);
          popovers[entryId] = harvested.html;
          extra.push(...harvested.assets);
        }
        send(popovers, extra);
      },
      () => send({}, [])
    );
  };
  const markdownImageUrlTransform = React.useMemo(
    () => assetBaseUri
      ? (source: string) => resolveMarkdownAssetUrl(source, assetBaseUri)
      : undefined,
    [assetBaseUri]
  );

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
      kindPalette={kindPalette}
      markdownImageUrlTransform={markdownImageUrlTransform}
    >
      <main style={PANEL_STYLE}>
        {renderCurrentView(view, {
          postMessage,
          goBack,
          entryPool,
          userMacros,
          kindPalette,
          markdownImageUrlTransform,
          exportHtml,
          outlineRef
        })}
      </main>
    </HoverPopoverProvider>
  );
}

interface RenderCtx {
  postMessage: (m: unknown) => void;
  goBack: () => void;
  entryPool: EntryOption[];
  userMacros: MacroRecord | undefined;
  kindPalette: KindPalette | undefined;
  markdownImageUrlTransform?: (source: string) => string;
  /** Harvest the rendered outline and hand it to the host to write out. */
  exportHtml: (slug: string, title: string, entryCount: number) => void;
  /** Wraps the rendered outline forest; the export harvests from here. */
  outlineRef: React.MutableRefObject<HTMLDivElement | null>;
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
  const title = use_localized(ui('SNL Infoview', 'SNL 信息视图'));
  const loading = use_localized(ui('Loading libraries…', '正在加载文档库……'));
  return (
    <>
      <TopBar title={title} />
      <p style={{ opacity: 0.7 }}>{loading}</p>
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
  const title = use_localized(ui('SNL Infoview', 'SNL 信息视图'));
  const viewGraph = use_localized(ui('View Graph', '查看关系图'));
  const viewGraphTitle = use_localized(ui(
    'Open the pool-wide relationship graph',
    '打开整个条目池的关系图'
  ));
  const editDashboard = use_localized(ui('Edit in Dashboard', '在仪表板中编辑'));
  const editDashboardTitle = use_localized(ui(
    'Open the Dashboard (management surface)',
    '打开仪表板管理界面'
  ));
  const noLibraries = use_localized(ui(
    'No libraries yet. Create one via',
    '尚无文档库。请通过'
  ));
  const noLibrariesSuffix = use_localized(ui(
    'in the Dashboard, or paste an existing',
    '在仪表板中创建，或粘贴已有的'
  ));
  const folderSuffix = use_localized(ui('folder in.', '目录。'));
  return (
    <>
      <TopBar
        title={title}
        subtitle={`${libraries.length} librar${libraries.length === 1 ? 'y' : 'ies'}`}
        actions={
          <>
            <ToolbarButton
              label={viewGraph}
              title={viewGraphTitle}
              onClick={() =>
                ctx.postMessage({ type: 'openInfoviewGraph' })
              }
            />
            <ToolbarButton
              label={editDashboard}
              title={editDashboardTitle}
              onClick={() => ctx.postMessage({ type: 'openDashboard' })}
            />
          </>
        }
      />
      {libraries.length === 0 ? (
        <p style={{ opacity: 0.8 }}>
          {noLibraries} <code>SNL: Create Library</code>{' '}
          {noLibrariesSuffix}{' '}
          <code>.SNL_Doc/libraries/&lt;slug&gt;/</code> {folderSuffix}
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
              label="Export HTML"
              title={`Export library "${slug}" as a static HTML document`}
              onClick={() => {
                // The Entry outline renders collapse by OMITTING the subtree,
                // so a collapsed branch is not in the DOM and cannot be
                // harvested. Expand everything, then export after the paint.
                // (Collapsible BLOCKS don't need this: they keep their body
                // mounted and just set `hidden`, so their fold state is
                // harvested as-is and carried into the exported file.)
                setCollapsed(new Set());
                requestAnimationFrame(() =>
                  ctx.exportHtml(slug, title, totalEntries)
                );
              }}
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
        <LibraryOutline
          nodes={outline}
          collapsed={collapsed}
          toggle={toggle}
          ctx={ctx}
          outlineRef={ctx.outlineRef}
        />
      )}
    </>
  );
}

/**
 * The outline forest — the exact subtree the HTML exporter harvests.
 *
 * Extracted from `LibraryView` so the export tests can render the REAL markup
 * instead of a hand-written imitation of it. 猫猫 2026-07-29: "Library 里条目的
 * Collapse 还是不 work" — the previous export tests built their own markup, so
 * they proved the runtime worked on markup that only resembled this one, and
 * missed that the harvested structure never carried the markers.
 *
 * `outlineRef` is optional so a test can mount this without the panel around it.
 */
export function LibraryOutline({
  nodes,
  collapsed = EMPTY_COLLAPSED,
  toggle = () => {},
  ctx = EXPORT_TEST_CTX,
  outlineRef
}: {
  nodes: OutlineNode[];
  collapsed?: Set<string>;
  toggle?: (nodeId: string) => void;
  ctx?: RenderCtx;
  outlineRef?: React.RefObject<HTMLDivElement | null>;
}): React.ReactElement {
  return (
    <div
      ref={outlineRef}
      style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
    >
      {nodes.map((node) => (
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
  );
}

const EMPTY_COLLAPSED: Set<string> = new Set();

/**
 * Minimal context for rendering the outline outside the panel (export tests).
 * Every field is either inert or empty: no host bridge, no macro pool.
 */
const EXPORT_TEST_CTX = {
  postMessage: () => {},
  goBack: () => {},
  entryPool: [],
  userMacros: [],
  kindPalette: {},
  markdownImageUrlTransform: undefined,
  exportHtml: () => {},
  outlineRef: { current: null }
} as unknown as RenderCtx;

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
      data-snl-collapsible={hasChildren ? '' : undefined}
      data-snl-child-count={hasChildren ? countNodes(node.children) : undefined}
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
            kindPalette={ctx.kindPalette}
            markdownImageUrlTransform={ctx.markdownImageUrlTransform}
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
        <div
          data-snl-subtree=""
          style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
        >
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
      variant="ghost"
      size="sm"
      onClick={onClick}
      title={collapseToggleTitle(collapsed, childCount)}
      aria-label={collapseToggleAriaLabel(collapsed)}
      aria-expanded={!collapsed}
      style={{
        ...(COLLAPSE_TOGGLE_STYLE as React.CSSProperties),
        color: 'var(--vscode-editor-foreground, #ddd)',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer'
      }}
    >
      {collapsed ? COLLAPSE_GLYPH.collapsed : COLLAPSE_GLYPH.expanded}
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
