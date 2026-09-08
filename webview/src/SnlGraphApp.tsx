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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useVsCodeApiRef, PANEL_STYLE, type VsCodeApi } from './vscodeApi';
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
 relationshipAria: 'Relationship {label}: {from} to {to}', entryAria: 'Entry {title} ({id})',
 layout: 'Layout', rectangle: 'Rectangle', radialInward: 'Radial inward', radialOutward: 'Radial outward',
 nodeMode: 'Nodes', autoNodes: 'Auto', alwaysTitle: 'Always title', titleThreshold: 'Title threshold',
 previewFilters: 'Temporary filters', filterHelp: 'Match every filter (AND); any selected value within each filter (OR).',
 addFilter: 'Add filter', clearFilters: 'Clear filters', removeFilter: 'Remove filter',
 filterNumber: 'Filter {id}', filterKind: 'Filter kind', entryKindFilter: 'Entry kind',
 enabledFilter: 'Enabled', disabledFilter: 'Disabled — ignored', draftFilter: 'Draft — no values; ignored',
 filterValues: 'Values (OR)', andFilters: 'AND', relationshipFilter: 'Relationship',
 filterDirection: 'Direction', incomingFilter: 'Incoming', outgoingFilter: 'Outgoing', eitherFilter: 'Either direction',
 emptyRelationshipLabel: '(empty label)', unavailableFilterValue: '{value} (unavailable)',
 filteredEmpty: 'No connected nodes match. Adjust or clear filters in the sidebar.'
}, {
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
  relationshipAria: '关系 {label}：{from} 到 {to}', entryAria: '条目 {title}（{id}）',
  layout: '布局', rectangle: '矩形平铺', radialInward: '向内环铺', radialOutward: '向外环铺',
  nodeMode: '节点', autoNodes: '自动', alwaysTitle: '始终显示标题', titleThreshold: '标题阈值',
  previewFilters: '临时筛选', filterHelp: '满足每个筛选条件（AND）；每个条件内满足任一选值（OR）。',
  addFilter: '添加筛选', clearFilters: '清空筛选', removeFilter: '移除筛选',
  filterNumber: '筛选 {id}', filterKind: '筛选种类', entryKindFilter: '条目种类',
  enabledFilter: '启用', disabledFilter: '已停用 — 不参与筛选', draftFilter: '草稿 — 未选择值，不参与筛选',
  filterValues: '选值（OR）', andFilters: 'AND（且）', relationshipFilter: '关系',
  filterDirection: '方向', incomingFilter: '入边', outgoingFilter: '出边', eitherFilter: '任意方向',
  emptyRelationshipLabel: '（空标签）', unavailableFilterValue: '{value}（不可用）',
  filteredEmpty: '没有匹配的相连节点。请在侧栏中调整或清空筛选条件。'
});

interface GraphNode {
  id: string;
  packageId: string;
  title: string;
  kind: string;
  kindId: string;
  color: string;
  background: string;
}

type GraphNodeWire = Omit<GraphNode, 'title' | 'kind' | 'color' | 'background'> & {
  title: Localized<string, string>;
  kind: Localized<string, string>;
  coloring: ThemedKindColoring | null;
};

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  isDependency: boolean;
  isAtomic: boolean | null;
}

type Scope = { mode: 'pool' } | { mode: 'library'; slug: string };

/** Temporary mounted-panel state only; never part of the host wire schema. */
interface GraphFilterClause {
  id: number;
  kind: 'entry-kind' | 'relationship';
  direction: 'incoming' | 'outgoing' | 'either';
  enabled: boolean;
  values: string[];
}

