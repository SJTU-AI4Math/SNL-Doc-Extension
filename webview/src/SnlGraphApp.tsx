// SNL Relationship Graph webview (cat 2026-07-10 Phase 2).
//
// Layout: DAG hierarchy, no physics. Sugiyama-lite:
//   1. Break cycles greedily (drop back-edges into a set; render dashed).
//   2. Longest-path layering on the acyclic edges → each node gets a rank.
//   3. Within each layer, order by median of predecessor x's (2 passes).
//   4. Assign x/y in pixel coords with per-layer padding.
//
// Isolated nodes (no incoming AND no outgoing edges) are dropped by the
// host — this view assumes every node participates in ≥ 1 edge.
//
// SVG render: pan (drag empty canvas) + zoom (wheel), clip via a viewport
// <g transform>. Click a node → post `openEntryInfoview`. Click an edge
// label → post `editRelationship`. No physics.

import { edgePath, LAYOUT_METRICS, type GraphNode, type GraphEdge, type LaidOutNode, type Layout } from '../../src/graphLayout';
export { edgePath } from '../../src/graphLayout';
import { GraphLayoutMemoryCache, graphLayoutInput } from '../../src/graphLayoutCacheModel';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useVsCodeApiRef, PANEL_STYLE, type VsCodeApi } from './vscodeApi';
import { useReaderCapabilities } from './reader/ReaderCapabilities';
import { PanelHeader } from './components/PanelHeader';
import { Button } from './components/Button';
import { HoverPopoverProvider, useHoverPopovers, useCurrentPopoverId } from './render/HoverPopoverProvider';
import type { EntryOption } from './render/EntryRender';
import type { MacroRecord } from './render/macroData';
import { wireMacroEntriesToRenderable, type WireMacro } from './render/macroWire';
import {
  macroKindsToPalette,
  type MacroKindPaletteSource
} from './render/macroKindPalette';
import { defineUiMessages, useUiMessages } from './i18n/uiMessages';
import type { Localized } from '@sjtu-ai4math/snl-basics/runtime';
import {
  is_valid_i18n_string,
  resolve_localized_string
} from '../../src/localizedContent';
import { isThemedKindColoring, type ThemedKindColoring } from '../../src/kindColoring';
import { use_content_language, use_preferences_revision } from './runtime/preferencesRuntime';
import { resolveWebviewKindColoring } from './render/kindColoring';

const MESSAGES = defineUiMessages('relationshipGraph', {
  frozenScope: 'Scope: this frozen export only.', frozenEmpty: 'No relationships to display in this frozen export with the current filters.', readerBack: '← Back to reading',
  title: 'SNL Relationship Graph', infoview: 'Infoview', backInfoview: 'Back to SNL Infoview',
  loading: 'Loading graph…', nodes: { arg: 'count', one: '{count} node', other: '{count} nodes' },
  edges: { arg: 'count', one: '{count} edge', other: '{count} edges' },
  backEdges: { arg: 'count', one: '{count} cycle-breaking back-edge (dashed)', other: '{count} cycle-breaking back-edges (dashed)' },
  isolatedHidden: 'isolated nodes hidden', selected: 'selected: {title}',
  instructions: 'scroll to zoom · drag to pan · click node → select · Ctrl+click → open Infoview',
  refreshFailed: 'Refresh failed; showing the last valid graph. {message}',
  empty: 'No relationships to show. Add some from the Dashboard → Relationships section.',
  atomic: 'atomic', composite: 'composite', collapseFilters: 'Collapse filters', expandFilters: 'Expand filters',
  filtersOpen: '▶ Filters', filtersClosed: '◀ Filters', edgesHeading: 'Edges', atomicOnly: 'atomic deps only',
  hidingComposite: 'Currently hiding non-atomic (composite) dependency edges. Uncheck to show every edge.',
  showingAllEdges: 'Currently showing every edge. Check to hide non-atomic dependency edges.',
  entryKinds: 'Entry kinds', all: 'all', none: 'none', allTitle: 'Show every entry kind (reset kind filter)',
  noneTitle: 'Hide every entry kind', noKinds: 'No entry kinds in this graph yet.', unpackaged: 'Unpackaged',
 packageClusterOne: 'Package {name}: 1 entry', packageClusterMany: 'Package {name}: {count} entries',
 relationshipAria: 'Relationship {label}: {from} to {to}', entryAria: 'Entry {title} ({id})'
}, {
  frozenScope: '范围：仅本次冻结导出。', frozenEmpty: '本次冻结导出在当前筛选下无可显示关系。', readerBack: '← 返回阅读',
  title: 'SNL 关系图', infoview: '信息视图', backInfoview: '返回 SNL 信息视图', loading: '正在加载关系图……',
  nodes: '{count} 个节点', edges: '{count} 条边', backEdges: '{count} 条断环回边（虚线）',
  isolatedHidden: '已隐藏孤立节点', selected: '已选择：{title}',
  instructions: '滚动缩放 · 拖动平移 · 单击节点以选择 · Ctrl+单击以打开信息视图',
  refreshFailed: '刷新失败；正在显示上一个有效关系图。{message}',
  empty: '没有可显示的关系。请在仪表板的“关系”部分中添加。', atomic: '原子', composite: '组合',
  collapseFilters: '折叠筛选器', expandFilters: '展开筛选器', filtersOpen: '▶ 筛选器', filtersClosed: '◀ 筛选器',
  edgesHeading: '边', atomicOnly: '仅原子依赖项',
  hidingComposite: '当前已隐藏非原子（组合）依赖边。取消勾选可显示所有边。',
  showingAllEdges: '当前正在显示所有边。勾选可隐藏非原子依赖边。', entryKinds: '条目种类',
  all: '全部', none: '无', allTitle: '显示所有条目种类（重置种类筛选器）', noneTitle: '隐藏所有条目种类',
  noKinds: '此关系图中尚无条目种类。', unpackaged: '未分包',
  packageClusterOne: '包 {name}：1 个条目', packageClusterMany: '包 {name}：{count} 个条目',
  relationshipAria: '关系 {label}：{from} 到 {to}', entryAria: '条目 {title}（{id}）'
});

