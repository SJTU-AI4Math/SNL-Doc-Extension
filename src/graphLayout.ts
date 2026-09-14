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
  /** Internal layout metadata threaded through dummy centers. Endpoint-only
   *  rendering ignores these points; retain them to preserve node placement. */
  waypoints: { x: number; y: number }[];
}

export interface Layout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  clusters: LaidOutCluster[];
  width: number;
  height: number;
  radial?: RadialProjection;
}

export type GraphLayoutMode = 'rectangle' | 'radial-inward' | 'radial-outward';
export type GraphLayerPacking = 'bands' | 'rings';
export interface RadialProjection {
  centerX: number;
  centerY: number;
  innerRadius: number;
  packing: GraphLayerPacking;
  /** Continuous x/radius samples per displayed layer, inner to outer. */
  radiusSamples: Array<Array<{ x: number; radius: number }>>;
  /** Outer centre radius per layer (the common radius in strict rings). */
  layerRadii: number[];
  maxLayer: number;
  xMin: number;
  xSpan: number;
  yMin: number;
  startAngle: number;
  sweep: number;
}

export interface LaidOutCluster {
  packageId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  nodeCount: number;
  sector?: { path: string; startAngle: number; endAngle: number; outerRadius: number; labelAngle: number; labelX: number; labelY: number };
}

const NODE_H = 66;
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
const NODE_W_MIN = 135;
const NODE_W_MAX = 480;
const NODE_PADDING_X = 30; // left + right combined
/** Approximate pixel width per character at the label's font-size / weight. */
const CHAR_W_TITLE = 11.25; // 19.5px, weight 600
const CHAR_W_KIND = 9;      // 16.5px, weight normal

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

export const GRAPH_LAYOUT_VERSION = '2';
export const DEFAULT_LAYOUT_PARAMETERS = Object.freeze({ nodeGapX: NODE_GAP_X, layerGapY: LAYER_GAP_Y, mode: 'rectangle' as GraphLayoutMode, packing: 'bands' as GraphLayerPacking });
export interface LayoutParameters { nodeGapX: number; layerGapY: number; mode?: GraphLayoutMode; packing?: GraphLayerPacking }
/** Fixed metrics are explicit fingerprint inputs as well as versioned code. */
export const LAYOUT_METRICS = Object.freeze({ NODE_H, MARGIN, CLUSTER_GAP_X, CLUSTER_PADDING_X,
  CLUSTER_HEADER_H, DUMMY_W, NODE_W_MIN, NODE_W_MAX, NODE_PADDING_X, CHAR_W_TITLE, CHAR_W_KIND, passes: 8 });

export function layout(inputNodes: GraphNode[], inputEdges: GraphEdge[], parameters: LayoutParameters | GraphLayoutMode = DEFAULT_LAYOUT_PARAMETERS, legacyPacking: GraphLayerPacking = 'bands'): Layout {
  const settings = typeof parameters === 'string' ? { ...DEFAULT_LAYOUT_PARAMETERS, mode: parameters, packing: legacyPacking } : parameters;
  const mode = settings.mode ?? 'rectangle', packing = settings.packing ?? 'bands';
  if (![settings.nodeGapX, settings.layerGapY].every(n => Number.isFinite(n) && n >= 0 && n <= 1000) ||
      !['rectangle','radial-inward','radial-outward'].includes(mode) || !['bands','rings'].includes(packing)) throw new Error('Invalid layout parameters');
  const NODE_GAP_X = settings.nodeGapX, LAYER_GAP_Y = settings.layerGapY;
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
  // d_i are virtual dummies that participate in ordering. Their coordinates
  // remain layout metadata; endpoint-only edge rendering ignores them.
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

  const rectangle: Layout = {
    nodes: Array.from(laidNodesById.values()),
    edges: laidEdges,
    clusters,
    width: clusteredWidth,
    height: clusteredHeight
  };
  return mode === 'rectangle' ? rectangle : radialLayout(rectangle, mode, packing, LAYER_GAP_Y);
}

/** Broad phase for upright title rectangles. Bounded card dimensions mean
 * each card occupies at most four cells. No all-pairs relaxation or physics. */