interface GraphMessage {
  type: 'graph';
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
  value.edges.every(isGraphEdge) && Array.isArray(value.warnings) &&
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

interface LaidOutNode {
  id: string;          // real node id (participating rows) or "__dummy_<n>" for virtuals
  isDummy: boolean;
  // Only meaningful when !isDummy:
  title: string;
  kind: string;
  kindId: string;
  color: string;
  background: string;
  packageId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LaidOutEdge extends GraphEdge {
  isBack: boolean; // was reversed during cycle-break; render dashed
  /** X/Y waypoints threaded through dummy-node centres between endpoints.
   *  Endpoints themselves are NOT included; empty for short (single-layer)
   *  edges. */
  waypoints: { x: number; y: number }[];
}

interface Layout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  clusters: LaidOutCluster[];
  width: number;
  height: number;
  radial?: RadialProjection;
}

export type GraphLayoutMode = 'rectangle' | 'radial-inward' | 'radial-outward';
interface RadialProjection {
  centerX: number;
  centerY: number;
  innerRadius: number;
  layerGap: number;
  maxLayer: number;
  xMin: number;
  xSpan: number;
  yMin: number;
  startAngle: number;
  sweep: number;
}

interface LaidOutCluster {
  packageId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  nodeCount: number;
  sector?: { path: string; startAngle: number; endAngle: number; labelX: number; labelY: number };
}

const NODE_H = 44;
const LAYER_GAP_Y = 90;
const NODE_GAP_X = 24;
const MARGIN = 40;
const CLUSTER_GAP_X = 28;
const CLUSTER_PADDING_X = 24;
const CLUSTER_HEADER_H = 34;
/** Virtual dummies get zero width — they occupy an x slot for routing but
 *  don't reserve display width in the row (their neighbours pack tight). */
const DUMMY_W = 0;
/** Auto-size bounds: keep boxes uniform-ish while accommodating long titles. */
const NODE_W_MIN = 90;
const NODE_W_MAX = 320;
const NODE_PADDING_X = 20; // left + right combined
/** Approximate pixel width per character at the label's font-size / weight. */
const CHAR_W_TITLE = 7.5;   // 13px, weight 600
const CHAR_W_KIND = 6.0;    // 11px, weight normal, opacity 0.65

function nodeWidthFor(kindLabel: string, title: string): number {
  // Title now renders via KaTeX (cat 2026-07-10 §2), so the raw
  // character count is only a rough proxy — LaTeX escapes shrink
  // (\alpha → 1 glyph) while sub/sup and matrices swell. Pad the
  // estimate a bit and keep the clamp so weird cases stay in bounds.
  const titleChars = title.replace(/\\[a-zA-Z]+/g, 'X').length;
  const w = Math.max(
    kindLabel.length * CHAR_W_KIND,
    titleChars * CHAR_W_TITLE
  ) + NODE_PADDING_X;
  return Math.min(NODE_W_MAX, Math.max(NODE_W_MIN, Math.round(w)));
}

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

export function layout(inputNodes: GraphNode[], inputEdges: GraphEdge[], mode: GraphLayoutMode = 'rectangle'): Layout {
  // Normalize protocol ordering up front so storage iteration order cannot
  // move packages, nodes, cycle breaks, or edge routes between refreshes.
  const nodes = [...inputNodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const edges = [...inputEdges].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (nodes.length === 0) {
    return { nodes: [], edges: [], clusters: [], width: 0, height: 0 };
  }

  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, i) => nodeIndex.set(n.id, i));

  // ---- 1. Cycle-break (greedy DFS: back-edges = edges to on-stack node)
  const adj = new Map<string, GraphEdge[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    if (!nodeIndex.has(e.from) || !nodeIndex.has(e.to)) continue;
    adj.get(e.from)!.push(e);
  }

