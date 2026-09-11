import { layout, GRAPH_LAYOUT_VERSION, DEFAULT_LAYOUT_PARAMETERS, LAYOUT_METRICS,
  type GraphNode, type GraphEdge, type Layout, type LayoutParameters } from './graphLayout';

export interface GraphLayoutInput {
  version: string;
  library: string | null;
  language: string;
  parameters: LayoutParameters;
  metrics: typeof LAYOUT_METRICS;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface GraphLayoutArtifact { key: string; layout: Layout }
const lexical = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Input is the rendered graph projection, not a saved filter selection. Coloring is
 * deliberately absent: the current theme is reapplied to nodes after geometry lookup. */
export function graphLayoutInput(library: string | null, language: string, nodes: GraphNode[], edges: GraphEdge[],
  parameters: LayoutParameters = DEFAULT_LAYOUT_PARAMETERS): GraphLayoutInput {
  const ids = new Set(nodes.map(n => n.id));
  const validEdges = edges.filter(e => ids.has(e.from) && ids.has(e.to));
  const participating = new Set(validEdges.flatMap(e => [e.from, e.to]));
  return {
    version: GRAPH_LAYOUT_VERSION, library, language,
    parameters: { nodeGapX: parameters.nodeGapX, layerGapY: parameters.layerGapY }, metrics: LAYOUT_METRICS,
    nodes: nodes.filter(n => participating.has(n.id)).map(n => ({ id: n.id, packageId: n.packageId || '_unpackaged',
      title: n.title, kind: n.kind, kindId: n.kindId, color: '', background: '' })).sort(lexical),
    edges: validEdges.map(e => ({ id: e.id, from: e.from, to: e.to, label: e.label,
      isDependency: e.isDependency, isAtomic: e.isAtomic })).sort(lexical)
  };
}
/** Canonical own-field projection is constructed above. A full key avoids weak browser hashes. */
export const graphLayoutKey = (input: GraphLayoutInput): string => JSON.stringify(input);
export const generateGraphLayout = (input: GraphLayoutInput): Layout => layout(input.nodes, input.edges, input.parameters);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e9;
const keys = (v: Record<string, unknown>, expected: string[]): boolean => Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));

/** Cache bytes can never inject titles, styles, identities, dangling routes, nonfinite
 * SVG coordinates, or viewport/selection state. Validate against the CURRENT input. */
export function isGraphLayout(value: unknown, input: GraphLayoutInput): value is Layout {
  if (!object(value) || !keys(value, ['nodes','edges','clusters','width','height']) ||
      !finite(value.width) || !finite(value.height) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.clusters) ||
      value.nodes.length !== input.nodes.length || value.edges.length !== input.edges.length) return false;
  const width = value.width, height = value.height;
  const bounds = (v: Record<string, unknown>): boolean => finite(v.x) && finite(v.y) && finite(v.w) && finite(v.h) &&
    v.w > 0 && v.h > 0 && v.x + v.w <= width && v.y + v.h <= height;
  const sourceNodes = new Map(input.nodes.map(n => [n.id, n]));
  const seenNodes = new Set<string>();
  const clusterMembers = new Map<string, Array<{ x: number; y: number; w: number; h: number }>>();
  for (const n of value.nodes) {
    if (!object(n) || !keys(n, ['id','isDummy','title','kind','kindId','color','background','packageId','x','y','w','h']) ||
      typeof n.id !== 'string' || seenNodes.has(n.id) || n.isDummy !== false || !bounds(n)) return false;
    const source = sourceNodes.get(n.id);
    if (!source || !Object.entries(source).every(([k,v]) => n[k] === v) || n.h !== LAYOUT_METRICS.NODE_H ||
      (n.w as number) < LAYOUT_METRICS.NODE_W_MIN || (n.w as number) > LAYOUT_METRICS.NODE_W_MAX) return false;
    seenNodes.add(n.id);
    const members = clusterMembers.get(source.packageId) ?? [];
    members.push(n as unknown as { x: number; y: number; w: number; h: number }); clusterMembers.set(source.packageId, members);
  }
  const sourceEdges = new Map(input.edges.map(e => [e.id,e]));
  const seenEdges = new Set<string>();
  for (const e of value.edges) {
    if (!object(e) || !keys(e, ['id','from','to','label','isDependency','isAtomic','isBack','waypoints']) ||
      typeof e.id !== 'string' || seenEdges.has(e.id) || typeof e.isBack !== 'boolean' ||
      typeof e.from !== 'string' || typeof e.to !== 'string' || !seenNodes.has(e.from) || !seenNodes.has(e.to) ||
      !Array.isArray(e.waypoints) || e.waypoints.length > input.nodes.length) return false;
    const source = sourceEdges.get(e.id);
    if (!source || !Object.entries(source).every(([k,v]) => e[k] === v)) return false;
    if (!e.waypoints.every(p => object(p) && keys(p, ['x','y']) && finite(p.x) && finite(p.y) && p.x <= width && p.y <= height)) return false;
    seenEdges.add(e.id);
  }
  const seenPackages = new Set<string>();
  for (const c of value.clusters) {
    if (!object(c) || !keys(c, ['packageId','x','y','w','h','nodeCount']) || typeof c.packageId !== 'string' ||
      seenPackages.has(c.packageId) || !bounds(c)) return false;
    const members = clusterMembers.get(c.packageId);
    if (!members || c.nodeCount !== members.length || !members.every(n => n.x >= (c.x as number) && n.y >= (c.y as number) &&
      n.x+n.w <= (c.x as number)+(c.w as number) && n.y+n.h <= (c.y as number)+(c.h as number))) return false;
    seenPackages.add(c.packageId);
  }
  return seenPackages.size === clusterMembers.size && (input.nodes.length > 0 || (width === 0 && height === 0));
}

/** Bounded instance-local memory only. BrowserReader owns one per frozen snapshot.
 * No localStorage/IndexedDB, filesystem or unvalidated persistent host state. */
export class GraphLayoutMemoryCache {
  private readonly values = new Map<string, Layout>();
  get(input: GraphLayoutInput, artifact?: unknown): Layout {
    const key = graphLayoutKey(input);
    let value = this.values.get(key);
    if (!value) {
      value = object(artifact) && artifact.key === key && isGraphLayout(artifact.layout, input)
        ? JSON.parse(JSON.stringify(artifact.layout)) as Layout : generateGraphLayout(input);
      if (!isGraphLayout(value, input)) throw new Error('Invalid generated graph geometry');
      if (this.values.size >= 16) this.values.delete(this.values.keys().next().value!);
      this.values.set(key, value);
    }
    return value;
  }
  clear(): void { this.values.clear(); }
}