class CardGrid<T extends { x: number; y: number; w: number; h: number }> {
  private cells = new Map<string, T[]>();
  private keys(n: T): string[] {
    const keys: string[] = [];
    for (let x = Math.floor((n.x - 6) / (NODE_W_MAX + 12)); x <= Math.floor((n.x + n.w + 6) / (NODE_W_MAX + 12)); x++) {
      for (let y = Math.floor((n.y - 6) / (NODE_H + 12)); y <= Math.floor((n.y + n.h + 6) / (NODE_H + 12)); y++) keys.push(`${x},${y}`);
    }
    return keys;
  }
  add(n: T): void {
    for (const key of this.keys(n)) {
      const cell = this.cells.get(key) ?? [];
      cell.push(n); this.cells.set(key, cell);
    }
  }
  collisions(n: T): T[] {
    const found = new Set<T>();
    for (const key of this.keys(n)) for (const other of this.cells.get(key) ?? []) {
      if (n.x < other.x + other.w + 12 && other.x < n.x + n.w + 12 &&
          n.y < other.y + other.h + 12 && other.y < n.y + n.h + 12) found.add(other);
    }
    return [...found];
  }
}

/** Preserve package-lane x angles and semantic heights. Pack upright cards
 * in ordered bands or strict rings. Decoration never constrains nodes. */