  const backEdgeIds = new Set<string>();
  const color = new Map<string, 0 | 1 | 2>();
  for (const n of nodes) color.set(n.id, 0);
  const dfs = (start: string): void => {
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }];
    color.set(start, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const outs = adj.get(top.id)!;
      if (top.i < outs.length) {
        const e = outs[top.i++];
        const c = color.get(e.to);
        if (c === 0) {
          color.set(e.to, 1);
          stack.push({ id: e.to, i: 0 });
        } else if (c === 1) {
          backEdgeIds.add(e.id);
        }
      } else {
        color.set(top.id, 2);
        stack.pop();
      }
    }
  };
  for (const n of nodes) {
    if (color.get(n.id) === 0) dfs(n.id);
  }

  // ---- 2. Longest-path layering over the acyclic subgraph
  const forwardEdges = edges.filter(
    (e) =>
      !backEdgeIds.has(e.id) && nodeIndex.has(e.from) && nodeIndex.has(e.to)
  );
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const n of nodes) {
    preds.set(n.id, []);
    succs.set(n.id, []);
  }
  for (const e of forwardEdges) {
    preds.get(e.to)!.push(e.from);
    succs.get(e.from)!.push(e.to);
  }
  // ---- 2. Layering: rank from SINKS upward (cat 2026-07-10).
  //
  // Semantics of a `depends` edge A→B: "A depends on B". A node with NO
  // outgoing depends edges (a sink here) depends on nothing → cat's
  // spec: "如果一个 Entry 没有依赖于其他 dependency，它应该在最下面一行."
  // So compute rank_from_sink[X] = 1 + max(rank_from_sink[succ(X)]),
  // sinks get 0. Then flip: layer[X] = maxSinkRank - rank_from_sink[X],
  // so sinks land on the LAST layer (bottom of screen, largest y).
  //
  // The previous formula (rank[X] = 1+max(rank[pred(X)])) collapsed
  // sinks that happened to have a shallower path length to the top of
  // the graph — e.g. edges A→B, A→C, B→D put C at layer 1 (middle)
  // even though C is a sink like D. Sink-anchored ranking puts C and
  // D on the same bottom row.
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, preds.get(n.id)!.length);
  // Kahn's topo order is used only to schedule the SINK-anchored DP:
  // we walk it in REVERSE so every node's successors are ranked before
  // the node itself.
  const queue: string[] = [];
  for (const n of nodes) if (indeg.get(n.id) === 0) queue.push(n.id);
  const topo: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    topo.push(id);
    for (const s of succs.get(id)!) {
      const d = (indeg.get(s) ?? 0) - 1;
      indeg.set(s, d);
      if (d === 0) queue.push(s);
    }
  }
  const rankFromSink = new Map<string, number>();
  for (const n of nodes) rankFromSink.set(n.id, 0);
  // Walk topo in reverse so successors are visited before predecessors.
  for (let i = topo.length - 1; i >= 0; i--) {
    const id = topo[i];
    let r = 0;
    for (const s of succs.get(id)!) {
      r = Math.max(r, (rankFromSink.get(s) ?? 0) + 1);
    }
    rankFromSink.set(id, r);
  }
  const maxSinkRank = Math.max(0, ...Array.from(rankFromSink.values()));
  // Flip: layer index counts from top of screen, so sinks (rankFromSink 0)
  // go on the LAST layer. Mixed relations retain the existing ranking semantics.
  const rank = new Map<string, number>();
  for (const [id, r] of rankFromSink) {
    rank.set(id, maxSinkRank - r);
  }
  const maxRank = maxSinkRank;

  // ---- 2b. Dummy-node insertion for long edges (cat 2026-07-10 §4).
  //
  // A long edge A(r=k) → B(r=k+m) with m>1 skips intermediate layers and
  // has no barycentre input for the sort — this is exactly the
  // "很左边的拉一条边到最右边" symptom cat flagged. Fix: replace each
  // long edge with a chain A → d1(r=k+1) → d2(r=k+2) → … → B, where
  // d_i are virtual dummies that participate in ordering but render as
  // waypoints on the real edge.
  //
  // `dummiesByEdge` holds the chain per original edge id (in visit
  // order — d1 at rank k+1, d2 at k+2, …). Empty for short edges.
  interface DummyRec { id: string; rank: number }
  const dummiesByEdge = new Map<string, DummyRec[]>();
  // `layerPreds` and `layerSuccs` are the PER-LAYER-PAIR adjacency we
  // sort against. They include dummies + real nodes.
  const layerPreds = new Map<string, string[]>();
  const layerSuccs = new Map<string, string[]>();
  const initEdges = (id: string): void => {
    if (!layerPreds.has(id)) layerPreds.set(id, []);
    if (!layerSuccs.has(id)) layerSuccs.set(id, []);
  };
  for (const n of nodes) initEdges(n.id);

  // Track dummy rank for later coord assignment.
  const dummyRank = new Map<string, number>();

  let dummyCounter = 0;
  for (const e of forwardEdges) {
    const rFrom = rank.get(e.from)!;
    const rTo = rank.get(e.to)!;
    if (rTo - rFrom <= 1) {
      // Short edge: direct sort input.
      layerSuccs.get(e.from)!.push(e.to);
      layerPreds.get(e.to)!.push(e.from);
      continue;
    }
    // Long edge: create dummies at every intermediate rank.
    const chain: DummyRec[] = [];
    for (let r = rFrom + 1; r < rTo; r++) {
      const id = `__dummy_${dummyCounter++}`;
      chain.push({ id, rank: r });
      dummyRank.set(id, r);
      initEdges(id);
    }
    dummiesByEdge.set(e.id, chain);
    // Link the chain: from → d1 → d2 → … → to.
    let prev = e.from;
    for (const d of chain) {
      layerSuccs.get(prev)!.push(d.id);
      layerPreds.get(d.id)!.push(prev);
      prev = d.id;
    }
    layerSuccs.get(prev)!.push(e.to);
    layerPreds.get(e.to)!.push(prev);
  }

  // ---- 3. Bucket into layers (real + dummy) + barycentre sort
  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const n of nodes) layers[rank.get(n.id) ?? 0].push(n.id);
  for (const [id, r] of dummyRank) layers[r].push(id);
  // Initial deterministic order (real first for stability, then dummies).
  for (const layer of layers) {
    layer.sort((a, b) => {
      const ad = a.startsWith('__dummy_');
      const bd = b.startsWith('__dummy_');
      if (ad !== bd) return ad ? 1 : -1;
      return compareLexically(a, b);
    });
  }
  const orderIdx = new Map<string, number>();
  const recomputeOrder = (): void => {
    for (const layer of layers) {
      layer.forEach((id, i) => orderIdx.set(id, i));
    }
  };
  recomputeOrder();

  // Barycentre = arithmetic mean of neighbour positions. Cat 2026-07-10
  // §4: "根据下层依赖节点的 x 值取平均后比大小然后横向排列" — the
  // downstream direction uses successor barycentre.
  const barycentre = (arr: number[]): number => {
    if (arr.length === 0) return -1;
    let s = 0;
    for (const v of arr) s += v;
    return s / arr.length;
  };
  // Alternate down and up passes. 8 iterations is more than enough at
  // typical sizes and cheap thanks to O(|E|) per pass. Barycentre with
  // dummies inserted converges to a Sugiyama-quality layout.
  for (let iter = 0; iter < 8; iter++) {
    // Down pass: layer li's order sorted by mean of PREDECESSOR positions.
    for (let li = 1; li < layers.length; li++) {
      const layer = layers[li];
      const key = new Map<string, number>();
      for (const id of layer) {
        const ps = layerPreds.get(id) ?? [];
        key.set(id, barycentre(ps.map((p) => orderIdx.get(p) ?? 0)));
      }
      layer.sort((a, b) => {
        const ka = key.get(a) ?? -1;
        const kb = key.get(b) ?? -1;
        if (ka === kb) return compareLexically(a, b);
        return ka - kb;
      });
    }
    recomputeOrder();
    // Up pass: layer li's order sorted by mean of SUCCESSOR positions.
    // Cat's spec framed it as "下层" (successors) explicitly.
    for (let li = layers.length - 2; li >= 0; li--) {
      const layer = layers[li];
      const key = new Map<string, number>();
      for (const id of layer) {
        const ss = layerSuccs.get(id) ?? [];
        key.set(id, barycentre(ss.map((s) => orderIdx.get(s) ?? 0)));
      }
      layer.sort((a, b) => {
        const ka = key.get(a) ?? -1;
        const kb = key.get(b) ?? -1;
        if (ka === kb) return compareLexically(a, b);
        return ka - kb;
      });
    }
    recomputeOrder();
  }

  // ---- 4. Assign pixel coordinates.
  // Layer width computed with per-node auto-sizing; dummies collapsed
  // to zero-width slots (they still contribute a gap for routing).
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const nodeW = (id: string): number => {
    if (id.startsWith('__dummy_')) return DUMMY_W;
    const src = nodeById.get(id)!;
    return nodeWidthFor(src.kind, src.title);
  };
  const layerWidth = (layer: string[]): number => {
    let w = 0;
    for (const id of layer) w += nodeW(id);
    if (layer.length > 1) w += (layer.length - 1) * NODE_GAP_X;
    return w;
  };
  const maxRowW = Math.max(0, ...layers.map((l) => layerWidth(l)));
  const totalWidth = MARGIN * 2 + maxRowW;
  const totalHeight =
    MARGIN * 2 + layers.length * NODE_H + (layers.length - 1) * LAYER_GAP_Y;

  const laidNodesById = new Map<string, LaidOutNode>();
  const dummyCentres = new Map<string, { x: number; y: number }>();

  layers.forEach((layer, li) => {
    const rowW = layerWidth(layer);
    let x = (totalWidth - rowW) / 2;
    const y = MARGIN + li * (NODE_H + LAYER_GAP_Y);
    for (const id of layer) {
      const isDummy = id.startsWith('__dummy_');
      const w = nodeW(id);
      if (isDummy) {
        dummyCentres.set(id, { x: x + w / 2, y: y + NODE_H / 2 });
      } else {
        const src = nodeById.get(id)!;
        laidNodesById.set(id, {
          id,
          isDummy: false,
          title: src.title,
          kind: src.kind,
          kindId: src.kindId,
          color: src.color,
          background: src.background,
          packageId: src.packageId || '_unpackaged',
          x,
          y,
          w,
          h: NODE_H
        });
      }
      x += w + NODE_GAP_X;
    }
  });

  // ---- 5. Deterministic package lanes.
  // Package is an Entry storage identity. It intentionally has no connection
  // to the Library tree, which is a separate authored graph projection.
  const clusterNodes = new Map<string, LaidOutNode[]>();
  for (const node of laidNodesById.values()) {
    const members = clusterNodes.get(node.packageId) ?? [];
    members.push(node);
    clusterNodes.set(node.packageId, members);
  }
  const packageIds = [...clusterNodes.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const clusters: LaidOutCluster[] = [];
  let clusterX = MARGIN;
  for (const packageId of packageIds) {
    const members = clusterNodes.get(packageId)!;
    const rows = new Map<number, LaidOutNode[]>();
    for (const node of members) {
      const row = rows.get(node.y) ?? [];
      row.push(node);
      rows.set(node.y, row);
    }
    const rowWidths = [...rows.values()].map((row) =>
      row.reduce((sum, node) => sum + node.w, 0) + Math.max(0, row.length - 1) * NODE_GAP_X
    );
    const laneW = Math.max(160, ...rowWidths) + CLUSTER_PADDING_X * 2;
    for (const row of rows.values()) {
      row.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const rowW = row.reduce((sum, node) => sum + node.w, 0) + Math.max(0, row.length - 1) * NODE_GAP_X;
      let nodeX = clusterX + (laneW - rowW) / 2;
      for (const node of row) {
        node.x = nodeX;
        node.y += CLUSTER_HEADER_H;
        nodeX += node.w + NODE_GAP_X;
      }
    }
    clusters.push({
      packageId,
      x: clusterX,
      y: MARGIN / 2,
      w: laneW,
      h: totalHeight + CLUSTER_HEADER_H,
      nodeCount: members.length
    });
    clusterX += laneW + CLUSTER_GAP_X;
  }

  const clusteredWidth = clusterX - CLUSTER_GAP_X + MARGIN;
  const clusteredHeight = totalHeight + CLUSTER_HEADER_H + MARGIN / 2;

  // ---- 6. Build edges with waypoints threaded through dummies.
  const laidEdges: LaidOutEdge[] = [];
  for (const e of edges) {
    if (!laidNodesById.has(e.from) || !laidNodesById.has(e.to)) continue;
    const fromNode = laidNodesById.get(e.from)!;
    const toNode = laidNodesById.get(e.to)!;
    const fromCentreY = fromNode.y + fromNode.h / 2;
    const toCentreY = toNode.y + toNode.h / 2;
    const dummies = dummiesByEdge.get(e.id) ?? [];
    const waypoints = dummies
      .map((d) => dummyCentres.get(d.id))
      .filter((p): p is { x: number; y: number } => !!p)
      .map((point) => {
        const y = point.y + CLUSTER_HEADER_H;
        const t = toCentreY === fromCentreY ? 0.5 : (y - fromCentreY) / (toCentreY - fromCentreY);
        const fromX = fromNode.x + fromNode.w / 2;
        const toX = toNode.x + toNode.w / 2;
        return { x: fromX + t * (toX - fromX), y };
      });
    laidEdges.push({
      ...e,
      isBack: backEdgeIds.has(e.id),
      waypoints
    });
  }

  const rectangle: Layout = {
    nodes: Array.from(laidNodesById.values()),
    edges: laidEdges,
    clusters,
    width: clusteredWidth,
    height: clusteredHeight
  };
  return mode === 'rectangle' ? rectangle : radialLayout(rectangle, mode);
}

