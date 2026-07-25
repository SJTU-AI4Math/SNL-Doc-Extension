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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { getVsCodeApi, PANEL_STYLE, type VsCodeApi } from './vscodeApi';
import { PanelNav } from './components/PanelNav';
import { Button } from './components/Button';
import { HoverPopoverProvider, useHoverPopovers, useCurrentPopoverId } from './render/HoverPopoverProvider';
import type { EntryOption } from './render/EntryRender';
import type { MacroRecord } from './render/macroData';
import {
  macroKindsToPalette,
  type MacroKindPaletteSource
} from './render/macroKindPalette';

interface GraphNode {
  id: string;
  title: string;
  kind: string;
  kindId: string;
  color: string;
  background: string;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  isDependency: boolean;
  isAtomic: boolean | null;
}

type Scope = { mode: 'pool' } | { mode: 'library'; slug: string };

interface GraphMessage {
  type: 'graph';
  scope: Scope;
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
  /** Full pool for popover render (cross-entry macro source resolution). */
  entryOptions?: EntryOption[];
  /** Workspace-wide macros for popover EntryRender. */
  macros?: MacroRecord;
  macroKinds?: MacroKindPaletteSource[];
}

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
  width: number;
  height: number;
}

const NODE_H = 44;
const LAYER_GAP_Y = 90;
const NODE_GAP_X = 24;
const MARGIN = 40;
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

function layout(nodes: GraphNode[], edges: GraphEdge[]): Layout {
  if (nodes.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
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
  // Flip: layer index counts from top of screen, so sinks (largest
  // rankFromSink) go on the LAST layer.
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
      return a.localeCompare(b);
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
        if (ka === kb) return a.localeCompare(b);
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
        if (ka === kb) return a.localeCompare(b);
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
          x,
          y,
          w,
          h: NODE_H
        });
      }
      x += w + NODE_GAP_X;
    }
  });

  // ---- 5. Build edges with waypoints threaded through dummies.
  const laidEdges: LaidOutEdge[] = [];
  for (const e of edges) {
    if (!laidNodesById.has(e.from) || !laidNodesById.has(e.to)) continue;
    const dummies = dummiesByEdge.get(e.id) ?? [];
    const waypoints = dummies
      .map((d) => dummyCentres.get(d.id))
      .filter((p): p is { x: number; y: number } => !!p);
    laidEdges.push({
      ...e,
      isBack: backEdgeIds.has(e.id),
      waypoints
    });
  }

  return {
    nodes: Array.from(laidNodesById.values()),
    edges: laidEdges,
    width: totalWidth,
    height: totalHeight
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Compute an SVG path for an edge, routing through any waypoints
 * (dummy-node centres inserted at intermediate layers). Segments between
 * consecutive waypoints (or endpoint↔waypoint) are cubic beziers with
 * vertical control tangents so the overall path stays smooth.
 */
function edgePath(
  from: LaidOutNode,
  to: LaidOutNode,
  waypoints: { x: number; y: number }[]
): { d: string; midX: number; midY: number } {
  const x1 = from.x + from.w / 2;
  const y1 = from.y + from.h;
  const x2 = to.x + to.w / 2;
  const y2 = to.y;
  // Full point sequence: source-anchor, waypoints…, target-anchor.
  const pts = [{ x: x1, y: y1 }, ...waypoints, { x: x2, y: y2 }];
  const segments: string[] = [`M ${pts[0].x} ${pts[0].y}`];
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const dy = p1.y - p0.y;
    const c1y = p0.y + dy * 0.5;
    const c2y = p1.y - dy * 0.5;
    segments.push(
      `C ${p0.x} ${c1y}, ${p1.x} ${c2y}, ${p1.x} ${p1.y}`
    );
  }
  // Label anchor: middle of the WHOLE run (endpoint-to-endpoint midpoint
  // is fine even with waypoints, since we're hiding labels for now).
  return {
    d: segments.join(' '),
    midX: (x1 + x2) / 2,
    midY: (y1 + y2) / 2
  };
}