type GraphNodeWire = Omit<GraphNode, 'title' | 'kind' | 'color' | 'background'> & {
  title: Localized<string, string>;
  kind: Localized<string, string>;
  coloring: ThemedKindColoring | null;
};

type Scope = { mode: 'pool' } | { mode: 'library'; slug: string };

export interface GraphMessage {
  type: 'graph';
  /** Untrusted derived geometry; validated against current projection before use. */
  layoutCache?: unknown;
  scope: Scope;
  title: string;
  nodes: GraphNodeWire[];
  edges: GraphEdge[];
  warnings: string[];
  /** Full pool for popover render (cross-entry macro source resolution). */
  entryOptions?: EntryOption[];
  /** Operation-local package identities for exact lazy Entry reads. */
  entryPackages?: Readonly<Record<string, string>>;
  /** Workspace-wide macros for popover EntryRender. */
  macros?: Record<string, WireMacro>;
  macroKinds?: MacroKindPaletteSource[];
}

interface GraphErrorMessage {
  type: 'graphError';
  scope: Scope;
  title: string;
  message: string;
}

const compareLexically = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
const isScope = (value: unknown): value is Scope =>
  isRecord(value) && (value.mode === 'pool' ||
    (value.mode === 'library' && typeof value.slug === 'string'));
const isGraphNode = (value: unknown): value is GraphNodeWire =>
  isRecord(value) && ['id', 'packageId', 'kindId']
    .every((key) => typeof value[key] === 'string') &&
  (typeof value.kind === 'string' || is_valid_i18n_string(value.kind)) &&
  (value.coloring === null || isThemedKindColoring(value.coloring)) &&
  (typeof value.title === 'string' || is_valid_i18n_string(value.title));
const isGraphEdge = (value: unknown): value is GraphEdge =>
  isRecord(value) && ['id', 'from', 'to', 'label']
    .every((key) => typeof value[key] === 'string') &&
  typeof value.isDependency === 'boolean' &&
  (value.isAtomic === null || typeof value.isAtomic === 'boolean');
const isEntryOption = (value: unknown): value is EntryOption =>
  isRecord(value) && typeof value.id === 'string' &&
  (typeof value.title === 'string' || is_valid_i18n_string(value.title)) &&
  (value.hasContent === undefined || typeof value.hasContent === 'boolean') &&
  (value.snl === undefined || typeof value.snl === 'string');
const isMacroKind = (value: unknown): value is MacroKindPaletteSource =>
  isRecord(value) && typeof value.id === 'string' && isThemedKindColoring(value.coloring);
const isGraphMessage = (value: unknown): value is GraphMessage =>
  isRecord(value) && value.type === 'graph' && isScope(value.scope) &&
  typeof value.title === 'string' && Array.isArray(value.nodes) &&
  value.nodes.every(isGraphNode) && Array.isArray(value.edges) &&
  value.edges.every(isGraphEdge) &&
  new Set(value.nodes.map(n => n.id)).size === value.nodes.length &&
  new Set(value.edges.map(e => e.id)).size === value.edges.length && Array.isArray(value.warnings) &&
  value.warnings.every((warning) => typeof warning === 'string') &&
  (value.entryOptions === undefined || (Array.isArray(value.entryOptions) &&
    value.entryOptions.every(isEntryOption))) &&
  (value.entryPackages === undefined || isStringRecord(value.entryPackages)) &&
  (value.macros === undefined || isRecord(value.macros)) &&
  (value.macroKinds === undefined || (Array.isArray(value.macroKinds) &&
    value.macroKinds.every(isMacroKind)));