/** A deterministic projection of the final rectangular package lanes, not a
 * second ordering/layout algorithm. Cards stay upright and keep their size. */
function radialLayout(rectangle: Layout, mode: Exclude<GraphLayoutMode, 'rectangle'>): Layout {
  const centres = rectangle.nodes.map(n => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 }));
  const xMin = rectangle.clusters[0].x;
  const lastCluster = rectangle.clusters[rectangle.clusters.length - 1];
  const xSpan = lastCluster.x + lastCluster.w - xMin;
  const yMin = Math.min(...centres.map(p => p.y));
  const maxLayer = (Math.max(...centres.map(p => p.y)) - yMin) / (NODE_H + LAYER_GAP_Y);
  const startAngle = -Math.PI / 2 + Math.PI / 24;
  const sweep = 2 * Math.PI - Math.PI / 12; // open seam, including for a single package
  const angle = (x: number): number => startAngle + (x - xMin) / xSpan * sweep;
  const extent = Math.max(...rectangle.nodes.map(n => Math.hypot(n.w, n.h) / 2));
  // Circumscribed card discs guarantee separation for upright rectangles at
  // every angle. Adjacent angular gaps (including the seam) suffice per ring.
  // Size for *all* rows: either direction may place any one of them innermost.
  let innerRadius = extent + NODE_GAP_X;
  const rows = new Map<number, number[]>();
  for (const c of centres) {
    const row = rows.get(c.y) ?? [];
    row.push(angle(c.x));
    rows.set(c.y, row);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a - b);
    if (row.length < 2) continue;
    for (let i = 0; i < row.length; i++) {
      const gap = i + 1 < row.length ? row[i + 1] - row[i] : row[0] + 2 * Math.PI - row[i];
      innerRadius = Math.max(innerRadius, (2 * extent + NODE_GAP_X) / (2 * Math.sin(gap / 2)));
    }
  }
  // Sparse rows can have no same-ring neighbours yet belong to very narrow
  // package wedges. Reserve their card discs inside both angular boundaries.
  const clusterById = new Map(rectangle.clusters.map(c => [c.packageId, c]));
  for (let i = 0; i < rectangle.nodes.length; i++) {
    const n = rectangle.nodes[i], c = clusterById.get(n.packageId)!;
    const clearance = Math.min(Math.PI / 2, angle(centres[i].x) - angle(c.x), angle(c.x + c.w) - angle(centres[i].x));
    innerRadius = Math.max(innerRadius, (Math.hypot(n.w, n.h) / 2 + 4) / Math.sin(clearance));
  }
  const layerGap = Math.max(NODE_H + LAYER_GAP_Y, 2 * extent + NODE_GAP_X);
  const outerRadius = innerRadius + maxLayer * layerGap;
  const sectorInner = Math.max(1, innerRadius - extent - CLUSTER_PADDING_X / 2);
  const sectorOuter = outerRadius + extent + CLUSTER_HEADER_H;
  // Label allowance also contains a visible self-loop above a card.
  const size = 2 * (sectorOuter + MARGIN + extent);
  const radial: RadialProjection = {
    centerX: size / 2, centerY: size / 2, innerRadius, layerGap, maxLayer,
    xMin, xSpan, yMin, startAngle, sweep
  };
  const polar = (a: number, r: number): EdgePoint => ({
    x: radial.centerX + Math.cos(a) * r, y: radial.centerY + Math.sin(a) * r
  });
  const project = (point: EdgePoint): EdgePoint => {
    const screenLayer = (point.y - yMin) / (NODE_H + LAYER_GAP_Y);
    const layer = mode === 'radial-outward' ? maxLayer - screenLayer : screenLayer;
    return polar(angle(point.x), innerRadius + layer * layerGap);
  };
  return {
    width: size, height: size, radial,
    nodes: rectangle.nodes.map((n, i) => {
      const p = project(centres[i]);
      return { ...n, x: p.x - n.w / 2, y: p.y - n.h / 2 };
    }),
    edges: rectangle.edges.map(e => ({ ...e, waypoints: e.waypoints.map(project) })),
    clusters: rectangle.clusters.map(c => {
      const start = angle(c.x), end = angle(c.x + c.w);
      const a = polar(start, sectorOuter), b = polar(end, sectorOuter);
      const d = polar(start, sectorInner), e = polar(end, sectorInner);
      const large = end - start > Math.PI ? 1 : 0;
      const label = polar((start + end) / 2, sectorOuter - 12);
      return { ...c, sector: {
        startAngle: start, endAngle: end, labelX: label.x, labelY: label.y,
        path: `M ${a.x} ${a.y} A ${sectorOuter} ${sectorOuter} 0 ${large} 1 ${b.x} ${b.y} L ${e.x} ${e.y} A ${sectorInner} ${sectorInner} 0 ${large} 0 ${d.x} ${d.y} Z`
      } };
    })
  };
}