function radialLayout(rectangle: Layout, mode: Exclude<GraphLayoutMode, 'rectangle'>, packing: GraphLayerPacking, LAYER_GAP_Y: number): Layout {
  const centres = rectangle.nodes.map(n => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 }));
  const xMin = rectangle.clusters[0].x;
  const lastCluster = rectangle.clusters[rectangle.clusters.length - 1];
  const xSpan = lastCluster.x + lastCluster.w - xMin;
  const yMin = Math.min(...centres.map(p => p.y));
  const maxLayer = Math.round((Math.max(...centres.map(p => p.y)) - yMin) / (NODE_H + LAYER_GAP_Y));
  const startAngle = -Math.PI / 2 + Math.PI / 24;
  const sweep = 2 * Math.PI - Math.PI / 12;
  const angle = (x: number): number => startAngle + (x - xMin) / xSpan * sweep;
  const layerOf = (y: number): number => {
    const screenLayer = (y - yMin) / (NODE_H + LAYER_GAP_Y);
    return mode === 'radial-outward' ? maxLayer - screenLayer : screenLayer;
  };
  const rows = Array.from({ length: maxLayer + 1 }, () => [] as Array<LaidOutNode & { ux: number; uy: number }>);
  rectangle.nodes.forEach((n, i) => {
    const a = angle(centres[i].x);
    rows[Math.round(layerOf(centres[i].y))].push({ ...n, ux: Math.cos(a), uy: Math.sin(a) });
  });
  const layerRadii: number[] = [];
  const nodeRadii = new Map<string, number>();
  const placed = new CardGrid<LaidOutNode>();
  let occupiedOuter = 0;
  for (const row of rows) {
    row.sort((a, b) => a.x + a.w / 2 - b.x - b.w / 2);
    let radius = layerRadii.length ? layerRadii[layerRadii.length - 1] + 12 : 24;
    if (packing === 'bands') {
      const inner = radius;
      let outer = inner;
      for (const n of row) {
        let r = inner;
        const cardAt = () => ({ ...n, x: r * n.ux - n.w / 2, y: r * n.uy - n.h / 2 });
        // Static ray/AABB clearance: skip the forbidden interval containing r.
        // The grid bounds each query to nearby cards. A fixed pass cap keeps
        // adversarial near-collinear layers from becoming quadratic; fallback
        // clears the occupied envelope and is certified without another scan.
        let clear = false;
        for (let pass = 0; pass < 128; pass++) {
          const collisions = placed.collisions(cardAt());
          if (!collisions.length) { clear = true; break; }
          let next = r;
          for (const other of collisions) {
            const exitX = Math.abs(n.ux) < 1e-12 ? Infinity :
              (n.ux > 0 ? other.x + other.w + n.w / 2 + 12 : other.x - n.w / 2 - 12) / n.ux;
            const exitY = Math.abs(n.uy) < 1e-12 ? Infinity :
              (n.uy > 0 ? other.y + other.h + n.h / 2 + 12 : other.y - n.h / 2 - 12) / n.uy;
            next = Math.max(next, Math.min(exitX, exitY) + 1e-6);
          }
          r = next;
        }
        if (!clear) r = Math.max(r, occupiedOuter + Math.hypot(n.w / 2 + 12, n.h / 2 + 12) + 1e-6);
        const card = cardAt();
        placed.add(card); nodeRadii.set(n.id, r);
        outer = Math.max(outer, r);
        occupiedOuter = Math.max(occupiedOuter, ...[card.x, card.x + card.w].flatMap(x =>
          [card.y, card.y + card.h].map(y => Math.hypot(x, y))));
      }
      layerRadii.push(outer);
      continue;
    }
    const requiredRadius = (a: typeof row[number], b: typeof row[number]): number => Math.min(
      ((a.w + b.w) / 2 + 12) / Math.abs(a.ux - b.ux),
      ((a.h + b.h) / 2 + 12) / Math.abs(a.uy - b.uy)
    );
    if (row.length > 1) for (let i = 0; i < row.length; i++) {
      radius = Math.max(radius, requiredRadius(row[i], row[(i + 1) % row.length]));
    }
    const atRadius = (n: typeof row[number], r: number) => ({ ...n, x: r * n.ux - n.w / 2, y: r * n.uy - n.h / 2 });
    // Adjacent angular neighbours give a cheap lower bound. Check non-neighbours
    // too (wide cards near a pole, including the seam). Same-ring separation
    // grows monotonically with radius: ONE pass at the lower bound suffices.
    const ring = new CardGrid<typeof row[number]>();
    let sameRingRadius = radius;
    for (const n of row) {
      const card = atRadius(n, radius);
      for (const other of ring.collisions(card)) sameRingRadius = Math.max(sameRingRadius, requiredRadius(n, other));
      ring.add(card);
    }
    radius = sameRingRadius + 1e-6;
    // Ray vs expanded rectangle: jump to the exit of current forbidden intervals.
    // Eight bounded passes, not simulation steps. A rare crowded fallback clears
    // the occupied radial envelope; this is NOT the normal per-layer spacing.
    let clear = false;
    for (let pass = 0; pass < 8; pass++) {
      let next = radius;
      for (const n of row) for (const other of placed.collisions(atRadius(n, radius))) {
        const exitX = Math.abs(n.ux) < 1e-12 ? Infinity :
          (n.ux > 0 ? other.x + other.w + n.w / 2 + 12 : other.x - n.w / 2 - 12) / n.ux;
        const exitY = Math.abs(n.uy) < 1e-12 ? Infinity :
          (n.uy > 0 ? other.y + other.h + n.h / 2 + 12 : other.y - n.h / 2 - 12) / n.uy;
        next = Math.max(next, Math.min(exitX, exitY) + 1e-6);
      }
      if (next === radius) { clear = true; break; }
      radius = next;
    }
    if (!clear) radius = Math.max(radius, occupiedOuter + Math.max(...row.map(n => Math.hypot(n.w, n.h) / 2)) + 12);
    layerRadii.push(radius);
    for (const n of row) {
      const card = atRadius(n, radius);
      nodeRadii.set(n.id, radius);
      placed.add(card);
      occupiedOuter = Math.max(occupiedOuter, ...[card.x, card.x + card.w].flatMap(x =>
        [card.y, card.y + card.h].map(y => Math.hypot(x, y))));
    }
  }
  const radiusSamples = rows.map(row => row.map(n => ({ x: n.x + n.w / 2, radius: nodeRadii.get(n.id)! })));
  // Piecewise-linear in original x, then in semantic layer. Node centres are
  // exact samples; dummy route points use the same continuous display map.
  const radiusAt = (layer: number, x: number): number => {
    const samples = radiusSamples[layer];
    if (!samples.length) return layerRadii[layer];
    if (x <= samples[0].x) return samples[0].radius;
    let lo = 0, hi = samples.length - 1;
    if (x >= samples[hi].x) return samples[hi].radius;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (samples[mid].x <= x) lo = mid; else hi = mid;
    }
    const a = samples[lo], b = samples[hi];
    return a.radius + (x - a.x) / (b.x - a.x) * (b.radius - a.radius);
  };
  const innerRadius = Math.min(...nodeRadii.values());
  const extent = Math.max(...rectangle.nodes.map(n => Math.hypot(n.w, n.h) / 2));
  const size = 2 * (occupiedOuter + CLUSTER_HEADER_H + MARGIN);
  const radial: RadialProjection = {
    centerX: size / 2, centerY: size / 2, innerRadius, layerRadii, radiusSamples, packing, maxLayer,
    xMin, xSpan, yMin, startAngle, sweep
  };
  const polar = (a: number, r: number): EdgePoint => ({
    x: radial.centerX + Math.cos(a) * r, y: radial.centerY + Math.sin(a) * r
  });
  const project = (point: EdgePoint): EdgePoint => {
    const layer = Math.max(0, Math.min(maxLayer, layerOf(point.y)));
    const lo = Math.floor(layer), hi = Math.ceil(layer);
    const a = radiusAt(lo, point.x), b = radiusAt(hi, point.x);
    return polar(angle(point.x), a + (layer - lo) * (b - a));
  };
  const nodes = rectangle.nodes.map((n, i) => {
    const p = project(centres[i]);
    return { ...n, x: p.x - n.w / 2, y: p.y - n.h / 2 };
  });
  const packages = new Map<string, { inner: number; outer: number }>();
  nodes.forEach(n => {
    const r = nodeRadii.get(n.id)!;
    const prev = packages.get(n.packageId);
    packages.set(n.packageId, { inner: Math.min(prev?.inner ?? Infinity, r), outer: Math.max(prev?.outer ?? 0, r) });
  });
  return {
    width: size, height: size, radial, nodes,
    edges: rectangle.edges.map(e => ({ ...e, waypoints: e.waypoints.map(project) })),
    clusters: rectangle.clusters.map(c => {
      const members = packages.get(c.packageId)!;
      const sectorInner = Math.max(1, members.inner - extent - 12);
      const sectorOuter = members.outer + extent + CLUSTER_HEADER_H;
      const start = angle(c.x), end = angle(c.x + c.w);
      const a = polar(start, sectorOuter), b = polar(end, sectorOuter);
      const d = polar(start, sectorInner), e = polar(end, sectorInner);
      const large = end - start > Math.PI ? 1 : 0;
      const labelAngle = (start + end) / 2;
      const label = polar(labelAngle, sectorOuter);
      return { ...c, sector: {
        startAngle: start, endAngle: end, outerRadius: sectorOuter, labelAngle, labelX: label.x, labelY: label.y,
        path: `M ${a.x} ${a.y} A ${sectorOuter} ${sectorOuter} 0 ${large} 1 ${b.x} ${b.y} L ${e.x} ${e.y} A ${sectorInner} ${sectorInner} 0 ${large} 0 ${d.x} ${d.y} Z`
      } };
    })
  };
}