const isGraphErrorMessage = (value: unknown): value is GraphErrorMessage =>
  isRecord(value) && value.type === 'graphError' && isScope(value.scope) &&
  typeof value.title === 'string' && typeof value.message === 'string';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Render an entry title as KaTeX in TEXT mode (cat 2026-07-10 §2 clarif:
 * "作为 text 的 KaTeX 不是作为公式的"). The title is wrapped in
 * `\text{…}` so bare characters render as prose; embedded `$…$` islands
 * inside the title still drop into math mode like real LaTeX text.
 * Failures fall back to escaped raw text so a bad title never bricks
 * the graph.
 */
function renderTitleKatex(title: string): string {
  if (!title) return '';
  // Escape `{`, `}`, `\` that would otherwise close the wrapper or
  // introduce runaway commands. `\` is intentionally NOT escaped —
  // titles ARE allowed to contain LaTeX commands (that's the whole
  // point of KaTeX rendering).
  const wrapped = `\\text{${title}}`;
  try {
    return katex.renderToString(wrapped, {
      throwOnError: false,
      displayMode: false,
      output: 'html'
    });
  } catch {
    return title.replace(/[&<>]/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'
    );
  }
}

// ---------------------------------------------------------------------------
// SVG rendering + pan / zoom
// ---------------------------------------------------------------------------

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

/** Selection is represented by a thicker stroke; never replace the themed fill. */
export function graphNodeFill(background: string, _highlighted: boolean): string {
  return background && background !== 'transparent'
    ? background
    : 'var(--vscode-editorWidget-background, #252526)';
}

export function SnlGraphApp({ localDetails, markdownImageUrlTransform, initialAtomicDependenciesOnly = false, layoutMemory }: Pick<React.ComponentProps<typeof HoverPopoverProvider>, 'localDetails' | 'markdownImageUrlTransform'> & { initialAtomicDependenciesOnly?: boolean; layoutMemory?: GraphLayoutMemoryCache } = {}): React.ReactElement {
  const ownLayoutMemory = useMemo(() => new GraphLayoutMemoryCache(), []);
  const extensionApiRef = useVsCodeApiRef();
  const capabilities = useReaderCapabilities();
  const apiRef = useRef(capabilities.api ?? extensionApiRef.current);
  apiRef.current = capabilities.api ?? extensionApiRef.current;
  const contentLanguage = use_content_language();
  const [msg, setMsg] = useState<GraphMessage | null>(null);
  const [graphError, setGraphError] = useState<GraphErrorMessage | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const incoming: unknown = event.data;
      if (isGraphMessage(incoming)) {
        setMsg(incoming);
        setGraphError(null);
      } else if (isGraphErrorMessage(incoming)) {
        // Preserve the last valid snapshot, but make the stale state explicit.
        setGraphError(incoming);
      }
    }
    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const post = useMemo(
    () => (m: unknown): void => apiRef.current?.postMessage(m),
    []
  );
  const kindPalette = useMemo(
    () => macroKindsToPalette(msg?.macroKinds),
    [msg?.macroKinds]
  );
  const userMacros: MacroRecord = useMemo(
    () => wireMacroEntriesToRenderable(
      Object.entries(msg?.macros ?? {}),
      contentLanguage
    ),
    [contentLanguage, msg?.macros]
  );

  // Popover provider needs the pool + macros; both come from the host.
  return (
    <HoverPopoverProvider
      postMessage={post}
      entries={msg?.entryOptions ?? []}
      entryPackages={msg?.entryPackages}
      userMacros={userMacros}
      kindPalette={kindPalette}
      localDetails={localDetails}
      markdownImageUrlTransform={markdownImageUrlTransform}
    >
      <SnlGraphInner layoutMemory={layoutMemory ?? ownLayoutMemory} msg={msg} graphError={graphError} post={post} apiRef={apiRef} initialAtomicDependenciesOnly={initialAtomicDependenciesOnly} />
    </HoverPopoverProvider>
  );
}