// ---------------------------------------------------------------------------
// SVG rendering + pan / zoom
// ---------------------------------------------------------------------------

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

/** The edge router only needs node bounds, not the rest of the graph record. */
type EdgeAnchorNode = Pick<LaidOutNode, 'x' | 'y' | 'w' | 'h'> & { dotRadius?: number; cornerRadius?: number };
type EdgePoint = { x: number; y: number };
type NodeShape = 'dot' | 'title';
type GraphNodeMode = 'auto' | 'always-title';
const DOT_RADIUS = 6;
const CARD_RADIUS = 4;

export function graphNodePresentation<T extends EdgeAnchorNode>(node: T, viewportScale: number, active: boolean) {
  const scale = Math.max(Number.EPSILON, viewportScale);
  const presentationScale = active ? Math.max(1, 1 / scale) : 1;
  const w = node.w * presentationScale, h = node.h * presentationScale;
  return {
    ...node, x: node.x + (node.w - w) / 2, y: node.y + (node.h - h) / 2, w, h,
    presentationScale, dotRadius: Math.max(DOT_RADIUS, 2 / scale),
    cornerRadius: CARD_RADIUS * presentationScale
  };
}

/** Intersect a centre ray with the actual circle or rounded-card outline. */
function nodeBoundary(node: EdgeAnchorNode, toward: EdgePoint, shape: NodeShape): EdgePoint {
  const cx = node.x + node.w / 2, cy = node.y + node.h / 2;
  const dx = toward.x - cx, dy = toward.y - cy;
  const length = Math.hypot(dx, dy);
  const ux = length ? dx / length : 1, uy = length ? dy / length : 0;
  let distance = node.dotRadius ?? DOT_RADIUS;
  if (shape === 'title') {
    const cornerRadius = node.cornerRadius ?? CARD_RADIUS;
    const ax = Math.abs(ux), ay = Math.abs(uy);
    const hw = node.w / 2, hh = node.h / 2;
    distance = Math.min(ax ? hw / ax : Infinity, ay ? hh / ay : Infinity);
    if (distance * ax > hw - cornerRadius && distance * ay > hh - cornerRadius) {
      const cornerX = hw - cornerRadius, cornerY = hh - cornerRadius;
      const dot = ax * cornerX + ay * cornerY;
      distance = dot + Math.sqrt(Math.max(0, dot * dot - cornerX * cornerX - cornerY * cornerY + cornerRadius * cornerRadius));
    }
  }
  return { x: cx + ux * distance, y: cy + uy * distance };
}

