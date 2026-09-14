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

import { DEFAULT_LAYOUT_PARAMETERS, edgePath, graphNodePresentation, TITLE_VIEWPORT_MARGIN, type GraphLayoutMode, type GraphLayerPacking, type GraphNodeMode, type EdgePoint, CARD_RADIUS, type NodeShape, type LaidOutCluster, LAYOUT_METRICS, type GraphNode, type GraphEdge, type LaidOutNode, type Layout } from '../../src/graphLayout';
export { edgePath, layout, graphNodePresentation } from '../../src/graphLayout';
import { GraphLayoutMemoryCache, graphLayoutInput } from '../../src/graphLayoutCacheModel';
import React, { useCallback, useEffect, useLayoutEffect, useInsertionEffect, useMemo, useRef, useState } from 'react';
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
  filtersOpen: '▶ Filters', filtersClosed: '◀ Filters', edgesHeading: 'Edges', showRelationships: 'Show relationships', atomicOnly: 'atomic deps only',
  hidingComposite: 'Excludes non-atomic dependency edges from the graph. Uncheck to include them; relationship visibility is controlled separately.',
  showingAllEdges: 'Includes all relationship types in the graph. Check to exclude non-atomic dependency edges; relationship visibility is controlled separately.',
  entryKinds: 'Entry kinds', all: 'all', none: 'none', allTitle: 'Show every entry kind (reset kind filter)',
  noneTitle: 'Hide every entry kind', noKinds: 'No entry kinds in this graph yet.', unpackaged: 'Unpackaged',
 packageClusterOne: 'Package {name}: 1 entry', packageClusterMany: 'Package {name}: {count} entries',
 relationshipAria: 'Relationship {label}: {from} to {to}', entryAria: 'Entry {title} ({id})',
 layout: 'Layout', rectangle: 'Rectangle', radialInward: 'Radial inward', radialOutward: 'Radial outward',
 layerPacking: 'Layer packing', compactBands: 'Compact bands', strictRings: 'Strict rings',
 packingHelp: 'Radial layouts only. Compact bands stagger nodes within each layer. Strict rings keep one radius per layer, with more empty space. Rectangle ignores this choice; refresh preserves it in this panel only.',
 nodeMode: 'Nodes', autoNodes: 'Auto', alwaysTitle: 'Always title', titleThreshold: 'Title threshold',
 previewFilters: 'Temporary filters', filterHelp: 'Match every filter (AND); any selected value within each filter (OR).',
 addFilter: 'Add filter', clearFilters: 'Clear filters', removeFilter: 'Remove filter',
 filterNumber: 'Filter {id}', filterKind: 'Filter kind', entryKindFilter: 'Entry kind',
 enabledFilter: 'Enabled', disabledFilter: 'Disabled — ignored', draftFilter: 'Draft — no values; ignored',
 filterValues: 'Values (OR)', andFilters: 'AND', relationshipFilter: 'Relationship',
 filterDirection: 'Direction', incomingFilter: 'Incoming', outgoingFilter: 'Outgoing', eitherFilter: 'Either direction',
 emptyRelationshipLabel: '(empty label)', unavailableFilterValue: '{value} (unavailable)',
 coloringSettings: 'Coloring settings', coloringMode: 'Coloring mode', kindColoring: 'EntryKind', tagColoring: 'Tag', packageColoring: 'EntryPackage',
 packageColorHelp: 'Stable colors by full EntryPackage identity; unpackaged entries use their themed EntryKind color. Temporary to this panel.',
 addColorMapping: 'Add color mapping', removeColorMapping: 'Remove color mapping',
 colorMapping: 'Color mapping {id}', tag: 'Tag', color: 'Color', chooseTag: 'Choose a tag', emptyTag: '(empty tag)',
 moveUp: 'Move up', moveDown: 'Move down', colorHelp: 'First matching tag from top to bottom wins; otherwise use the current theme’s EntryKind color. Temporary to this panel.',
 filteredEmpty: 'No connected nodes match. Adjust or clear filters in the sidebar.'
}, {
  frozenScope: '范围：仅本次冻结导出。', frozenEmpty: '本次冻结导出在当前筛选下无可显示关系。', readerBack: '← 返回阅读',
  title: 'SNL 关系图', infoview: '信息视图', backInfoview: '返回 SNL 信息视图', loading: '正在加载关系图……',
  nodes: '{count} 个节点', edges: '{count} 条边', backEdges: '{count} 条断环回边（虚线）',
  isolatedHidden: '已隐藏孤立节点', selected: '已选择：{title}',
  instructions: '滚动缩放 · 拖动平移 · 单击节点以选择 · Ctrl+单击以打开信息视图',
  refreshFailed: '刷新失败；正在显示上一个有效关系图。{message}',
  empty: '没有可显示的关系。请在仪表板的“关系”部分中添加。', atomic: '原子', composite: '组合',
  collapseFilters: '折叠筛选器', expandFilters: '展开筛选器', filtersOpen: '▶ 筛选器', filtersClosed: '◀ 筛选器',
  edgesHeading: '边', showRelationships: '显示关系', atomicOnly: '仅原子依赖项',
  hidingComposite: '从关系图中排除非原子依赖边。取消勾选可纳入这些边；关系的显示由独立开关控制。',
  showingAllEdges: '关系图包含所有关系类型。勾选可排除非原子依赖边；关系的显示由独立开关控制。', entryKinds: '条目种类',
  all: '全部', none: '无', allTitle: '显示所有条目种类（重置种类筛选器）', noneTitle: '隐藏所有条目种类',
  noKinds: '此关系图中尚无条目种类。', unpackaged: '未分包',
  packageClusterOne: '包 {name}：1 个条目', packageClusterMany: '包 {name}：{count} 个条目',
  relationshipAria: '关系 {label}：{from} 到 {to}', entryAria: '条目 {title}（{id}）',
  layout: '布局', rectangle: '矩形平铺', radialInward: '向内环铺', radialOutward: '向外环铺',
  layerPacking: '同层铺排', compactBands: '紧凑环带', strictRings: '严格同心圆',
  packingHelp: '仅用于环铺。紧凑环带允许同层节点径向错排；严格同心圆保持同层同半径，但留白较多。矩形布局忽略此选项；刷新保留，仅当前面板有效。',
  nodeMode: '节点', autoNodes: '自动', alwaysTitle: '始终显示标题', titleThreshold: '标题阈值',
  previewFilters: '临时筛选', filterHelp: '满足每个筛选条件（AND）；每个条件内满足任一选值（OR）。',
  addFilter: '添加筛选', clearFilters: '清空筛选', removeFilter: '移除筛选',
  filterNumber: '筛选 {id}', filterKind: '筛选种类', entryKindFilter: '条目种类',
  enabledFilter: '启用', disabledFilter: '已停用 — 不参与筛选', draftFilter: '草稿 — 未选择值，不参与筛选',
  filterValues: '选值（OR）', andFilters: 'AND（且）', relationshipFilter: '关系',
  filterDirection: '方向', incomingFilter: '入边', outgoingFilter: '出边', eitherFilter: '任意方向',
  emptyRelationshipLabel: '（空标签）', unavailableFilterValue: '{value}（不可用）',
  coloringSettings: '着色设置', coloringMode: '着色模式', kindColoring: 'EntryKind', tagColoring: 'Tag', packageColoring: 'EntryPackage',
  packageColorHelp: '按完整 EntryPackage 标识稳定着色；未分包条目使用当前主题的 EntryKind 默认色。仅当前面板有效。',
  addColorMapping: '添加颜色映射', removeColorMapping: '移除颜色映射',
  colorMapping: '颜色映射 {id}', tag: '标签', color: '颜色', chooseTag: '选择标签', emptyTag: '（空标签）',
  moveUp: '上移', moveDown: '下移', colorHelp: '从上到下取首个命中的标签；未命中则使用当前主题的 EntryKind 默认色。仅当前面板有效。',
  filteredEmpty: '没有匹配的相连节点。请在侧栏中调整或清空筛选条件。'
});

