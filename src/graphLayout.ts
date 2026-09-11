/** Pure main-branch Sugiyama/package-lane geometry shared by Host and HTML.
 * No React, DOM, filesystem, storage or user interaction state belongs here. */
export interface GraphNode {
  id: string;
  packageId: string;
  title: string;
  kind: string;
  kindId: string;
  color: string;
  background: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  isDependency: boolean;
  isAtomic: boolean | null;
}

const compareLexically = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export interface LaidOutNode {
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

export interface LaidOutEdge extends GraphEdge {
  isBack: boolean; // was reversed during cycle-break; render dashed
  /** X/Y waypoints threaded through dummy-node centres between endpoints.
   *  Endpoints themselves are NOT included; empty for short (single-layer)
   *  edges. */
  waypoints: { x: number; y: number }[];
}

export interface Layout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  clusters: LaidOutCluster[];
  width: number;
  height: number;
}

export interface LaidOutCluster {
  packageId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  nodeCount: number;
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

export const GRAPH_LAYOUT_VERSION = '1';
export const DEFAULT_LAYOUT_PARAMETERS = Object.freeze({ nodeGapX: NODE_GAP_X, layerGapY: LAYER_GAP_Y });
export interface LayoutParameters { nodeGapX: number; layerGapY: number }
/** Fixed metrics are explicit fingerprint inputs as well as versioned code. */
export const LAYOUT_METRICS = Object.freeze({ NODE_H, MARGIN, CLUSTER_GAP_X, CLUSTER_PADDING_X,
  CLUSTER_HEADER_H, DUMMY_W, NODE_W_MIN, NODE_W_MAX, NODE_PADDING_X, CHAR_W_TITLE, CHAR_W_KIND, passes: 8 });

export function layout(inputNodes: GraphNode[], inputEdges: GraphEdge[], parameters: LayoutParameters = DEFAULT_LAYOUT_PARAMETERS): Layout {
  if (![parameters.nodeGapX, parameters.layerGapY].every(n => Number.isFinite(n) && n >= 0 && n <= 1000)) throw new Error('Invalid layout parameters');
  const NODE_GAP_X = parameters.nodeGapX, LAYER_GAP_Y = parameters.layerGapY;
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
      let id: string;
      do { id = `__dummy_${dummyCounter++}`; } while (nodeIndex.has(id));
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
      const ad = dummyRank.has(a);
      const bd = dummyRank.has(b);
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
    if (dummyRank.has(id)) return DUMMY_W;
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
      const isDummy = dummyRank.has(id);
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

  return {
    nodes: Array.from(laidNodesById.values()),
    edges: laidEdges,
    clusters,
    width: clusteredWidth,
    height: clusteredHeight
  };
}

/** The edge router only needs node bounds, not the rest of the graph record. */
type EdgeAnchorNode = Pick<LaidOutNode, 'x' | 'y' | 'w' | 'h'>;
type EdgePoint = { x: number; y: number };

/**
 * Compute an SVG path for an edge, routing through any dummy-node waypoints.
 *
 * The source and target tangents stay vertical, so edges leave and enter node
 * boxes cleanly. Interior tangents instead follow the centred secant through
 * the neighbouring points. The old router reset both controls to the waypoint
 * x at every layer, which forced an extra vertical-looking section into the
 * middle of every long curve.
 */
export function edgePath(
  from: EdgeAnchorNode,
  to: EdgeAnchorNode,
  waypoints: EdgePoint[]
): { d: string; midX: number; midY: number } {
  const x1 = from.x + from.w / 2;
  const y1 = from.y + from.h;
  const x2 = to.x + to.w / 2;
  const y2 = to.y;
  const pts: EdgePoint[] = [{ x: x1, y: y1 }, ...waypoints, { x: x2, y: y2 }];
  const last = pts.length - 1;
  const tangents = pts.map((point, index): EdgePoint => {
    if (index === 0) {
      return { x: 0, y: (pts[1].y - point.y) * 1.5 };
    }
    if (index === last) {
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