/**
 * Compute an SVG path for an edge, routing through any dummy-node waypoints.
 *
 * Explicit shapes route from the actual outline toward the adjacent waypoint
 * (or opposite centre); this works at every radial angle and for reverse edges.
 * Omitting shapes preserves the legacy rectangular vertical-port API.
 * Interior tangents follow the centred secant through neighbouring waypoints.
 */
export function edgePath(
  from: EdgeAnchorNode,
  to: EdgeAnchorNode,
  waypoints: EdgePoint[],
  shapes?: { fromShape: NodeShape; toShape: NodeShape }
): { d: string; midX: number; midY: number } {
  const fromCentre = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const toCentre = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  if (shapes && fromCentre.x === toCentre.x && fromCentre.y === toCentre.y) {
    const start = nodeBoundary(from, { x: fromCentre.x + 1, y: fromCentre.y }, shapes.fromShape);
    const end = nodeBoundary(to, { x: toCentre.x, y: toCentre.y - 1 }, shapes.toShape);
    const right = from.x + from.w + 36, top = from.y - 36;
    return {
      d: `M ${start.x} ${start.y} C ${right} ${start.y}, ${right} ${top}, ${fromCentre.x + from.w / 2} ${top} C ${end.x} ${top}, ${end.x} ${top}, ${end.x} ${end.y}`,
      midX: right, midY: top
    };
  }
  const start = shapes ? nodeBoundary(from, waypoints[0] ?? toCentre, shapes.fromShape)
    : { x: fromCentre.x, y: from.y + from.h };
  const end = shapes ? nodeBoundary(to, waypoints[waypoints.length - 1] ?? fromCentre, shapes.toShape)
    : { x: toCentre.x, y: to.y };
  const x1 = start.x, y1 = start.y, x2 = end.x, y2 = end.y;
  const pts: EdgePoint[] = [{ x: x1, y: y1 }, ...waypoints, { x: x2, y: y2 }];
  const last = pts.length - 1;
  const tangents = pts.map((point, index): EdgePoint => {
    if (index === 0) {
      if (shapes) return { x: (pts[1].x - point.x) * 0.5, y: (pts[1].y - point.y) * 0.5 };
      return { x: 0, y: (pts[1].y - point.y) * 1.5 };
    }
    if (index === last) {
      if (shapes) return { x: (point.x - pts[last - 1].x) * 0.5, y: (point.y - pts[last - 1].y) * 0.5 };
      return { x: 0, y: (point.y - pts[last - 1].y) * 1.5 };
    }
    return {
      x: (pts[index + 1].x - pts[index - 1].x) * 0.5,
      y: (pts[index + 1].y - pts[index - 1].y) * 0.5
    };
  });

  const segments: string[] = [`M ${pts[0].x} ${pts[0].y}`];
  for (let index = 1; index < pts.length; index++) {
    const start = pts[index - 1];
    const end = pts[index];
    const startTangent = tangents[index - 1];
    const endTangent = tangents[index];
    segments.push(
      `C ${start.x + startTangent.x / 3} ${start.y + startTangent.y / 3}, ` +
      `${end.x - endTangent.x / 3} ${end.y - endTangent.y / 3}, ` +
      `${end.x} ${end.y}`
    );
  }
  return {
    d: segments.join(' '),
    midX: (x1 + x2) / 2,
    midY: (y1 + y2) / 2
  };
}