type GraphNodeWire = Omit<GraphNode, 'title' | 'kind' | 'color' | 'background'> & {
  title: Localized<string, string>;
  kind: Localized<string, string>;
  coloring: ThemedKindColoring | null;
  tags?: string[];
};

type Scope = { mode: 'pool' } | { mode: 'library'; slug: string };

/** Temporary mounted-panel state only; never part of the host wire schema. */
interface GraphTagColorRule {
  id: number;
  tag: string | null; // null is a draft; the empty string is a real tag.
  color: string;
}

/** Paint-only lookup: rule order wins, independently of Entry tag order. */
export function graphTagColor(tags: readonly string[] | undefined, rules: readonly GraphTagColorRule[]): string | undefined {
  return rules.find(rule => rule.tag !== null && tags?.includes(rule.tag))?.color;
}

// Package paint is keyed by exact host identity, never filtered order or kind.
// The deterministic hue palette survives refresh/remount and scope changes;
// black/white text below provides contrast on its opaque swatches in either theme.
function graphPackageColor(packageId: string): string | undefined {
  if (!packageId || packageId === '_unpackaged') return undefined;
  let hash = 2166136261;
  for (let i = 0; i < packageId.length; i++) hash = Math.imul(hash ^ packageId.charCodeAt(i), 16777619);
  const hue = (hash >>> 0) % 360;
  // HSL palette (lightness .65, chroma .46), returned as hex like Tag colors.
  const channel = (offset: number): string => {
    const k = (offset + hue / 30) % 12;
    return Math.round(255 * (.65 - .23 * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

type GraphColoringMode = 'kind' | 'tag' | 'package';

function graphTagTextColor(color: string): string {
  const linear = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
}

interface GraphFilterClause {
  id: number;
  kind: 'entry-kind' | 'relationship' | 'tag';
  direction: 'incoming' | 'outgoing' | 'either';
  enabled: boolean;
  values: string[];
}

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
  (value.tags === undefined || (Array.isArray(value.tags) && value.tags.every(tag => typeof tag === 'string'))) &&
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

interface ContentBounds { minX: number; minY: number; maxX: number; maxY: number }

/** Actual title-card rectangles plus the convex hull of the existing cubic
 * edge controls (including self loops). Decorative lane/sector canvases are
 * deliberately excluded. Parsing is safe here: edgePath emits only M/C pairs. */
export function graphContentBounds(laid: Layout, includeEdges = true): ContentBounds {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const include = (x: number, y: number): void => {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
  };
  for (const n of laid.nodes) { include(n.x - 2, n.y - 2); include(n.x + n.w + 2, n.y + n.h + 2); }
  if (!includeEdges) return bounds;
  const byId = new Map(laid.nodes.map(n => [n.id, n]));
  for (const e of laid.edges) {
    const { d } = edgePath(byId.get(e.from)!, byId.get(e.to)!, e.waypoints, { fromShape: 'title', toShape: 'title' }, laid);
    const values = d.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
    for (let i = 0; i < values.length; i += 2) include(values[i], values[i + 1]);
  }
  return bounds;
}

const packageLabelAnchor = (cluster: LaidOutCluster): EdgePoint => ({
  x: cluster.sector?.labelX ?? cluster.x + LAYOUT_METRICS.CLUSTER_PADDING_X,
  y: cluster.sector?.labelY ?? cluster.y + 22
});

/** Keep titles horizontal, with their nearest corner/edge on the outer arc.
 * Axis tolerance avoids flipping alignment on trigonometric roundoff. */
function radialPackageLabelOrientation(angle: number) {
  const cos = Math.cos(angle), sin = Math.sin(angle), epsilon = 1e-10;
  return {
    textAnchor: Math.abs(cos) < epsilon ? 'middle' as const : cos < 0 ? 'end' as const : 'start' as const,
    dominantBaseline: Math.abs(sin) < epsilon ? 'central' as const : sin < 0 ? 'text-after-edge' as const : 'text-before-edge' as const
  };
}

const GRAPH_MIN_ZOOM = 1e-5;
const GRAPH_MAX_ZOOM = 100;
const clampGraphZoom = (scale: number): number => Math.max(GRAPH_MIN_ZOOM, Math.min(GRAPH_MAX_ZOOM, scale));

/** Fixed-screen labels contribute pixels, not world-sized phantom circles. */
export function fitGraphViewport(bounds: ContentBounds, width: number, height: number,
  labels: Array<EdgePoint & { width: number; height?: number; centered: boolean; angle?: number }> = []): Viewport {
  // Horizontal glyph extents stay in screen pixels. Radial labels extend into
  // their outward quadrant; rectangle labels retain alphabetic-baseline bounds.
  // Only the world anchor is multiplied by scale.
  const labelBounds = labels.map(label => {
    if (label.angle === undefined) {
      const left = label.centered ? -label.width / 2 : 0;
      return { ...label, minX: left, maxX: left + label.width, minY: -14, maxY: 4 };
    }
    const { textAnchor, dominantBaseline } = radialPackageLabelOrientation(label.angle);
    const labelHeight = label.height && Number.isFinite(label.height) && label.height > 0 ? label.height : 18;
    const left = textAnchor === 'middle' ? -label.width / 2 : textAnchor === 'end' ? -label.width : 0;
    const top = dominantBaseline === 'central' ? -labelHeight / 2 : dominantBaseline === 'text-after-edge' ? -labelHeight : 0;
    return { ...label, minX: left, maxX: left + label.width, minY: top, maxY: top + labelHeight };
  });
  const screenBounds = (scale: number): ContentBounds => {
    let minX = bounds.minX * scale, maxX = bounds.maxX * scale;
    let minY = bounds.minY * scale, maxY = bounds.maxY * scale;
    for (const label of labelBounds) {
      minX = Math.min(minX, label.x * scale + label.minX); maxX = Math.max(maxX, label.x * scale + label.maxX);
      minY = Math.min(minY, label.y * scale + label.minY); maxY = Math.max(maxY, label.y * scale + label.maxY);
    }
    return { minX, minY, maxX, maxY };
  };
  const availableW = Math.max(1, width - 40), availableH = Math.max(1, height - 40);
  let lo = 0, hi = GRAPH_MAX_ZOOM;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2, b = screenBounds(mid);
    if (b.maxX - b.minX <= availableW && b.maxY - b.minY <= availableH) lo = mid; else hi = mid;
  }
  // A fixed-screen label wider than the canvas cannot be made to fit by
  // shrinking world geometry. Keep the content fitted and allow label overflow.
  if (lo === 0 && labels.length) return fitGraphViewport(bounds, width, height);
  const scale = clampGraphZoom(lo || Math.min(GRAPH_MAX_ZOOM, availableW / Math.max(1, bounds.maxX - bounds.minX),
    availableH / Math.max(1, bounds.maxY - bounds.minY)));
  const b = screenBounds(scale);
  return { scale, x: 20 + (availableW - b.maxX + b.minX) / 2 - b.minX,
    y: 20 + (availableH - b.maxY + b.minY) / 2 - b.minY };
}

/** Selection is represented by a thicker stroke; never replace the themed fill. */
export function graphNodeFill(background: string, _highlighted: boolean): string {
  return background && background !== 'transparent'
    ? background
    : 'var(--vscode-editorWidget-background, #252526)';
}

export function SnlGraphApp({ localDetails, markdownImageUrlTransform, initialAtomicDependenciesOnly = true, layoutMemory }: Pick<React.ComponentProps<typeof HoverPopoverProvider>, 'localDetails' | 'markdownImageUrlTransform'> & { initialAtomicDependenciesOnly?: boolean; layoutMemory?: GraphLayoutMemoryCache } = {}): React.ReactElement {
  const ownLayoutMemory = useMemo(() => new GraphLayoutMemoryCache(), []);
  const currentLayoutMemory = useRef(layoutMemory ?? ownLayoutMemory);
  useInsertionEffect(() => { currentLayoutMemory.current = layoutMemory ?? ownLayoutMemory; }, [layoutMemory, ownLayoutMemory]);
  const extensionApiRef = useVsCodeApiRef();
  const capabilities = useReaderCapabilities();
  const apiRef = useRef(capabilities.api ?? extensionApiRef.current);
  apiRef.current = capabilities.api ?? extensionApiRef.current;
  const contentLanguage = use_content_language();
  // Accept the message and its snapshot-owned cache together. A new owner prop
  // must not recompute the retained old message before the new ready reply arrives.
  const [model, setModel] = useState<{ message: GraphMessage | null; memory: GraphLayoutMemoryCache }>(
    () => ({ message: null, memory: layoutMemory ?? ownLayoutMemory })
  );
  const msg = model.message;
  const [graphError, setGraphError] = useState<GraphErrorMessage | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const incoming: unknown = event.data;
      if (isGraphMessage(incoming)) {
        setModel({ message: incoming, memory: currentLayoutMemory.current });
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
      <SnlGraphInner layoutMemory={model.memory} msg={msg} graphError={graphError} post={post} apiRef={apiRef} initialAtomicDependenciesOnly={initialAtomicDependenciesOnly} />
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
  const capabilities = useReaderCapabilities();
  const nodePaintId = React.useId();
  const { edit } = capabilities;
  const contentLanguage = use_content_language();
  const preferencesRevision = use_preferences_revision();
  const popovers = useHoverPopovers();
  const currentPopoverId = useCurrentPopoverId();
  const [vp, setVp] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [availableSize, setAvailableSize] = useState<{ laid: Layout; width: number; height: number } | null>(null);
  const [labelOffsets, setLabelOffsets] = useState<Map<string, EdgePoint>>(() => new Map());
  const [dragging, setDragging] = useState<null | {
    startX: number;
    startY: number;
    vpX: number;
    vpY: number;
  }>(null);
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  // Panel-local controls survive host refreshes, but never affect graph order
  // or fitting except when the layout itself changes.
  const [layoutMode, setLayoutMode] = useState<GraphLayoutMode>('rectangle');
  const [layerPacking, setLayerPacking] = useState<GraphLayerPacking>('bands');
  const effectivePacking = layoutMode === 'rectangle' ? 'bands' : layerPacking;
  const [nodeMode, setNodeMode] = useState<GraphNodeMode>('auto');
  const [titleThreshold, setTitleThreshold] = useState(120);
  const [coloringMode, setColoringMode] = useState<GraphColoringMode>('kind');
  const [tagColorRules, setTagColorRules] = useState<GraphTagColorRule[]>([]);
  const nextColorRuleId = useRef(1);
  const addColorRule = (): void => {
    const id = nextColorRuleId.current++;
    setTagColorRules(previous => [...previous, { id, tag: null, color: '#6688cc' }]);
  };
  // These are deliberately separate from layout/filter/fit inputs.
  const tagUniverse = useMemo(() => [...new Set(msg?.nodes.flatMap(node => node.tags ?? []) ?? [])]
    .sort(compareLexically), [msg]);
  const tagFills = useMemo(() => new Map(msg?.nodes.map(node =>
    [node.id, graphTagColor(node.tags, tagColorRules)]) ?? []), [msg, tagColorRules]);
  const packageFills = useMemo(() => new Map(msg?.nodes.map(node =>
    [node.id, graphPackageColor(node.packageId)]) ?? []), [msg]);
  const [showRelationships, setShowRelationships] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const selectEdge = (id: string): void => {
    setSelectedId(null);
    setSelectedEdgeId(previous => previous === id ? null : id);
    if (edit) post({ type: 'editRelationship', id });
  };
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
  const [clauses, setClauses] = useState<GraphFilterClause[]>([]);
  const nextClauseId = useRef(1);
  const addClause = (): void => {
    const id = nextClauseId.current++;
    setClauses(previous => [...previous, { id, kind: 'entry-kind', direction: 'either', enabled: true, values: [] }]);
  };
  /** Sidebar open/closed. Persists across msg updates. */
  const [filtersOpen, setFiltersOpen] = useState<boolean>(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Per-node popover state, keyed by node id. Mirrors the pattern
  // EntryRender uses for macro hovers.
  const nodePopoverRef = useRef<Map<string, string>>(new Map());

  const laid = useMemo<Layout | null>(() => {
    if (!msg) return null;
    // Every predicate sees the same host-scope graph after the atomic edge
    // gate, BEFORE any clause or quick-kind node restriction. Layout cycle
    // breaks never affect direction: these are the original from→to edges.
    const scopeIds = new Set(msg.nodes.map(node => node.id));
    const commonEdges = msg.edges.filter(edge => scopeIds.has(edge.from) && scopeIds.has(edge.to) &&
      (depFilter === 'all' || !edge.isDependency || edge.isAtomic === true));
    const predicates = clauses.filter(clause => clause.enabled && clause.values.length > 0).map(clause => {
      const values = new Set(clause.values);
      if (clause.kind === 'tag') return (node: GraphNodeWire): boolean => (node.tags ?? []).some(tag => values.has(tag));
      if (clause.kind === 'entry-kind') return (node: GraphNodeWire): boolean => values.has(node.kindId);
      const matchingIds = new Set<string>();
      for (const edge of commonEdges) {
        if (!values.has(edge.label)) continue;
        if (clause.direction !== 'incoming') matchingIds.add(edge.from);
        if (clause.direction !== 'outgoing') matchingIds.add(edge.to);
      }
      return (node: GraphNodeWire): boolean => matchingIds.has(node.id);
    });
    const matchingNodes = msg.nodes.filter(node => (kindFilter === null || kindFilter.has(node.kindId)) &&
      predicates.every(matches => matches(node)));
    const matchingIds = new Set(matchingNodes.map(node => node.id));
    // Induce ALL surviving edge labels, not just labels used by predicates.
    const filteredEdges = commonEdges.filter(edge => matchingIds.has(edge.from) && matchingIds.has(edge.to));
    const kept = new Set<string>();
    for (const e of filteredEdges) {
      kept.add(e.from);
      kept.add(e.to);
    }
    const filteredNodes: GraphNode[] = matchingNodes
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
      contentLanguage, filteredNodes, filteredEdges, { ...DEFAULT_LAYOUT_PARAMETERS, mode: layoutMode, packing: effectivePacking });
    return layoutMemory.get(input, msg.layoutCache);
  }, [msg, depFilter, kindFilter, clauses, contentLanguage, layoutMemory, layoutMode, effectivePacking]);

  // Paint is current-theme state, not cached geometry or a fit trigger.
  const kindPaint = useMemo(() => new Map(msg?.nodes.map(node => [node.id,
    node.coloring ? resolveWebviewKindColoring(node.coloring) : { stroke: '#888888', background: 'transparent' }
  ]) ?? []), [msg, preferencesRevision]);

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

  // Choices use the full scope message, not the displayed/atomic-only graph.
  const relationshipUniverse = useMemo(() => [...new Set(msg?.edges.map(edge => edge.label) ?? [])]
    .sort(compareLexically), [msg]);

  useEffect(() => {
    if (selectedId && !laid?.nodes.some(node => node.id === selectedId)) setSelectedId(null);
    if (selectedEdgeId && !laid?.edges.some(edge => edge.id === selectedEdgeId)) setSelectedEdgeId(null);
  }, [laid, selectedId, selectedEdgeId]);

  // One paint list owns both mounted paths and bounds for the next fit.
  // Selection/visibility update bounds, but never trigger an immediate fit.
  const paintedEdges = useMemo(() => {
    if (!laid) return [];
    return selectedEdgeId !== null ? laid.edges.filter(edge => edge.id === selectedEdgeId)
      : selectedId !== null ? laid.edges.filter(edge => edge.from === selectedId || edge.to === selectedId)
      : showRelationships ? laid.edges : [];
  }, [laid, selectedEdgeId, selectedId, showRelationships]);
  const contentBounds = useMemo(() => laid?.nodes.length
    ? graphContentBounds({ ...laid, edges: paintedEdges }, paintedEdges.length > 0) : null, [laid, paintedEdges]);
  const fitSnapshotRef = useRef<{ laid: typeof laid; bounds: typeof contentBounds } | null>(null);
  useLayoutEffect(() => {
    const snapshot = { laid, bounds: contentBounds };
    fitSnapshotRef.current = snapshot;
    return () => { if (fitSnapshotRef.current === snapshot) fitSnapshotRef.current = null; };
  }, [laid, contentBounds]);

  // Refit committed layout input and available canvas changes, not interaction
  // or presentation. Observe both the SVG and overlay sidebar (font/wrapping
  // changes can alter its width). Cleanup also rejects queued late deliveries.
  useEffect(() => {
    const svg = svgRef.current;
    if (!laid || !svg) return;
    const sidebar = svg.parentElement?.querySelector<HTMLElement>('[data-graph-sidebar]');
    let alive = true;
    let previousSize = '';
    const fit = (): void => {
      const snapshot = fitSnapshotRef.current;
      if (!alive || !snapshot?.bounds || snapshot.laid !== laid) return;
      const bounds = snapshot.bounds;
      const rect = svg.getBoundingClientRect();
      const side = sidebar?.getBoundingClientRect();
      const width = side && side.width > 0 ? Math.max(0, Math.min(rect.width, side.left - rect.left)) : rect.width;
      if (![width, rect.height].every(value => Number.isFinite(value) && value > 0)) {
        previousSize = '';
        setAvailableSize(null);
        return;
      }
      setAvailableSize(previous => previous?.laid === laid && previous.width === width && previous.height === rect.height
        ? previous : { laid, width, height: rect.height });
      const size = `${width},${rect.height}`;
      if (size === previousSize) return;
      previousSize = size;
      const elements = new Map([...svg.querySelectorAll<SVGTextElement>('[data-package-label]')]
        .map(element => [element.getAttribute('data-package-label'), element]));
      const offsets = new Map<string, EdgePoint>();
      const labels = laid.clusters.map(cluster => {
        const element = elements.get(cluster.packageId);
        const measured = element?.getComputedTextLength?.();
        const box = cluster.sector ? element?.getBBox?.() : undefined;
        if (cluster.sector && element && box && box.width > 0 && box.height > 0) {
          const orientation = radialPackageLabelOrientation(cluster.sector.labelAngle);
          // Ink can overhang the advance (e.g. final 'y'). Remove the previous
          // correction when measuring, so repeated resize/fit cannot oscillate.
          const left = box.x - Number(element.getAttribute('x')) - Number(element.getAttribute('dx'));
          const top = box.y - Number(element.getAttribute('y')) - Number(element.getAttribute('dy'));
          offsets.set(cluster.packageId, {
            x: -(left + (orientation.textAnchor === 'end' ? box.width : orientation.textAnchor === 'middle' ? box.width / 2 : 0)),
            y: -(top + (orientation.dominantBaseline === 'text-after-edge' ? box.height : orientation.dominantBaseline === 'central' ? box.height / 2 : 0))
          });
        }
        return { ...packageLabelAnchor(cluster), centered: false, angle: cluster.sector?.labelAngle,
          height: box?.height,
          width: Math.max(box?.width ?? 0, measured && Number.isFinite(measured) ? measured + 4 : (element?.textContent?.length ?? cluster.packageId.length) * 8 + 4) };
      });
      setLabelOffsets(offsets);
      setVp(fitGraphViewport(bounds, width, rect.height, labels));
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(svg);
    if (sidebar) observer?.observe(sidebar);
    window.addEventListener('resize', fit);
    return () => {
      alive = false;
      observer?.disconnect();
      window.removeEventListener('resize', fit);
      // Geometry may be reused from memory after an empty projection. A retired
      // canvas measurement must not authorize even a transient title compile.
      setAvailableSize(null);
    };
  }, [laid, filtersOpen]);

  const onWheel = useCallback((e: WheelEvent): void => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setVp((prev) => {
      const nextScale = clampGraphZoom(prev.scale * factor);
      const wx = (mx - prev.x) / prev.scale;
      const wy = (my - prev.y) / prev.scale;
      return {
        scale: nextScale,
        x: mx - wx * nextScale,
        y: my - wy * nextScale
      };
    });
  }, []);

  // React delegates wheel listeners passively. Bind to the mounted canvas so
  // zoom can cancel native scrolling without console errors; the callback ref
  // also releases the listener on empty/loading transitions and unmount.
  const bindSvg = useCallback((svg: SVGSVGElement | null): void => {
    svgRef.current?.removeEventListener('wheel', onWheel);
    svgRef.current = svg;
    svg?.addEventListener('wheel', onWheel, { passive: false });
  }, [onWheel]);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if ((e.target as Element).tagName === 'svg' || (e.target as Element).id === 'snl-graph-background') {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      setDragging({ startX: e.clientX, startY: e.clientY, vpX: vp.x, vpY: vp.y });
      // Clicking blank canvas clears either kind of selection.
      setSelectedId(null);
      setSelectedEdgeId(null);
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
          host={capabilities.panelHeader}
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

  const nodesById = new Map(laid.nodes.map(n => [n.id,
    graphNodePresentation(n, vp.scale, hoverNodeId === n.id || focusNodeId === n.id)]));
  // Invert the available SVG rectangle once per render, not per node. Only
  // presentation depends on this region: full-title layout and fit stay intact.
  // A new/loading canvas has no accepted measurement and fails closed to dots.
  const nearBounds = availableSize?.laid === laid ? {
    minX: (-TITLE_VIEWPORT_MARGIN - vp.x) / vp.scale,
    minY: (-TITLE_VIEWPORT_MARGIN - vp.y) / vp.scale,
    maxX: (availableSize.width + TITLE_VIEWPORT_MARGIN - vp.x) / vp.scale,
    maxY: (availableSize.height + TITLE_VIEWPORT_MARGIN - vp.y) / vp.scale
  } : null;
  const nodeShape = (id: string): NodeShape => {
    const n = nodesById.get(id)!;
    return nearBounds && n.x + n.w >= nearBounds.minX && n.x <= nearBounds.maxX &&
      n.y + n.h >= nearBounds.minY && n.y <= nearBounds.maxY &&
      (nodeMode === 'always-title' || vp.scale >= titleThreshold / 100 || hoverNodeId === id || focusNodeId === id)
      ? 'title' : 'dot';
  };
  // Native click/focus identity must never move with paint priority: Chromium
  // can lose compatibility mousedown/click if React reorders a keyed SVG group
  // between pointerdown and mousedown. Raise pointer-transparent paint only.
  const nodeTitleElements = new Map<string, React.ReactElement>();
  const nodePaintIndexes = new Map(laid.nodes.map((node, index) => [node.id, index]));
  const paintedNodes = [...laid.nodes].sort((a, b) =>
    (Number(nodeShape(a.id) === 'title') + Number(a.id === hoverNodeId || a.id === focusNodeId)) -
    (Number(nodeShape(b.id) === 'title') + Number(b.id === hoverNodeId || b.id === focusNodeId)));
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
    setSelectedEdgeId(null);
    setSelectedId((prev) => (prev === n.id ? null : n.id));
  };

  return (
    <main
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') { setSelectedId(null); setSelectedEdgeId(null); }
      }}
      onPointerMoveCapture={(event) => {
        // Replacing/reordering an SVG hit shape can suppress its pointerout in
        // Chromium. Reconcile from the next real pointer target, independently
        // of keyboard focus, rather than leaving a permanent hovered card.
        if (hoverNodeId && (event.target as Element).closest('[data-node-id]')?.getAttribute('data-node-id') !== hoverNodeId) {
          const previous = nodesById.get(hoverNodeId);
          if (previous) handleNodePointerLeave(previous);
        }
      }}
      onPointerLeave={() => {
        const previous = hoverNodeId ? nodesById.get(hoverNodeId) : undefined;
        if (previous) handleNodePointerLeave(previous);
      }}
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
          host={capabilities.panelHeader}
          title={edit ? msg.title : t('title')}
          subtitle={capabilities.scopeDescription ?? (edit ? undefined : t('frozenScope'))}
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
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', padding: '0 0.75rem 0.5rem', fontSize: '0.8rem' }}>
        <label>
          {t('layout')}{' '}
          <select className="snl-control" aria-label={t('layout')} value={layoutMode}
            onChange={e => setLayoutMode(e.target.value as GraphLayoutMode)}>
            <option value="rectangle">{t('rectangle')}</option>
            <option value="radial-inward">{t('radialInward')}</option>
            <option value="radial-outward">{t('radialOutward')}</option>
          </select>
        </label>
        <label>
          {t('nodeMode')}{' '}
          <select className="snl-control" aria-label={t('nodeMode')} value={nodeMode}
            onChange={e => setNodeMode(e.target.value as GraphNodeMode)}>
            <option value="auto">{t('autoNodes')}</option>
            <option value="always-title">{t('alwaysTitle')}</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {t('titleThreshold')}
          <input type="range" aria-label={t('titleThreshold')} min={20} max={300} step={1}
            value={titleThreshold} onChange={e => setTitleThreshold(Number(e.target.value))} />
          <output style={{ minWidth: '3.5em' }}>{titleThreshold}%</output>
        </label>
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
          layerPacking={layerPacking}
          onLayerPackingChange={setLayerPacking}
          kindUniverse={kindUniverse}
          kindFilter={kindFilter}
          onKindFilterChange={setKindFilter}
          clauses={clauses}
          onClausesChange={setClauses}
          onAddClause={addClause}
          relationshipUniverse={relationshipUniverse}
          showRelationships={showRelationships}
          onShowRelationshipsChange={value => {
            setShowRelationships(value);
            setSelectedEdgeId(null);
            setHoverEdgeId(null);
          }}
          coloringMode={coloringMode}
          onColoringModeChange={setColoringMode}
          tagUniverse={tagUniverse}
          tagColorRules={tagColorRules}
          onTagColorRulesChange={setTagColorRules}
          onAddColorRule={addColorRule}
        />
        {displayedNodeCount === 0 ? (
          <div
            data-testid="graph-filtered-empty"
            style={{
              padding: '2rem',
              opacity: 0.75,
              fontStyle: 'italic',
              textAlign: 'center'
            }}
          >
            {capabilities.graphEmptyDescription ?? t(!edit ? 'frozenEmpty' : msg.nodes.length > 0 ? 'filteredEmpty' : 'empty')}
          </div>
        ) : (
          <svg
            ref={bindSvg}
            data-layer-packing={layerPacking}
            data-radial-center={laid.radial ? JSON.stringify({ x: laid.radial.centerX, y: laid.radial.centerY }) : undefined}
            width="100%"
            height="100%"

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
              data-graph-viewport=""
              data-content-bounds={contentBounds ? JSON.stringify(contentBounds) : undefined}
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
                    {cluster.sector ? <path
                      d={cluster.sector.path}
                      fill="var(--vscode-editorWidget-background)"
                      fillOpacity={0.24}
                      stroke="var(--vscode-panel-border, var(--vscode-contrastBorder))"
                      strokeWidth={1.5}
                    /> : <rect
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
                    />}
                  </g>
                );
              })}
              {/* Edges first so nodes paint on top. */}
              {paintedEdges.map((e) => {
                const from = nodesById.get(e.from)!;
                const to = nodesById.get(e.to)!;
                const { d } = edgePath(from, to, e.waypoints, { fromShape: nodeShape(from.id), toShape: nodeShape(to.id) }, laid);
                const hovered = hoverEdgeId === e.id;
                const incidentToSelected =
                  selectedId !== null &&
                  (e.from === selectedId || e.to === selectedId);
                const nonAtomicDep = e.isDependency && e.isAtomic === false;
                const baseOpacity = nonAtomicDep ? 0.28 : 0.55;
                const edgeSelected = selectedEdgeId === e.id;
                const opacity = incidentToSelected || edgeSelected || hovered ? 1 : baseOpacity;
                return (
                  <g
                    key={e.id}
                    data-edge-id={e.id}
                    data-from={e.from}
                    data-to={e.to}
                    role={edit ? 'button' : 'img'}
                    aria-pressed={edgeSelected}
                    tabIndex={edit ? 0 : undefined}
                    aria-label={t('relationshipAria', { label: e.label || e.id, from: e.from, to: e.to })}
                    onPointerEnter={() => setHoverEdgeId(e.id)}
                    onPointerLeave={() =>
                      setHoverEdgeId((c) => (c === e.id ? null : c))
                    }
                    style={{ cursor: edit ? 'pointer' : 'default' }}
                    onClick={() => selectEdge(e.id)}
                    onFocus={() => setHoverEdgeId(e.id)}
                    onBlur={() => setHoverEdgeId((c) => (c === e.id ? null : c))}
                    onKeyDown={(event) => {
                      if (!edit || (event.key !== 'Enter' && event.key !== ' ')) return;
                      event.preventDefault();
                      selectEdge(e.id);
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
                      strokeWidth={incidentToSelected || edgeSelected || hovered ? 2 : 1.2}
                      strokeDasharray={e.isBack ? '5 4' : undefined}
                      markerEnd="url(#snl-graph-arrow)"
                    />
                  </g>
                );
              })}
              {/* Nodes */}
              {laid.nodes.map((n, index) => {
                const presentation = nodesById.get(n.id)!;
                const isHovered = hoverNodeId === n.id;
                const isSelected = selectedId === n.id;
                const showTitle = nodeShape(n.id) === 'title';
                const highlighted = isHovered || isSelected || focusNodeId === n.id;
                const paint = kindPaint.get(n.id)!;
                const stroke = paint.stroke;
                const overrideFill = coloringMode === 'tag' ? tagFills.get(n.id)
                  : coloringMode === 'package' ? packageFills.get(n.id) : undefined;
                const fill = graphNodeFill(overrideFill ?? paint.background, highlighted);
                const textColor = overrideFill ? graphTagTextColor(overrideFill) : stroke;
                const titleHtml = showTitle ? renderTitleKatex(n.title) : '';
                if (showTitle) nodeTitleElements.set(n.id, (
                    <foreignObject
                      x={15}
                      y={30}
                      width={n.w - 30}
                      height={n.h - 33}
                      style={{ pointerEvents: 'none' }}
                    >
                      <div
                        style={{
                          fontSize: '19.5px',
                          fontWeight: 600,
                          color: textColor,
                          lineHeight: '30px',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis'
                        }}
                        dangerouslySetInnerHTML={{ __html: titleHtml }}
                      />
                    </foreignObject>
                ));
                const radius = showTitle ? CARD_RADIUS : presentation.dotRadius;
                const hitX = showTitle ? 0 : n.w / 2 - radius;
                const hitY = showTitle ? 0 : n.h / 2 - radius;
                const hitW = showTitle ? n.w : radius * 2;
                const hitH = showTitle ? n.h : radius * 2;
                const hitPath = `M ${hitX + radius} ${hitY} h ${hitW - 2 * radius} a ${radius} ${radius} 0 0 1 ${radius} ${radius} v ${hitH - 2 * radius} a ${radius} ${radius} 0 0 1 ${-radius} ${radius} h ${2 * radius - hitW} a ${radius} ${radius} 0 0 1 ${-radius} ${-radius} v ${2 * radius - hitH} a ${radius} ${radius} 0 0 1 ${radius} ${-radius} Z`;
                return (
                  <g
                    key={n.id}
                    role="button"
                    tabIndex={0}
                    aria-label={t('entryAria', { title: n.title || n.id, id: n.id })}
                    data-package-id={n.packageId}
                    data-node-id={n.id}
                    data-node-shape={showTitle ? 'title' : 'dot'}
                    transform={`translate(${presentation.x} ${presentation.y}) scale(${presentation.presentationScale})`}
                    style={{ cursor: 'pointer' }}
                    onPointerEnter={(ev) => handleNodePointerEnter(n, ev)}
                    onPointerMove={(ev) => handleNodePointerMove(n, ev)}
                    onPointerLeave={() => handleNodePointerLeave(n)}
                    onClick={(ev) => handleNodeClick(n, ev)}
                    onFocus={() => setFocusNodeId(n.id)}
                    onBlur={() => setFocusNodeId((c) => (c === n.id ? null : c))}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      if (event.ctrlKey || event.metaKey) {
                        post({ type: 'openEntryInfoview', entryId: n.id });
                        return;
                      }
                      setSelectedEdgeId(null);
                      setSelectedId((previous) => previous === n.id ? null : n.id);
                    }}
                  >
                    {/* Cat 2026-07-10 §3: dropped the native <title>
                        tooltip — the full-Entry hover popover already
                        carries every fact this used to duplicate. */}
                    {/* Titles paint once via the raised use, not twice (which
                        would compound translucent Kind fills). The opacity is
                        outside the referenced subtree; its geometry stays live. */}
                    <g opacity={showTitle ? 0 : 1} pointerEvents="none">
                    <g id={`${nodePaintId}-${index}`} data-node-paint="" pointerEvents="none">
                    {showTitle ? <>
                    <rect
                      width={n.w}
                      height={n.h}
                      rx={CARD_RADIUS}
                      ry={CARD_RADIUS}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={highlighted ? 3.5 : 2}
                    />
                    <text
                      x={15}
                      y={24}
                      fontSize={16.5}
                      fontFamily="var(--vscode-editor-font-family, monospace)"
                      opacity={overrideFill ? 1 : 0.85}
                      fill={textColor}
                    >
                      {n.kind}
                    </text>
                    {/* Cat 2026-07-10 §2: entry title rendered as raw
                        KaTeX (LaTeX text-mode fragment). Uses
                        foreignObject to embed KaTeX HTML output inside
                        the SVG — KaTeX SVG output isn't a stable API. */}
                    </> : <circle cx={n.w / 2} cy={n.h / 2} r={presentation.dotRadius}
                      fill={fill} stroke={stroke} strokeWidth={highlighted ? 3.5 : 2} />}
                    </g>
                    {nodeTitleElements.get(n.id)}
                    </g>
                    {/* One native hit child survives dot/card changes as well as
                        metadata-only hover. Paint never intercepts its events. */}
                    <path data-node-hit="" d={hitPath} fill="transparent" pointerEvents="all" />
                  </g>
                );
              })}
              <g data-node-raised-paint="" aria-hidden="true" pointerEvents="none">
                {paintedNodes.filter(n => nodeShape(n.id) === 'title').map(n => {
                  const presentation = nodesById.get(n.id)!;
                  // Chromium does not paint foreignObject through SVG use.
                  // Reuse the already-compiled near-title element as decorative
                  // HTML paint; never clone the focusable group or hit target.
                  return <g key={n.id} transform={`translate(${presentation.x} ${presentation.y}) scale(${presentation.presentationScale})`}>
                    <use data-node-raise={n.id} href={`#${nodePaintId}-${nodePaintIndexes.get(n.id)}`} />
                    {nodeTitleElements.get(n.id)}
                  </g>;
                })}
              </g>
            </g>
            {/* Screen-space overlay: anchors pan/zoom with the package, but
                glyphs remain 12px and paint above cards without intercepting input. */}
            <g style={{ pointerEvents: 'none' }} data-package-labels="">
              {laid.clusters.map(cluster => {
                const anchor = packageLabelAnchor(cluster);
                const x = vp.x + anchor.x * vp.scale, y = vp.y + anchor.y * vp.scale;
                const orientation = cluster.sector && radialPackageLabelOrientation(cluster.sector.labelAngle);
                // Only the anchor pans/zooms; upright 12px glyphs extend outward
                // from the sector's exact outer radius, without an extra gap.
                return <text key={cluster.packageId} data-package-label={cluster.packageId}
                  data-world-anchor={`${anchor.x},${anchor.y}`}
                  x={x} y={y}
                  dx={orientation ? labelOffsets.get(cluster.packageId)?.x : undefined}
                  dy={orientation ? labelOffsets.get(cluster.packageId)?.y : undefined}
                  textAnchor={orientation?.textAnchor}
                  dominantBaseline={orientation?.dominantBaseline}
                  fill="var(--vscode-foreground, #ddd)" fontSize={12} fontWeight={600}
                  fontFamily="var(--vscode-font-family)">
                  {cluster.packageId === '_unpackaged' ? t('unpackaged') : cluster.packageId}
                </text>;
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
 * Existing quick controls remain live-applied alongside temporary AND clauses:
 *
 *   - **Edges**: the atomic-only toggle (previously the standalone
 *     header button). Kept as a boolean because that's what it is.
 *   - **Entry kinds**: one checkbox per kindId present in the graph,
 *     with a kind-colored swatch. `null` filter (default) = all kinds
 *     visible; toggling a kind switches to "specific set" mode.
 *   - **Temporary filters**: stable local cards, OR values inside each card,
 *     AND between cards. Empty drafts and disabled cards do not constrain nodes.
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
  layerPacking,
  onLayerPackingChange,
  kindUniverse,
  kindFilter,
  onKindFilterChange,
  clauses,
  onClausesChange,
  onAddClause,
  relationshipUniverse,
  showRelationships, onShowRelationshipsChange,
  coloringMode, onColoringModeChange, tagUniverse, tagColorRules, onTagColorRulesChange, onAddColorRule
}: {
  open: boolean;
  onToggle: () => void;
  depFilter: 'all' | 'atomic-deps';
  onDepFilterChange: (v: 'all' | 'atomic-deps') => void;
  layerPacking: GraphLayerPacking;
  onLayerPackingChange: (v: GraphLayerPacking) => void;
  kindUniverse: Array<{ kindId: string; label: string; color: string }>;
  kindFilter: Set<string> | null;
  onKindFilterChange: (v: Set<string> | null) => void;
  clauses: GraphFilterClause[];
  onClausesChange: (clauses: GraphFilterClause[]) => void;
  onAddClause: () => void;
  relationshipUniverse: string[];
  showRelationships: boolean;
  onShowRelationshipsChange: (value: boolean) => void;
  coloringMode: GraphColoringMode;
  onColoringModeChange: (mode: GraphColoringMode) => void;
  tagUniverse: string[];
  tagColorRules: GraphTagColorRule[];
  onTagColorRulesChange: (rules: GraphTagColorRule[]) => void;
  onAddColorRule: () => void;
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
      data-graph-sidebar=""
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
        data-testid="graph-filter-toggle"
        aria-expanded={open}
        aria-controls="snl-graph-filter-settings"
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
          id="snl-graph-filter-settings"
          data-testid="graph-filter-settings"
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
          <section aria-label={t('coloringSettings')} data-testid="graph-color-settings">
            <h3 style={{ margin: '0 0 0.4rem', fontSize: '0.85rem' }}>{t('coloringSettings')}</h3>
            <label>{t('coloringMode')}{' '}
              <select className="snl-control" aria-label={t('coloringMode')} value={coloringMode}
                onChange={event => onColoringModeChange(event.target.value as GraphColoringMode)}>
                <option value="kind">{t('kindColoring')}</option>
                <option value="tag">{t('tagColoring')}</option>
                <option value="package">{t('packageColoring')}</option>
              </select>
            </label>
            <p style={{ fontSize: '0.8rem' }}>{t(coloringMode === 'package' ? 'packageColorHelp' : 'colorHelp')}</p>
            <Button type="button" onClick={onAddColorRule}>{t('addColorMapping')}</Button>
            {tagColorRules.map((rule, index) => {
              const update = (patch: Partial<GraphTagColorRule>): void =>
                onTagColorRulesChange(tagColorRules.map(item => item.id === rule.id ? { ...item, ...patch } : item));
              const options = [...tagUniverse];
              const unavailable = rule.tag !== null && !options.includes(rule.tag);
              if (unavailable) options.push(rule.tag!);
              const move = (offset: number): void => {
                const next = [...tagColorRules];
                [next[index], next[index + offset]] = [next[index + offset], next[index]];
                onTagColorRulesChange(next);
              };
              return <fieldset key={rule.id} data-testid="graph-tag-color-rule" data-rule-id={rule.id}
                style={{ minWidth: 0, margin: '0.5rem 0', padding: '0.5rem', border: '1px solid var(--vscode-panel-border, #888)' }}>
                <legend>{t('colorMapping', { id: rule.id })}</legend>
                <label style={{ display: 'block' }}>{t('tag')}{' '}
                  <select className="snl-control" aria-label={t('tag')} style={{ width: '100%', minWidth: 0 }}
                    value={rule.tag === null ? '' : String(options.indexOf(rule.tag))}
                    onChange={event => update({ tag: event.target.value === '' ? null : options[Number(event.target.value)] })}>
                    <option value="">{t('chooseTag')}</option>
                    {options.map((tag, optionIndex) => <option key={optionIndex} value={String(optionIndex)}>
                      {unavailable && tag === rule.tag ? t('unavailableFilterValue', { value: tag === '' ? t('emptyTag') : tag }) : tag === '' ? t('emptyTag') : tag}
                    </option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: '0.4rem 0' }}>{t('color')}
                  <input type="color" aria-label={t('color')} value={rule.color}
                    onChange={event => { if (/^#[0-9a-f]{6}$/i.test(event.target.value)) update({ color: event.target.value }); }} />
                  <span>{rule.color}</span>
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                  <Button type="button" disabled={index === 0} onClick={() => move(-1)}>{t('moveUp')}</Button>
                  <Button type="button" disabled={index === tagColorRules.length - 1} onClick={() => move(1)}>{t('moveDown')}</Button>
                  <Button type="button" onClick={() => onTagColorRulesChange(tagColorRules.filter(item => item.id !== rule.id))}>{t('removeColorMapping')}</Button>
                </div>
              </fieldset>;
            })}
          </section>
          <h3
            style={{
              margin: '0 0 0.4rem',
              fontSize: '0.85rem',
              opacity: 0.75,
              textTransform: 'uppercase',
              letterSpacing: '0.06em'
            }}
          >
            {t('layerPacking')}
          </h3>
          <select className="snl-control" aria-label={t('layerPacking')}
            aria-describedby="snl-graph-packing-help" value={layerPacking}
            onChange={e => onLayerPackingChange(e.target.value as GraphLayerPacking)}
            style={{ width: '100%', minWidth: 0 }}>
            <option value="bands">{t('compactBands')}</option>
            <option value="rings">{t('strictRings')}</option>
          </select>
          <p id="snl-graph-packing-help" style={{ fontSize: '0.8rem', opacity: 0.8, margin: '0.4rem 0 0.9rem' }}>
            {t('packingHelp')}
          </p>
          <h3 style={{ margin: '0 0 0.4rem', fontSize: '0.85rem', opacity: 0.75 }}>
            {t('edgesHeading')}
          </h3>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            <input type="checkbox" checked={showRelationships}
              onChange={event => onShowRelationshipsChange(event.target.checked)} />
            <span>{t('showRelationships')}</span>
          </label>
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
          <section data-testid="graph-filters" aria-label={t('previewFilters')}>
            <h3 style={{ margin: '1rem 0 0.4rem', fontSize: '0.85rem' }}>{t('previewFilters')}</h3>
            <p style={{ fontSize: '0.8rem' }}>{t('filterHelp')}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              <Button type="button" data-testid="graph-filter-add" onClick={onAddClause}>{t('addFilter')}</Button>
              <Button type="button" data-testid="graph-filter-clear" disabled={clauses.length === 0}
                onClick={() => onClausesChange([])}>{t('clearFilters')}</Button>
            </div>
            {clauses.map((clause, index) => {
              const update = (patch: Partial<GraphFilterClause>): void =>
                onClausesChange(clauses.map(item => item.id === clause.id ? { ...item, ...patch } : item));
              const options = clause.kind === 'entry-kind'
                ? kindUniverse.map(option => ({ value: option.kindId, label: option.label || option.kindId, unavailable: false }))
                : (clause.kind === 'tag' ? tagUniverse : relationshipUniverse).map(value => ({ value, label: value || t(clause.kind === 'tag' ? 'emptyTag' : 'emptyRelationshipLabel'), unavailable: false }));
              const availableValues = new Set(options.map(option => option.value));
              // Missing selections remain real predicates. Keep them editable
              // (not disabled) so an empty result can always be recovered.
              for (const value of clause.values) {
                if (!availableValues.has(value)) options.push({ value, unavailable: true,
                  label: t('unavailableFilterValue', { value: value || t(clause.kind === 'tag' ? 'emptyTag' : 'emptyRelationshipLabel') }) });
              }
              return <React.Fragment key={clause.id}>
                {index > 0 ? <div style={{ textAlign: 'center', fontWeight: 600 }}>{t('andFilters')}</div> : null}
                <fieldset data-testid="graph-filter-clause" data-filter-id={clause.id}
                  style={{ minWidth: 0, margin: '0.5rem 0', padding: '0.5rem', border: '1px solid var(--vscode-panel-border, #888)', borderRadius: 4 }}>
                  <legend>{t('filterNumber', { id: clause.id })}</legend>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.4rem' }}>
                    <label><input type="checkbox" data-testid="graph-filter-enabled" checked={clause.enabled}
                      onChange={event => update({ enabled: event.target.checked })} /> {t('enabledFilter')}</label>
                    <Button type="button" data-testid="graph-filter-remove" style={smallLinkBtn}
                      onClick={() => onClausesChange(clauses.filter(item => item.id !== clause.id))}>{t('removeFilter')}</Button>
                  </div>
                  <label style={{ display: 'block', margin: '0.4rem 0' }}>{t('filterKind')}{' '}
                    <select className="snl-control" data-testid="graph-filter-kind" value={clause.kind}
                      onChange={event => update({ kind: event.target.value as GraphFilterClause['kind'], values: [] })}>
                      <option value="entry-kind">{t('entryKindFilter')}</option>
                      <option value="relationship">{t('relationshipFilter')}</option>
                      <option value="tag">{t('tag')}</option>
                    </select>
                  </label>
                  {clause.kind === 'relationship' ? <label style={{ display: 'block', margin: '0.4rem 0' }}>{t('filterDirection')}{' '}
                    <select className="snl-control" data-testid="graph-filter-direction" value={clause.direction}
                      onChange={event => update({ direction: event.target.value as GraphFilterClause['direction'] })}>
                      <option value="either">{t('eitherFilter')}</option>
                      <option value="incoming">{t('incomingFilter')}</option>
                      <option value="outgoing">{t('outgoingFilter')}</option>
                    </select>
                  </label> : null}
                  {!clause.enabled ? <p style={{ fontSize: '0.8rem' }}>{t('disabledFilter')}</p> : null}
                  {clause.values.length === 0 ? <p data-testid="graph-filter-draft" style={{ fontSize: '0.8rem' }}>{t('draftFilter')}</p> : null}
                  <fieldset style={{ minWidth: 0, margin: 0, padding: '0.4rem', border: 0 }}>
                    <legend>{t('filterValues')}</legend>
                    {options.map(option => <label key={option.value} data-unavailable={option.unavailable}
                      style={{ display: 'block', overflowWrap: 'anywhere' }}>
                      <input type="checkbox" data-testid="graph-filter-value" value={option.value}
                        checked={clause.values.includes(option.value)}
                        onChange={event => update({ values: event.target.checked
                          ? [...clause.values, option.value] : clause.values.filter(value => value !== option.value) })} />{' '}
                      {option.label}
                    </label>)}
                  </fieldset>
                </fieldset>
              </React.Fragment>;
            })}
          </section>
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