/** The edge router only needs node bounds, not the rest of the graph record. */
export type EdgeAnchorNode = Pick<LaidOutNode, 'x' | 'y' | 'w' | 'h'> & { dotRadius?: number; cornerRadius?: number };
export type EdgePoint = { x: number; y: number };
export type NodeShape = 'dot' | 'title';
export type GraphNodeMode = 'auto' | 'always-title';
export const DOT_RADIUS = 12;
export const CARD_RADIUS = 6;
export const TITLE_VIEWPORT_MARGIN = 256; // CSS pixels, independent of world zoom

/** Node geometry stays in world units; only the viewport applies zoom.
 * Hover/focus change detail, never compensate size in screen space. */
export function graphNodePresentation<T extends EdgeAnchorNode>(node: T, _viewportScale: number, _active: boolean) {
  return { ...node, presentationScale: 1, dotRadius: DOT_RADIUS, cornerRadius: CARD_RADIUS };
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

type EdgeCubic = { start: EdgePoint; c1: EdgePoint; c2: EdgePoint; end: EdgePoint };
const offsetPoint = (p: EdgePoint, direction: EdgePoint, distance: number): EdgePoint => ({
  x: p.x + direction.x * distance, y: p.y + direction.y * distance
});

/** Facing radial ports, joined through a short intermediate arc. Distinct
 * radii use canonical inner-to-outer travel; equal radii retain the outside
 * orbit. This is endpoint geometry, never avoidance or a layout operation. */
function radialEdgePath(from: EdgeAnchorNode, to: EdgeAnchorNode,
  fromShape: NodeShape, toShape: NodeShape, origin: EdgePoint) {
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  // Calculate once inner-to-outer, using a spatial tie break on equal rings.
  // Reversing controls also preserves the exactly-antipodal choice.
  const fr = Math.hypot(fc.x - origin.x, fc.y - origin.y);
  const tr = Math.hypot(tc.x - origin.x, tc.y - origin.y);
  const distinct = Math.abs(fr - tr) > 1e-8;
  const reverse = distinct ? fr > tr : fc.x > tc.x || (fc.x === tc.x && fc.y > tc.y);
  const a = reverse ? to : from, b = reverse ? from : to;
  const ac = reverse ? tc : fc, bc = reverse ? fc : tc;
  const aShape = reverse ? toShape : fromShape, bShape = reverse ? fromShape : toShape;
  const ar = Math.hypot(ac.x - origin.x, ac.y - origin.y);
  const br = Math.hypot(bc.x - origin.x, bc.y - origin.y);
  // A node exactly at the center has no polar direction: use its partner's
  // ray. Coincident centers (including two central endpoints) use the loop.
  const aa = Math.atan2((ar ? ac : bc).y - origin.y, (ar ? ac : bc).x - origin.x);
  const ba = Math.atan2((br ? bc : ac).y - origin.y, (br ? bc : ac).x - origin.x);
  let sweep = Math.atan2(Math.sin(ba - aa), Math.cos(ba - aa));
  if (Math.abs(Math.abs(sweep) - Math.PI) < 1e-14) sweep = Math.PI;
  const au = { x: Math.cos(aa), y: Math.sin(aa) }, bu = { x: Math.cos(ba), y: Math.sin(ba) };
  const port = (n: EdgeAnchorNode, c: EdgePoint, u: EdgePoint, shape: NodeShape, sign = 1) =>
    nodeBoundary(n, offsetPoint(c, u, sign), shape);
  let curves: EdgeCubic[];
  let middle: EdgePoint;
  // Equal angles at distinct radii need no orbital turn. The small tolerance
  // absorbs atan2 roundoff from the layout's sin/cos projection, not real turns.
  const facingStart = port(a, ac, au, aShape), facingEnd = port(b, bc, bu, bShape, -1);
  const facingSR = (facingStart.x - origin.x) * au.x + (facingStart.y - origin.y) * au.y;
  const facingER = (facingEnd.x - origin.x) * bu.x + (facingEnd.y - origin.y) * bu.y;
  if (distinct && (Math.abs(sweep) < 1e-14 || facingER <= 1e-8)) {
    const start = facingStart, end = facingEnd;
    // Coincident rays, or an enlarged outer card covering the origin, cannot
    // use a positive-radius orbit. Keep the specified signed endpoint ports.
    const handle = facingER > facingSR + 1e-8
      ? (facingER - facingSR) / 3
      : Math.max(1, Math.min(32, Math.hypot(end.x - start.x, end.y - start.y) / 3));
    curves = [{ start, c1: offsetPoint(start, au, handle), c2: offsetPoint(end, bu, -handle), end }];
    middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  } else {
    const start = facingStart, end = distinct ? facingEnd : port(b, bc, bu, bShape);
    const sr = Math.hypot(start.x - origin.x, start.y - origin.y);
    const er = Math.hypot(end.x - origin.x, end.y - origin.y);
    const direction = sweep < 0 ? -1 : 1;
    const turn = Math.min(Math.abs(sweep) / 4, Math.PI / 8);
    // Keep the radial controls before the orbit's projected radius, providing
    // a positive outward departure even for equal endpoint radii.
    const radius = distinct ? (sr + er) / 2 : Math.max(sr, er) / Math.cos(turn) + 24;
    // Independent wedge bounds keep the first handle outward and the last
    // handle inward of the outer port, with same-oriented tangent joins.
    const orderedPorts = distinct && er > sr + 1e-8;
    const firstTurn = orderedPorts ? Math.min(turn, Math.acos(sr / radius) / 2) : turn;
    const lastTurn = orderedPorts ? Math.min(turn, Math.acos(radius / er) / 2) : turn;
    const polar = (angle: number): EdgePoint => offsetPoint(origin, { x: Math.cos(angle), y: Math.sin(angle) }, radius);
    const tangent = (angle: number): EdgePoint => ({ x: -Math.sin(angle) * direction, y: Math.cos(angle) * direction });
    const firstAngle = aa + direction * firstTurn, lastAngle = aa + sweep - direction * lastTurn;
    const first = polar(firstAngle), last = polar(lastAngle);
    const firstHandle = radius * Math.tan(firstTurn / 2), lastHandle = radius * Math.tan(lastTurn / 2);
    // Radial extents may cross even for disjoint cards on opposite rays.
    // Keep the short orbit and positive radial departure; never replace it
    // with a diameter shortcut. Controls stay inside their angular wedges.
    const departure = distinct && !orderedPorts ? Math.min(24, sr / 2)
      : (radius * Math.cos(firstTurn) - sr) / 2;
    const arrivalControl = !distinct ? (radius * Math.cos(lastTurn) - er) / 2
      : orderedPorts ? (radius / Math.cos(lastTurn) - er) / 2 : -Math.min(24, er / 2);
    curves = [{ start, c1: offsetPoint(start, au, departure),
      c2: offsetPoint(first, tangent(firstAngle), -firstHandle), end: first }];
    // At most two circular cubics; each spans <= pi/2. Their standard controls
    // preserve the short angular sweep rather than cutting a chord inward.
    const count = Math.max(1, Math.ceil(Math.abs(lastAngle - firstAngle) / (Math.PI / 2)));
    for (let i = 0; i < count; i++) {
      const angle = firstAngle + (lastAngle - firstAngle) * i / count;
      const nextAngle = firstAngle + (lastAngle - firstAngle) * (i + 1) / count;
      const p = curves[curves.length - 1].end, q = i === count - 1 ? last : polar(nextAngle);
      const handle = 4 / 3 * radius * Math.tan(Math.abs(nextAngle - angle) / 4);
      curves.push({ start: p, c1: offsetPoint(p, tangent(angle), handle),
        c2: offsetPoint(q, tangent(nextAngle), -handle), end: q });
    }
    curves.push({ start: last, c1: offsetPoint(last, tangent(lastAngle), lastHandle),
      c2: offsetPoint(end, bu, arrivalControl), end });
    middle = polar(aa + sweep / 2);
  }
  if (reverse) curves = curves.reverse().map(c => ({ start: c.end, c1: c.c2, c2: c.c1, end: c.start }));
  const start = curves[0].start;
  return { d: `M ${start.x} ${start.y} ` + curves.map(c =>
    `C ${c.c1.x} ${c.c1.y}, ${c.c2.x} ${c.c2.y}, ${c.end.x} ${c.end.y}`).join(' '),
    midX: middle.x, midY: middle.y };
}

/** Endpoint-only routing. Layout dummies still stabilize node ordering, but
 * never influence rendered paths. Omitting context selects vertical ports. */
export function edgePath(
  from: EdgeAnchorNode,
  to: EdgeAnchorNode,
  _waypoints: EdgePoint[],
  shapes?: { fromShape: NodeShape; toShape: NodeShape },
  context?: { radial?: Pick<RadialProjection, 'centerX' | 'centerY'> }
): { d: string; midX: number; midY: number } {
  const fromCentre = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const toCentre = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  if (fromCentre.x === toCentre.x && fromCentre.y === toCentre.y) {
    const start = nodeBoundary(from, { x: fromCentre.x + 1, y: fromCentre.y }, shapes?.fromShape ?? 'title');
    const end = nodeBoundary(to, { x: toCentre.x, y: toCentre.y - 1 }, shapes?.toShape ?? 'title');
    const right = from.x + from.w + 36, top = from.y - 36;
    return {
      d: `M ${start.x} ${start.y} C ${right} ${start.y}, ${right} ${top}, ${fromCentre.x + from.w / 2} ${top} C ${end.x} ${top}, ${end.x} ${top}, ${end.x} ${end.y}`,
      midX: right, midY: top
    };
  }
  if (context?.radial) return radialEdgePath(from, to,
    shapes?.fromShape ?? 'title', shapes?.toShape ?? 'title',
    { x: context.radial.centerX, y: context.radial.centerY });
  // Canonical lower-to-upper traversal, with left-to-right as the same-level
  // tie break. Swapping the relationship reverses the controls, never its IDs.
  const reverse = fromCentre.y < toCentre.y ||
    (fromCentre.y === toCentre.y && fromCentre.x > toCentre.x);
  const a = reverse ? to : from, b = reverse ? from : to;
  const ac = reverse ? toCentre : fromCentre, bc = reverse ? fromCentre : toCentre;
  const aShape = (reverse ? shapes?.toShape : shapes?.fromShape) ?? 'title';
  const bShape = (reverse ? shapes?.fromShape : shapes?.toShape) ?? 'title';
  const start = nodeBoundary(a, { x: ac.x, y: ac.y - 1 }, aShape);
  const end = nodeBoundary(b, { x: bc.x, y: bc.y + 1 }, bShape);
  const handle = Math.max(24, Math.abs(start.y - end.y) / 2);
  const c1 = { x: start.x, y: start.y - handle };
  const c2 = { x: end.x, y: end.y + handle };
  const [p, q, r, t] = reverse ? [end, c2, c1, start] : [start, c1, c2, end];
  return {
    d: `M ${p.x} ${p.y} C ${q.x} ${q.y}, ${r.x} ${r.y}, ${t.x} ${t.y}`,
    midX: (start.x + end.x) / 2, midY: (start.y + end.y) / 2
  };
}