export function SnlGraphApp(): React.ReactElement {
  const apiRef = useRef<VsCodeApi | undefined>(undefined);
  const [msg, setMsg] = useState<GraphMessage | null>(null);

  useEffect(() => {
    apiRef.current = getVsCodeApi();
    function onMessage(event: MessageEvent): void {
      const m = event.data as GraphMessage | undefined;
      if (!m || m.type !== 'graph') return;
      setMsg(m);
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

  // Popover provider needs the pool + macros; both come from the host.
  return (
    <HoverPopoverProvider
      postMessage={post}
      entries={msg?.entryOptions ?? []}
      userMacros={msg?.macros ?? {}}
      kindPalette={kindPalette}
    >
      <SnlGraphInner msg={msg} post={post} apiRef={apiRef} />
    </HoverPopoverProvider>
  );
}

function SnlGraphInner({
  msg,
  post,
  apiRef
}: {
  msg: GraphMessage | null;
  post: (m: unknown) => void;
  apiRef: React.MutableRefObject<VsCodeApi | undefined>;
}): React.ReactElement {
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
  const [depFilter, setDepFilter] = useState<'all' | 'atomic-deps'>('all');
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
    const filteredNodes = kindKeptNodes.filter((n) => kept.has(n.id));
    return layout(filteredNodes, filteredEdges);
  }, [msg, depFilter, kindFilter]);

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
      seen.set(n.kindId, { kindId: n.kindId, label: n.kind, color: n.color });
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [msg]);

  // Fit-to-view on first load.
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
  }, [msg]);

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
        <p style={{ opacity: 0.7 }}>Loading graph…</p>
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
      <div style={{ padding: '0 0.75rem' }}>
        <PanelNav
          vsApi={apiRef.current}
          back={{
            label: '← Infoview',
            title: 'Back to SNL Infoview',
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
          <h1 style={{ margin: 0, fontSize: '1.1rem' }}>{msg.title}</h1>
          <div style={{ opacity: 0.7, fontSize: '0.8rem' }}>
            {displayedNodeCount} node{displayedNodeCount === 1 ? '' : 's'} ·{' '}
            {displayedEdgeCount} edge{displayedEdgeCount === 1 ? '' : 's'}
            {backEdgeCount > 0
              ? ` · ${backEdgeCount} cycle-breaking back-edge${backEdgeCount === 1 ? '' : 's'} (dashed)`
              : ''}
            {' · isolated nodes hidden'}
            {selectedId
              ? ` · selected: ${nodesById.get(selectedId)?.title ?? selectedId}`
              : ''}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>
            scroll to zoom · drag to pan · click node → select · Ctrl+click → open Infoview
          </div>
        </div>
      </div>
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
            No relationships to show. Add some from the Dashboard →
            Relationships section.
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
                    onPointerEnter={() => setHoverEdgeId(e.id)}
                    onPointerLeave={() =>
                      setHoverEdgeId((c) => (c === e.id ? null : c))
                    }
                    style={{ cursor: 'pointer' }}
                    onClick={() =>
                      post({ type: 'editRelationship', id: e.id })
                    }
                  >
                    <title>
                      {e.label}
                      {e.isDependency && e.isAtomic !== null
                        ? ` (${e.isAtomic ? 'atomic' : 'composite'})`
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
                // Cat 2026-07-10: hover/selection → OPAQUE WHITE bg
                // (dark-vs-light theme handling deferred). Text color
                // stays at the node's kind-stroke color, which reads
                // fine on white.
                const highlighted = isHovered || isSelected;
                const stroke = n.color;
                const fill = highlighted
                  ? '#ffffff'
                  : n.background && n.background !== 'transparent'
                    ? n.background
                    : 'var(--vscode-editorWidget-background, #252526)';
                const titleHtml = renderTitleKatex(n.title);
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x} ${n.y})`}
                    style={{ cursor: 'pointer' }}
                    onPointerEnter={(ev) => handleNodePointerEnter(n, ev)}
                    onPointerMove={(ev) => handleNodePointerMove(n, ev)}
                    onPointerLeave={() => handleNodePointerLeave(n)}
                    onClick={(ev) => handleNodeClick(n, ev)}
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
        title={open ? 'Collapse filters' : 'Expand filters'}
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
        {open ? '▶ Filters' : '◀ Filters'}
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
            Edges
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
                ? 'Currently hiding non-atomic (composite) dependency edges. Uncheck to show every edge.'
                : 'Currently showing every edge. Check to hide non-atomic dependency edges.'
            }
          >
            <input
              type="checkbox"
              checked={depFilter === 'atomic-deps'}
              onChange={(e) =>
                onDepFilterChange(e.target.checked ? 'atomic-deps' : 'all')
              }
            />
            <span>atomic deps only</span>
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
            <span>Entry kinds</span>
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
              title="Show every entry kind (reset kind filter)"
            >
              all
            </Button>
            <Button
              type="button"
              onClick={() => onKindFilterChange(new Set())}
              style={smallLinkBtn}
              title="Hide every entry kind"
            >
              none
            </Button>
          </div>
          {totalKindCount === 0 ? (
            <p style={{ opacity: 0.55, fontSize: '0.8rem', margin: 0 }}>
              No entry kinds in this graph yet.
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
