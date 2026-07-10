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
import { getVsCodeApi, PANEL_STYLE, type VsCodeApi } from './vscodeApi';
import { PanelNav } from './components/PanelNav';

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
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface LaidOutNode extends GraphNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LaidOutEdge extends GraphEdge {
  isBack: boolean; // was reversed during cycle-break; render dashed
}

interface Layout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

const NODE_W = 220;
const NODE_H = 44;
const LAYER_GAP_Y = 90;
const NODE_GAP_X = 24;
const MARGIN = 40;

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
    // Iterative DFS with a small state stack to avoid blowing recursion on
    // ~10k nodes.
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
  // Topological order via Kahn.
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, preds.get(n.id)!.length);
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
  // Rank = 1 + max(pred.rank) (roots at rank 0).
  const rank = new Map<string, number>();
  for (const n of nodes) rank.set(n.id, 0);
  for (const id of topo) {
    let r = 0;
    for (const p of preds.get(id)!) {
      r = Math.max(r, (rank.get(p) ?? 0) + 1);
    }
    rank.set(id, r);
  }
  const maxRank = Math.max(0, ...Array.from(rank.values()));

  // ---- 3. Bucket into layers + median-sort to reduce crossings
  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const n of nodes) {
    layers[rank.get(n.id) ?? 0].push(n.id);
  }
  // Initial order: by id for determinism.
  for (const layer of layers) layer.sort();
  const orderIdx = new Map<string, number>();
  const recomputeOrder = (): void => {
    for (const layer of layers) {
      layer.forEach((id, i) => orderIdx.set(id, i));
    }
  };
  recomputeOrder();
  const median = (arr: number[]): number => {
    if (arr.length === 0) return -1;
    const sorted = arr.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  // Two passes: down (use predecessor medians), up (use successor medians).
  for (let iter = 0; iter < 4; iter++) {
    for (let li = 1; li < layers.length; li++) {
      const layer = layers[li];
      const key = new Map<string, number>();
      for (const id of layer) {
        const ps = preds.get(id)!;
        key.set(
          id,
          median(ps.map((p) => orderIdx.get(p) ?? 0))
        );
      }
      layer.sort((a, b) => {
        const ka = key.get(a) ?? -1;
        const kb = key.get(b) ?? -1;
        if (ka === kb) return a.localeCompare(b);
        // -1 (no preds) → stays at start
        return ka - kb;
      });
    }
    recomputeOrder();
    for (let li = layers.length - 2; li >= 0; li--) {
      const layer = layers[li];
      const key = new Map<string, number>();
      for (const id of layer) {
        const ss = succs.get(id)!;
        key.set(
          id,
          median(ss.map((s) => orderIdx.get(s) ?? 0))
        );
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
  const maxWidthNodes = Math.max(...layers.map((l) => l.length));
  const totalWidth =
    MARGIN * 2 + Math.max(1, maxWidthNodes) * NODE_W +
    Math.max(0, maxWidthNodes - 1) * NODE_GAP_X;
  const totalHeight =
    MARGIN * 2 + layers.length * NODE_H + (layers.length - 1) * LAYER_GAP_Y;

  const laidNodesById = new Map<string, LaidOutNode>();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  layers.forEach((layer, li) => {
    const rowW =
      layer.length * NODE_W + Math.max(0, layer.length - 1) * NODE_GAP_X;
    const startX = (totalWidth - rowW) / 2;
    layer.forEach((id, i) => {
      const src = nodeById.get(id)!;
      laidNodesById.set(id, {
        ...src,
        x: startX + i * (NODE_W + NODE_GAP_X),
        y: MARGIN + li * (NODE_H + LAYER_GAP_Y),
        w: NODE_W,
        h: NODE_H
      });
    });
  });

  const laidEdges: LaidOutEdge[] = edges
    .filter((e) => laidNodesById.has(e.from) && laidNodesById.has(e.to))
    .map((e) => ({ ...e, isBack: backEdgeIds.has(e.id) }));

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

/** Compute an SVG path for an edge, curving to avoid horizontal collinearity. */
function edgePath(
  from: LaidOutNode,
  to: LaidOutNode
): { d: string; midX: number; midY: number } {
  const x1 = from.x + from.w / 2;
  const y1 = from.y + from.h;
  const x2 = to.x + to.w / 2;
  const y2 = to.y;
  // Cubic bezier with vertical control points.
  const dy = y2 - y1;
  const c1y = y1 + dy * 0.5;
  const c2y = y2 - dy * 0.5;
  const d = `M ${x1} ${y1} C ${x1} ${c1y}, ${x2} ${c2y}, ${x2} ${y2}`;
  return { d, midX: (x1 + x2) / 2, midY: (y1 + y2) / 2 };
}

export function SnlGraphApp(): React.ReactElement {
  const apiRef = useRef<VsCodeApi | undefined>(undefined);
  const [msg, setMsg] = useState<GraphMessage | null>(null);
  const [vp, setVp] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState<null | {
    startX: number;
    startY: number;
    vpX: number;
    vpY: number;
  }>(null);
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null);
  /** 'all' = every edge; 'atomic-deps' = keep user-authored edges +
   *  dependency edges with isAtomic===true only (cat 2026-07-10 §4). */
  const [depFilter, setDepFilter] = useState<'all' | 'atomic-deps'>('all');
  const svgRef = useRef<SVGSVGElement | null>(null);

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

  const laid = useMemo<Layout | null>(() => {
    if (!msg) return null;
    // Apply the dependency filter (cat 2026-07-10 §4). In 'atomic-deps'
    // mode we drop non-atomic dependency edges but keep everything else
    // (user-authored rows, non-depends labels). Then re-hide nodes that
    // are now isolated in the filtered graph.
    const filteredEdges =
      depFilter === 'atomic-deps'
        ? msg.edges.filter(
            (e) => !e.isDependency || e.isAtomic === true
          )
        : msg.edges;
    const kept = new Set<string>();
    for (const e of filteredEdges) {
      kept.add(e.from);
      kept.add(e.to);
    }
    const filteredNodes = msg.nodes.filter((n) => kept.has(n.id));
    return layout(filteredNodes, filteredEdges);
  }, [msg, depFilter]);

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
    // Only run once per new graph.
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

  const post = (m: unknown): void => apiRef.current?.postMessage(m);

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

  return (
    <main
      style={{
        ...PANEL_STYLE,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        maxWidth: 'none',
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
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            type="button"
            onClick={() =>
              setDepFilter((v) => (v === 'all' ? 'atomic-deps' : 'all'))
            }
            title={
              depFilter === 'all'
                ? 'Click to hide non-atomic dependency edges'
                : 'Click to show every edge'
            }
            style={{
              padding: '0.25rem 0.6rem',
              fontFamily: 'inherit',
              fontSize: '0.8rem',
              border:
                '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
              borderRadius: '3px',
              background:
                depFilter === 'atomic-deps'
                  ? 'var(--vscode-button-background, #0e639c)'
                  : 'var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06))',
              color:
                depFilter === 'atomic-deps'
                  ? 'var(--vscode-button-foreground, white)'
                  : 'inherit',
              cursor: 'pointer'
            }}
          >
            {depFilter === 'atomic-deps'
              ? '● atomic deps only'
              : '○ all edges'}
          </button>
          <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>
            scroll to zoom · drag to pan · click node → open Infoview
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
            {/* Background hit-target so pan works even where there are no nodes. */}
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
                const { d, midX, midY } = edgePath(from, to);
                const hovered = hoverEdgeId === e.id;
                const nonAtomicDep = e.isDependency && e.isAtomic === false;
                const baseOpacity = nonAtomicDep ? 0.28 : 0.55;
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
                    <path
                      d={d}
                      fill="none"
                      stroke="var(--vscode-editor-foreground, #ddd)"
                      strokeOpacity={hovered ? 1 : baseOpacity}
                      strokeWidth={hovered ? 2 : 1.2}
                      strokeDasharray={e.isBack ? '5 4' : undefined}
                      markerEnd="url(#snl-graph-arrow)"
                    />
                    {e.label ? (
                      <g transform={`translate(${midX} ${midY})`}>
                        <rect
                          x={-Math.min(80, e.label.length * 4 + 6)}
                          y={-9}
                          width={Math.min(160, e.label.length * 8 + 12)}
                          height={18}
                          rx={3}
                          ry={3}
                          fill="var(--vscode-editor-background, #1e1e1e)"
                          fillOpacity={hovered ? 0.95 : 0.75}
                          stroke="var(--vscode-editor-foreground, #ddd)"
                          strokeOpacity={hovered ? 0.7 : 0.25}
                        />
                        <text
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={11}
                          fontFamily="var(--vscode-editor-font-family, monospace)"
                          fill="var(--vscode-editor-foreground, #ddd)"
                        >
                          {truncate(e.label, 24)}
                        </text>
                      </g>
                    ) : null}
                  </g>
                );
              })}
              {/* Nodes */}
              {laid.nodes.map((n) => (
                <g
                  key={n.id}
                  transform={`translate(${n.x} ${n.y})`}
                  style={{ cursor: 'pointer' }}
                  onClick={() =>
                    post({ type: 'openEntryInfoview', entryId: n.id })
                  }
                >
                  <title>
                    {n.title}
                    {'\n'}
                    id: {n.id}
                    {'\n'}
                    kind: {n.kind}
                  </title>
                  <rect
                    width={n.w}
                    height={n.h}
                    rx={4}
                    ry={4}
                    fill={
                      n.background && n.background !== 'transparent'
                        ? n.background
                        : 'var(--vscode-editorWidget-background, #252526)'
                    }
                    stroke={n.color}
                    strokeWidth={2}
                  />
                  <text
                    x={10}
                    y={16}
                    fontSize={11}
                    fontFamily="var(--vscode-editor-font-family, monospace)"
                    opacity={0.65}
                    fill="var(--vscode-editor-foreground, #ddd)"
                  >
                    {truncate(n.kind, 22)}
                  </text>
                  <text
                    x={10}
                    y={34}
                    fontSize={13}
                    fontWeight={600}
                    fill="var(--vscode-editor-foreground, #ddd)"
                  >
                    {truncate(n.title, 26)}
                  </text>
                </g>
              ))}
            </g>
          </svg>
        )}
      </div>
    </main>
  );
}