function SnlGraphInner({
  layoutMemory,
  msg,
  graphError,
  post,
  apiRef,
  initialAtomicDependenciesOnly
}: {
  layoutMemory: GraphLayoutMemoryCache;
  msg: GraphMessage | null;
  graphError: GraphErrorMessage | null;
  post: (m: unknown) => void;
  apiRef: React.MutableRefObject<VsCodeApi | undefined>;
  initialAtomicDependenciesOnly: boolean;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const { edit } = useReaderCapabilities();
  const contentLanguage = use_content_language();
  const preferencesRevision = use_preferences_revision();
  const popovers = useHoverPopovers();
  const currentPopoverId = useCurrentPopoverId();
  const [vp, setVp] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState<null | {
    startX: number;
    startY: number;
    vpX: number;
    vpY: number;
  }>(null);
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 'all' = every edge; 'atomic-deps' = keep user-authored edges +
   *  dependency edges with isAtomic===true only (cat 2026-07-10 §4). */
  const [depFilter, setDepFilter] = useState<'all' | 'atomic-deps'>(initialAtomicDependenciesOnly ? 'atomic-deps' : 'all');
  /**
   * Cat 2026-07-10 §3: multi-select kind filter. `null` means "no
   * filter — show every kind"; otherwise the Set holds the kindIds
   * currently enabled. Empty Set = hide everything (edge case: user
   * turned every kind off).
   */
  const [kindFilter, setKindFilter] = useState<Set<string> | null>(null);
  /** Sidebar open/closed. Persists across msg updates. */
  const [filtersOpen, setFiltersOpen] = useState<boolean>(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Per-node popover state, keyed by node id. Mirrors the pattern
  // EntryRender uses for macro hovers.
  const nodePopoverRef = useRef<Map<string, string>>(new Map());

  const laid = useMemo<Layout | null>(() => {
    if (!msg) return null;
    // Cat 2026-07-10 §3: apply kind filter FIRST — dropping nodes drops
    // every edge that touched them, so we run kind then the dep-atomic
    // filter which only touches surviving edges.
    const allowKind = (id: string): boolean => {
      if (kindFilter === null) return true;
      const n = msg.nodes.find((x) => x.id === id);
      if (!n) return false;
      return kindFilter.has(n.kindId);
    };
    const kindKeptNodes = msg.nodes.filter((n) => allowKind(n.id));
    const kindKeptIds = new Set(kindKeptNodes.map((n) => n.id));
    const kindKeptEdges = msg.edges.filter(
      (e) => kindKeptIds.has(e.from) && kindKeptIds.has(e.to)
    );
    const filteredEdges =
      depFilter === 'atomic-deps'
        ? kindKeptEdges.filter(
            (e) => !e.isDependency || e.isAtomic === true
          )
        : kindKeptEdges;
    const kept = new Set<string>();
    for (const e of filteredEdges) {
      kept.add(e.from);
      kept.add(e.to);
    }
    const filteredNodes: GraphNode[] = kindKeptNodes
      .filter((n) => kept.has(n.id))
      .map((node) => {
        const { coloring, ...base } = node;
        const colors = coloring
          ? resolveWebviewKindColoring(coloring)
          : { stroke: '#888888', background: 'transparent' };
        return {
          ...base,
          title: resolve_localized_string(node.title, contentLanguage),
          kind: resolve_localized_string(node.kind, contentLanguage),
          color: colors.stroke,
          background: colors.background
        };
      });
    const input = graphLayoutInput(msg.scope.mode === 'library' ? msg.scope.slug : null,
      contentLanguage, filteredNodes, filteredEdges);
    const geometry = layoutMemory.get(input, msg.layoutCache);
    const currentNodes = new Map(filteredNodes.map(node => [node.id, node]));
    return { ...geometry, nodes: geometry.nodes.map(node => ({ ...node,
      color: currentNodes.get(node.id)!.color, background: currentNodes.get(node.id)!.background })) };
  }, [msg, depFilter, kindFilter, contentLanguage, preferencesRevision, layoutMemory]);

  /**
   * Kind universe: the set of distinct kindIds present in the current
   * message, with a human-readable label + swatch color pulled from the
   * first node with that kindId. Sorted by label.
   */
  const kindUniverse = useMemo<
    Array<{ kindId: string; label: string; color: string }>
  >(() => {
    if (!msg) return [];
    const seen = new Map<string, { kindId: string; label: string; color: string }>();
    for (const n of msg.nodes) {
      if (seen.has(n.kindId)) continue;
      const color = n.coloring ? resolveWebviewKindColoring(n.coloring).stroke : '#888888';
      seen.set(n.kindId, {
        kindId: n.kindId,
        label: resolve_localized_string(n.kind, contentLanguage),
        color
      });
    }
    return [...seen.values()].sort((a, b) => compareLexically(a.label, b.label));
  }, [msg, contentLanguage, preferencesRevision]);

  // Fit committed geometry and changed canvas dimensions, never ordinary pan/zoom.
  useEffect(() => {
    if (!laid || !svgRef.current || laid.width <= 0 || laid.height <= 0) return;
    const svg = svgRef.current;
    let live = true;
    let previousWidth = -1, previousHeight = -1;
    const fit = (): void => {
      if (!live) return;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      if (rect.width === previousWidth && rect.height === previousHeight) return;
      previousWidth = rect.width; previousHeight = rect.height;
      const scale = Math.max(0.01, Math.min(1, (rect.width - 40) / laid.width, (rect.height - 40) / laid.height));
      setVp({ x: (rect.width - laid.width * scale) / 2, y: 20, scale });
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit);
    observer?.observe(svg);
    return () => { live = false; observer?.disconnect(); };
  }, [laid]);

  const onWheel = (e: React.WheelEvent<SVGSVGElement>): void => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setVp((prev) => {
      const nextScale = Math.max(0.05, Math.min(5, prev.scale * factor));
      const wx = (mx - prev.x) / prev.scale;
      const wy = (my - prev.y) / prev.scale;
      return {
        scale: nextScale,
        x: mx - wx * nextScale,
        y: my - wy * nextScale
      };
    });
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if ((e.target as Element).tagName === 'svg' || (e.target as Element).id === 'snl-graph-background') {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      setDragging({ startX: e.clientX, startY: e.clientY, vpX: vp.x, vpY: vp.y });
      // Clicking blank canvas clears selection.
      setSelectedId(null);
    }
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!dragging) return;
    setVp({
      x: dragging.vpX + (e.clientX - dragging.startX),
      y: dragging.vpY + (e.clientY - dragging.startY),
      scale: vp.scale
    });
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    setDragging(null);
  };

  if (!msg || !laid) {
    return (
      <main style={PANEL_STYLE}>
        <PanelHeader
          vsApi={apiRef.current}
          title={graphError?.title ?? t('title')}
          back={{
            label: t('infoview'),
            title: t('backInfoview'),
            message: { type: 'nav.openInfoview' }
          }}
        />
        <p style={{ color: graphError ? 'var(--vscode-errorForeground)' : undefined, opacity: graphError ? 1 : 0.7 }}>
          {graphError?.message ?? t('loading')}
        </p>
      </main>
    );
  }

  const nodesById = new Map(laid.nodes.map((n) => [n.id, n]));
  const displayedNodeCount = laid.nodes.length;
  const displayedEdgeCount = laid.edges.length;
  const backEdgeCount = laid.edges.filter((e) => e.isBack).length;

  // Node hover → spawn popover for that entry (cat 2026-07-10 §2).
  const handleNodePointerEnter = (
    n: LaidOutNode,
    ev: React.PointerEvent<SVGGElement>
  ): void => {
    setHoverNodeId(n.id);
    const rect = (ev.currentTarget as Element).getBoundingClientRect();
    const popoverId = popovers.spawn(
      n.id,
      rect,
      ev.clientX,
      ev.clientY,
      currentPopoverId
    );
    nodePopoverRef.current.set(n.id, popoverId);
  };
  const handleNodePointerMove = (
    n: LaidOutNode,
    ev: React.PointerEvent<SVGGElement>
  ): void => {
    const popoverId = nodePopoverRef.current.get(n.id);
    if (popoverId) popovers.updatePointer(popoverId, ev.clientX, ev.clientY);
  };
  const handleNodePointerLeave = (n: LaidOutNode): void => {
    setHoverNodeId((c) => (c === n.id ? null : c));
    const popoverId = nodePopoverRef.current.get(n.id);
    if (popoverId) {
      popovers.cancelUnfrozen(popoverId);
      nodePopoverRef.current.delete(n.id);
    }
  };
  const handleNodeClick = (
    n: LaidOutNode,
    ev: React.MouseEvent<SVGGElement>
  ): void => {
    if (ev.ctrlKey || ev.metaKey) {
      // Ctrl/Meta+Click → open this entry's own Infoview panel
      // (cat 2026-07-10 §4).
      post({ type: 'openEntryInfoview', entryId: n.id });
      return;
    }
    // Plain click → select (cat 2026-07-10 §3).
    setSelectedId((prev) => (prev === n.id ? null : n.id));
  };

  return (
    <main
      style={{
        ...PANEL_STYLE,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        boxSizing: 'border-box'
      }}
    >
      <div
        style={{
          padding: '0 0.75rem',
          '--snl-panel-header-top': '0px'
        } as React.CSSProperties}
      >
        <PanelHeader
          vsApi={apiRef.current}
          title={edit ? msg.title : t('title')}
          subtitle={edit ? undefined : t('frozenScope')}
          back={{
            label: t(edit ? 'infoview' : 'readerBack'),
            title: t(edit ? 'backInfoview' : 'readerBack'),
            message: { type: 'nav.openInfoview' }
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '1rem',
          padding: '0 0.75rem 0.4rem'
        }}
      >
        <div>
          <div style={{ opacity: 0.7, fontSize: '0.8rem' }}>
            {t('nodes', { count: displayedNodeCount })} ·{' '}
            {t('edges', { count: displayedEdgeCount })}
            {backEdgeCount > 0
              ? ` · ${t('backEdges', { count: backEdgeCount })}`
              : ''}
            {` · ${t('isolatedHidden')}`}
            {selectedId
              ? ` · ${t('selected', { title: nodesById.get(selectedId)?.title ?? selectedId })}`
              : ''}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>
            {t('instructions')}
          </div>
        </div>
      </div>
      {graphError ? (
        <div
          role="alert"
          style={{
            margin: '0 0.75rem 0.5rem', padding: '0.4rem 0.6rem',
            border: '1px solid var(--vscode-inputValidation-errorBorder, #be1100)',
            background: 'var(--vscode-inputValidation-errorBackground, rgba(190,17,0,0.12))',
            color: 'var(--vscode-errorForeground)'
          }}
        >
          {t('refreshFailed', { message: graphError.message })}
        </div>
      ) : null}
      {msg.warnings.length > 0 ? (
        <div
          style={{
            margin: '0 0.75rem 0.5rem',
            padding: '0.4rem 0.6rem',
            borderRadius: '3px',
            border:
              '1px solid var(--vscode-editorWarning-foreground, #d7a35a)',
            color: 'var(--vscode-editorWarning-foreground, #d7a35a)',
            fontSize: '0.85rem'
          }}
        >
          {msg.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      ) : null}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* Cat 2026-07-10 §3: Filters sidebar. Absolute-positioned on
            the right edge of the graph container so it floats over the
            SVG without stealing pan area. Collapsed = a single arrow
            button; expanded = filter controls stack. */}
        <FiltersSidebar
          open={filtersOpen}
          onToggle={() => setFiltersOpen((v) => !v)}
          depFilter={depFilter}
          onDepFilterChange={setDepFilter}
          kindUniverse={kindUniverse}
          kindFilter={kindFilter}
          onKindFilterChange={setKindFilter}
        />
        {displayedNodeCount === 0 ? (
          <div
            style={{
              padding: '2rem',
              opacity: 0.75,
              fontStyle: 'italic',
              textAlign: 'center'
            }}
          >
            {t(edit ? 'empty' : 'frozenEmpty')}
          </div>
        ) : (
          <svg
            ref={svgRef}
            width="100%"
            height="100%"
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{
              cursor: dragging ? 'grabbing' : 'grab',
              background:
                'var(--vscode-editor-background, var(--vscode-editorWidget-background, #1e1e1e))',
              display: 'block'
            }}
          >
            <defs>
              <marker
                id="snl-graph-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path
                  d="M 0 0 L 10 5 L 0 10 z"
                  fill="var(--vscode-editor-foreground, #ddd)"
                  opacity="0.7"
                />
              </marker>
            </defs>
            <rect
              id="snl-graph-background"
              x={0}
              y={0}
              width="100%"
              height="100%"
              fill="transparent"
            />
            <g
              transform={`translate(${vp.x} ${vp.y}) scale(${vp.scale})`}
            >
              {/* Package lanes paint behind edges and nodes. They use only
                  VS Code semantic tokens. Planned follow-up: refine graph
                  colors globally across dark/light/high-contrast themes. */}
              {laid.clusters.map((cluster) => {
                const name = cluster.packageId === '_unpackaged'
                  ? t('unpackaged')
                  : cluster.packageId;
                const ariaLabel = cluster.nodeCount === 1
                  ? t('packageClusterOne', { name })
                  : t('packageClusterMany', { name, count: cluster.nodeCount });
                return (
                  <g
                    key={cluster.packageId}
                    role="group"
                    aria-label={ariaLabel}
                    data-package-id={cluster.packageId}
                    data-cluster-bounds={`${cluster.x},${cluster.y},${cluster.w},${cluster.h}`}
                    style={{ pointerEvents: 'none' }}
                  >
                    <rect
                      x={cluster.x}
                      y={cluster.y}
                      width={cluster.w}
                      height={cluster.h}
                      rx={8}
                      ry={8}
                      fill="var(--vscode-editorWidget-background)"
                      fillOpacity={0.24}
                      stroke="var(--vscode-panel-border, var(--vscode-contrastBorder))"
                      strokeWidth={1.5}
                    />
                    <text
                      x={cluster.x + LAYOUT_METRICS.CLUSTER_PADDING_X}
                      y={cluster.y + 22}
                      fill="var(--vscode-foreground)"
                      fontSize={12}
                      fontWeight={600}
                      fontFamily="var(--vscode-font-family)"
                    >
                      {name}
                    </text>
                  </g>
                );
              })}
              {/* Edges first so nodes paint on top. */}
              {laid.edges.map((e) => {
                const from = nodesById.get(e.from)!;
                const to = nodesById.get(e.to)!;
                const { d } = edgePath(from, to, e.waypoints);
                const hovered = hoverEdgeId === e.id;
                const incidentToSelected =
                  selectedId !== null &&
                  (e.from === selectedId || e.to === selectedId);
                const nonAtomicDep = e.isDependency && e.isAtomic === false;
                const baseOpacity = nonAtomicDep ? 0.28 : 0.55;
                const opacity = incidentToSelected || hovered ? 1 : baseOpacity;
                return (
                  <g
                    key={e.id}
                    role={edit ? 'button' : 'img'}
                    tabIndex={edit ? 0 : undefined}
                    aria-label={t('relationshipAria', { label: e.label || e.id, from: e.from, to: e.to })}
                    onPointerEnter={() => setHoverEdgeId(e.id)}
                    onPointerLeave={() =>
                      setHoverEdgeId((c) => (c === e.id ? null : c))
                    }
                    style={{ cursor: edit ? 'pointer' : 'default' }}
                    onClick={edit ? () => post({ type: 'editRelationship', id: e.id }) : undefined}
                    onFocus={() => setHoverEdgeId(e.id)}
                    onBlur={() => setHoverEdgeId((c) => (c === e.id ? null : c))}
                    onKeyDown={(event) => {
                      if (!edit || (event.key !== 'Enter' && event.key !== ' ')) return;
                      event.preventDefault();
                      post({ type: 'editRelationship', id: e.id });
                    }}
                  >
                    <title>
                      {e.label}
                      {e.isDependency && e.isAtomic !== null
                        ? ` (${e.isAtomic ? t('atomic') : t('composite')})`
                        : ''}
                      {'\n'}{e.from} → {e.to}
                    </title>
                    <path
                      d={d}
                      fill="none"
                      stroke="var(--vscode-editor-foreground, #ddd)"
                      strokeOpacity={opacity}
                      strokeWidth={incidentToSelected || hovered ? 2 : 1.2}
                      strokeDasharray={e.isBack ? '5 4' : undefined}
                      markerEnd="url(#snl-graph-arrow)"
                    />
                  </g>
                );
              })}
              {/* Nodes */}
              {laid.nodes.map((n) => {
                const isHovered = hoverNodeId === n.id;
                const isSelected = selectedId === n.id;
                const highlighted = isHovered || isSelected;
                const stroke = n.color;
                const fill = graphNodeFill(n.background, highlighted);
                const titleHtml = renderTitleKatex(n.title);
                return (
                  <g
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    aria-label={t('entryAria', { title: n.title || n.id, id: n.id })}
                    data-package-id={n.packageId}
                    transform={`translate(${n.x} ${n.y})`}
                    style={{ cursor: 'pointer' }}
                    onPointerEnter={(ev) => handleNodePointerEnter(n, ev)}
                    onPointerMove={(ev) => handleNodePointerMove(n, ev)}
                    onPointerLeave={() => handleNodePointerLeave(n)}
                    onClick={(ev) => handleNodeClick(n, ev)}
                    onFocus={() => setHoverNodeId(n.id)}
                    onBlur={() => setHoverNodeId((c) => (c === n.id ? null : c))}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      if (event.ctrlKey || event.metaKey) {
                        post({ type: 'openEntryInfoview', entryId: n.id });
                        return;
                      }
                      setSelectedId((previous) => previous === n.id ? null : n.id);
                    }}
                  >
                    {/* Cat 2026-07-10 §3: dropped the native <title>
                        tooltip — the full-Entry hover popover already
                        carries every fact this used to duplicate. */}
                    <rect
                      width={n.w}
                      height={n.h}
                      rx={4}
                      ry={4}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={highlighted ? 3.5 : 2}
                    />
                    <text
                      x={10}
                      y={16}
                      fontSize={11}
                      fontFamily="var(--vscode-editor-font-family, monospace)"
                      opacity={0.85}
                      fill={stroke}
                    >
                      {n.kind}
                    </text>
                    {/* Cat 2026-07-10 §2: entry title rendered as raw
                        KaTeX (LaTeX text-mode fragment). Uses
                        foreignObject to embed KaTeX HTML output inside
                        the SVG — KaTeX SVG output isn't a stable API. */}
                    <foreignObject
                      x={10}
                      y={20}
                      width={n.w - 20}
                      height={n.h - 22}
                      style={{ pointerEvents: 'none' }}
                    >
                      <div
                        style={{
                          fontSize: '13px',
                          fontWeight: 600,
                          color: stroke,
                          lineHeight: '20px',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis'
                        }}
                        dangerouslySetInnerHTML={{ __html: titleHtml }}
                      />
                    </foreignObject>
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>
    </main>
  );
}

/**
 * Right-edge Filters sidebar (cat 2026-07-10 §3).
 *
 * Two filter groups, both live-applied:
 *
 *   - **Edges**: the atomic-only toggle (previously the standalone
 *     header button). Kept as a boolean because that's what it is.
 *   - **Entry kinds**: one checkbox per kindId present in the graph,
 *     with a kind-colored swatch. `null` filter (default) = all kinds
 *     visible; toggling a kind switches to "specific set" mode.
 *
 * Collapsed state: a single tab pinned to the right edge with a `◀`
 * arrow. Expanded state: the tab flips to `▶` and a ~220px panel
 * slides in.
 */
function FiltersSidebar({
  open,
  onToggle,
  depFilter,
  onDepFilterChange,
  kindUniverse,
  kindFilter,
  onKindFilterChange
}: {
  open: boolean;
  onToggle: () => void;
  depFilter: 'all' | 'atomic-deps';
  onDepFilterChange: (v: 'all' | 'atomic-deps') => void;
  kindUniverse: Array<{ kindId: string; label: string; color: string }>;
  kindFilter: Set<string> | null;
  onKindFilterChange: (v: Set<string> | null) => void;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const isKindEnabled = (id: string): boolean =>
    kindFilter === null ? true : kindFilter.has(id);

  const toggleKind = (id: string): void => {
    // First toggle off `null` = start from the full set, then flip.
    const base =
      kindFilter === null
        ? new Set<string>(kindUniverse.map((k) => k.kindId))
        : new Set<string>(kindFilter);
    if (base.has(id)) base.delete(id);
    else base.add(id);
    // If every kind is enabled again, collapse back to null so the
    // filter code short-circuits.
    const allOn =
      kindUniverse.length > 0 &&
      kindUniverse.every((k) => base.has(k.kindId));
    onKindFilterChange(allOn ? null : base);
  };
  const activeKindCount =
    kindFilter === null ? kindUniverse.length : kindFilter.size;
  const totalKindCount = kindUniverse.length;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        alignItems: 'stretch',
        pointerEvents: 'none', // let SVG receive pans; children re-enable
        zIndex: 20
      }}
    >
      {/* Tab handle — always visible so the sidebar can be found. */}
      <Button
        type="button"
        onClick={onToggle}
        title={t(open ? 'collapseFilters' : 'expandFilters')}
        style={{
          pointerEvents: 'auto',
          alignSelf: 'flex-start',
          marginTop: '0.5rem',
          padding: '0.4rem 0.35rem',
          background:
            'var(--vscode-editorWidget-background, rgba(30,30,30,0.9))',
          border:
            '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
          borderRight: 'none',
          borderRadius: '3px 0 0 3px',
          color: 'inherit',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: '0.8rem',
          writingMode: 'vertical-rl'
        }}
      >
        {t(open ? 'filtersOpen' : 'filtersClosed')}
      </Button>
      {open ? (
        <div
          style={{
            pointerEvents: 'auto',
            width: '240px',
            padding: '0.8rem',
            overflow: 'auto',
            background:
              'var(--vscode-editorWidget-background, rgba(30,30,30,0.95))',
            borderLeft:
              '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))'
          }}
        >
          <h3
            style={{
              margin: '0 0 0.4rem',
              fontSize: '0.85rem',
              opacity: 0.75,
              textTransform: 'uppercase',
              letterSpacing: '0.06em'
            }}
          >
            {t('edgesHeading')}
          </h3>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.85rem',
              cursor: 'pointer',
              marginBottom: '0.5rem'
            }}
            title={
              depFilter === 'atomic-deps'
                ? t('hidingComposite')
                : t('showingAllEdges')
            }
          >
            <input
              type="checkbox"
              checked={depFilter === 'atomic-deps'}
              onChange={(e) =>
                onDepFilterChange(e.target.checked ? 'atomic-deps' : 'all')
              }
            />
            <span>{t('atomicOnly')}</span>
          </label>

          <h3
            style={{
              margin: '0.9rem 0 0.4rem',
              fontSize: '0.85rem',
              opacity: 0.75,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between'
            }}
          >
            <span>{t('entryKinds')}</span>
            <span style={{ opacity: 0.55, fontSize: '0.7rem' }}>
              {activeKindCount}/{totalKindCount}
            </span>
          </h3>
          <div
            style={{
              display: 'flex',
              gap: '0.4rem',
              marginBottom: '0.4rem'
            }}
          >
            <Button
              type="button"
              onClick={() => onKindFilterChange(null)}
              style={smallLinkBtn}
              title={t('allTitle')}
            >
              {t('all')}
            </Button>
            <Button
              type="button"
              onClick={() => onKindFilterChange(new Set())}
              style={smallLinkBtn}
              title={t('noneTitle')}
            >
              {t('none')}
            </Button>
          </div>
          {totalKindCount === 0 ? (
            <p style={{ opacity: 0.55, fontSize: '0.8rem', margin: 0 }}>
              {t('noKinds')}
            </p>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '0.2rem'
              }}
            >
              {kindUniverse.map((k) => {
                const on = isKindEnabled(k.kindId);
                return (
                  <li key={k.kindId}>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        fontSize: '0.85rem',
                        cursor: 'pointer',
                        opacity: on ? 1 : 0.5
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleKind(k.kindId)}
                      />
                      <span
                        style={{
                          display: 'inline-block',
                          width: '0.7rem',
                          height: '0.7rem',
                          borderRadius: '2px',
                          background: k.color,
                          border: '1px solid rgba(0,0,0,0.25)'
                        }}
                      />
                      <span>{k.label || k.kindId}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

const smallLinkBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--vscode-textLink-foreground, #4ea3f5)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '0.75rem',
  padding: 0,
  textDecoration: 'underline'
};