/** Selection is represented by a thicker stroke; never replace the themed fill. */
export function graphNodeFill(background: string, _highlighted: boolean): string {
  return background && background !== 'transparent'
    ? background
    : 'var(--vscode-editorWidget-background, #252526)';
}

export function SnlGraphApp(): React.ReactElement {
  const apiRef = useVsCodeApiRef();
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
    >
      <SnlGraphInner msg={msg} graphError={graphError} post={post} apiRef={apiRef} />
    </HoverPopoverProvider>
  );
}

function SnlGraphInner({
  msg,
  graphError,
  post,
  apiRef
}: {
  msg: GraphMessage | null;
  graphError: GraphErrorMessage | null;
  post: (m: unknown) => void;
  apiRef: React.MutableRefObject<VsCodeApi | undefined>;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
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
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  // Panel-local controls survive host refreshes, but never affect graph order
  // or fitting except when the layout itself changes.
  const [layoutMode, setLayoutMode] = useState<GraphLayoutMode>('rectangle');
  const [nodeMode, setNodeMode] = useState<GraphNodeMode>('auto');
  const [titleThreshold, setTitleThreshold] = useState(120);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 'all' = every edge; 'atomic-deps' = keep user-authored edges +
   *  dependency edges with isAtomic===true only (cat 2026-07-10 §4). */
  const [depFilter, setDepFilter] = useState<'all' | 'atomic-deps'>('all');
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
    return layout(filteredNodes, filteredEdges, layoutMode);
  }, [msg, depFilter, kindFilter, clauses, contentLanguage, preferencesRevision, layoutMode]);

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

  // Fit on host refresh and an explicit layout change, never presentation.
  useEffect(() => {
    if (!laid || !svgRef.current) return;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (laid.width === 0 || laid.height === 0) return;
    const s = Math.min(
      1,
      (rect.width - 40) / laid.width,
      (rect.height - 40) / laid.height
    );
    setVp({
      x: (rect.width - laid.width * s) / 2,
      y: 20,
      scale: s
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msg, layoutMode]);

  const onWheel = useCallback((e: WheelEvent): void => {
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

  const nodesById = new Map(laid.nodes.map(n => [n.id,
    graphNodePresentation(n, vp.scale, hoverNodeId === n.id || focusNodeId === n.id)]));
  const nodeShape = (id: string): NodeShape =>
    nodeMode === 'always-title' || vp.scale >= titleThreshold / 100 || hoverNodeId === id || focusNodeId === id
      ? 'title' : 'dot';
  // Stable keys preserve DOM/focus while raised cards paint above dots. Hover
  // and keyboard focus remain separate so leaving either doesn't clear both.
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
    setSelectedId((prev) => (prev === n.id ? null : n.id));
  };

  return (
    <main
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
          title={msg.title}
          back={{
            label: t('infoview'),
            title: t('backInfoview'),
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
          kindUniverse={kindUniverse}
          kindFilter={kindFilter}
          onKindFilterChange={setKindFilter}
          clauses={clauses}
          onClausesChange={setClauses}
          onAddClause={addClause}
          relationshipUniverse={relationshipUniverse}
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
            {t(msg.nodes.length > 0 ? 'filteredEmpty' : 'empty')}
          </div>
        ) : (
          <svg
            ref={bindSvg}
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
                    <text
                      x={cluster.sector?.labelX ?? cluster.x + CLUSTER_PADDING_X}
                      y={cluster.sector?.labelY ?? cluster.y + 22}
                      textAnchor={cluster.sector ? 'middle' : undefined}
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
                const { d } = edgePath(from, to, e.waypoints, { fromShape: nodeShape(from.id), toShape: nodeShape(to.id) });
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
                    role="button"
                    tabIndex={0}
                    aria-label={t('relationshipAria', { label: e.label || e.id, from: e.from, to: e.to })}
                    onPointerEnter={() => setHoverEdgeId(e.id)}
                    onPointerLeave={() =>
                      setHoverEdgeId((c) => (c === e.id ? null : c))
                    }
                    style={{ cursor: 'pointer' }}
                    onClick={() =>
                      post({ type: 'editRelationship', id: e.id })
                    }
                    onFocus={() => setHoverEdgeId(e.id)}
                    onBlur={() => setHoverEdgeId((c) => (c === e.id ? null : c))}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
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
              {paintedNodes.map((n) => {
                const presentation = nodesById.get(n.id)!;
                const isHovered = hoverNodeId === n.id;
                const isSelected = selectedId === n.id;
                const showTitle = nodeShape(n.id) === 'title';
                const highlighted = isHovered || isSelected || focusNodeId === n.id;
                const stroke = n.color;
                const fill = graphNodeFill(n.background, highlighted);
                const titleHtml = showTitle ? renderTitleKatex(n.title) : '';
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
                      setSelectedId((previous) => previous === n.id ? null : n.id);
                    }}
                  >
                    {/* Cat 2026-07-10 §3: dropped the native <title>
                        tooltip — the full-Entry hover popover already
                        carries every fact this used to duplicate. */}
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
                    </> : <circle cx={n.w / 2} cy={n.h / 2} r={presentation.dotRadius}
                      fill={fill} stroke={stroke} strokeWidth={Math.max(highlighted ? 3.5 : 2, 1 / vp.scale)} />}
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
  kindUniverse,
  kindFilter,
  onKindFilterChange,
  clauses,
  onClausesChange,
  onAddClause,
  relationshipUniverse
}: {
  open: boolean;
  onToggle: () => void;
  depFilter: 'all' | 'atomic-deps';
  onDepFilterChange: (v: 'all' | 'atomic-deps') => void;
  kindUniverse: Array<{ kindId: string; label: string; color: string }>;
  kindFilter: Set<string> | null;
  onKindFilterChange: (v: Set<string> | null) => void;
  clauses: GraphFilterClause[];
  onClausesChange: (clauses: GraphFilterClause[]) => void;
  onAddClause: () => void;
  relationshipUniverse: string[];
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
                : relationshipUniverse.map(value => ({ value, label: value || t('emptyRelationshipLabel'), unavailable: false }));
              const availableValues = new Set(options.map(option => option.value));
              // Missing selections remain real predicates. Keep them editable
              // (not disabled) so an empty result can always be recovered.
              for (const value of clause.values) {
                if (!availableValues.has(value)) options.push({ value, unavailable: true,
                  label: t('unavailableFilterValue', { value: value || t('emptyRelationshipLabel') }) });
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
