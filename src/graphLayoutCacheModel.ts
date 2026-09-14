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
    parameters: { nodeGapX: parameters.nodeGapX, layerGapY: parameters.layerGapY,
      mode: parameters.mode ?? 'rectangle', packing: !parameters.mode || parameters.mode === 'rectangle' ? 'bands' : parameters.packing ?? 'bands' }, metrics: LAYOUT_METRICS,
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

/** Only the generated M/A/L/A/Z sector grammar, not arbitrary SVG path text. */
function sectorPathNumbers(value: unknown): number[][] | undefined {
  if (typeof value !== 'string') return undefined;
  const groups = value.match(/^M (.+) A (.+) L (.+) A (.+) Z$/);
  if (!groups) return undefined;
  const valid = groups.slice(1).every((group, index) => {
    const tokens = group.trim().split(/\s+/);
    const arc = index === 1 || index === 3;
    if (tokens.length !== (arc ? 7 : 2) || !tokens.every(token =>
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token) &&
      Number.isFinite(Number(token)) && Math.abs(Number(token)) <= 1e9)) return false;
    return !arc || (Number(tokens[0]) >= 0 && Number(tokens[1]) >= 0 &&
      /^[01]$/.test(tokens[3]) && /^[01]$/.test(tokens[4]));
  });
  return valid ? groups.slice(1).map(group => group.trim().split(/\s+/).map(Number)) : undefined;
}

// Absolute sub-pixel slack plus bounded floating-point roundoff at large
// coordinates; never a percentage tolerance that could admit distant labels.
const sameCoordinate = (actual: number, expected: number): boolean =>
  Math.abs(actual - expected) <= 1e-7 + 32 * Number.EPSILON * Math.max(Math.abs(actual), Math.abs(expected));

/** Check redundant render fields, not the expensive layout algorithm. The inner
 * radius is encoded only in the path; all its endpoints must use that same radius
 * about the declared radial centre. Outer radius and angles come from the sector. */
function consistentSector(sector: Record<string, unknown>, radial: Record<string, unknown>): boolean {
  const groups = sectorPathNumbers(sector.path);
  if (!groups) return false;
  const start = sector.startAngle as number, end = sector.endAngle as number;
  const outer = sector.outerRadius as number, inner = groups[3][0];
  if (inner > outer) return false;
  const polar = (angle: number, radius: number): number[] => [
    (radial.centerX as number) + Math.cos(angle) * radius,
    (radial.centerY as number) + Math.sin(angle) * radius
  ];
  const labelAngle = (start + end) / 2, label = polar(labelAngle, outer);
  if (!sameCoordinate(sector.labelAngle as number, labelAngle) ||
      !sameCoordinate(sector.labelX as number, label[0]) ||
      !sameCoordinate(sector.labelY as number, label[1])) return false;
  const large = end - start > Math.PI ? 1 : 0;
  const expected = [polar(start, outer), [outer, outer, 0, large, 1, ...polar(end, outer)],
    polar(end, inner), [inner, inner, 0, large, 0, ...polar(start, inner)]];
  return groups.every((group, i) => group.every((number, j) =>
    // Rotation and arc flags are discrete generator fields, not coordinates.
    (i === 1 || i === 3) && j >= 2 && j <= 4
      ? number === expected[i][j] : sameCoordinate(number, expected[i][j])));
}

/** Cache bytes can never inject titles, styles, identities, dangling routes, nonfinite
 * SVG coordinates, or viewport/selection state. Validate against the CURRENT input. */
export function isGraphLayout(value: unknown, input: GraphLayoutInput): value is Layout {
  if (!object(value) || !keys(value, ['nodes','edges','clusters','width','height', ...(value.radial === undefined ? [] : ['radial'])]) ||
      !finite(value.width) || !finite(value.height) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.clusters) ||
      value.nodes.length !== input.nodes.length || value.edges.length !== input.edges.length) return false;
  const width = value.width, height = value.height;
  const radial = value.radial;
  const expectsRadial = input.nodes.length > 0 && input.parameters.mode !== 'rectangle';
  if (expectsRadial !== (radial !== undefined)) return false;
  if (radial !== undefined) {
    if (!object(radial) || !keys(radial, ['centerX','centerY','innerRadius','packing','radiusSamples','layerRadii','maxLayer','xMin','xSpan','yMin','startAngle','sweep']) ||
        !['centerX','centerY','innerRadius','xMin','xSpan','yMin','maxLayer','sweep'].every(k => finite(radial[k])) ||
        (radial.xSpan as number) <= 0 || (radial.sweep as number) <= 0 || (radial.sweep as number) > Math.PI * 2 ||
        typeof radial.startAngle !== 'number' || !Number.isFinite(radial.startAngle) || Math.abs(radial.startAngle) > Math.PI * 2 ||
        radial.packing !== input.parameters.packing || radial.centerX !== width/2 || radial.centerY !== height/2 ||
        !Number.isInteger(radial.maxLayer) || radial.maxLayer as number >= input.nodes.length ||
        !Array.isArray(radial.layerRadii) || !Array.isArray(radial.radiusSamples) ||
        radial.layerRadii.length !== (radial.maxLayer as number)+1 || radial.radiusSamples.length !== radial.layerRadii.length ||
        !radial.layerRadii.every(finite) || !radial.radiusSamples.every(row => Array.isArray(row) && row.every(p => object(p) && keys(p,['x','radius']) && finite(p.x) && finite(p.radius))) ||
        radial.radiusSamples.reduce((sum,row) => sum + (row as unknown[]).length,0) !== input.nodes.length) return false;
  }
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
    if (!object(c) || !keys(c, ['packageId','x','y','w','h','nodeCount', ...(expectsRadial ? ['sector'] : [])]) || typeof c.packageId !== 'string' ||
      seenPackages.has(c.packageId) || (expectsRadial ? !['x','y','w','h'].every(k => finite(c[k])) : !bounds(c))) return false;
    const members = clusterMembers.get(c.packageId);
    if (!members || c.nodeCount !== members.length || (!expectsRadial && !members.every(n => n.x >= (c.x as number) && n.y >= (c.y as number) &&
      n.x+n.w <= (c.x as number)+(c.w as number) && n.y+n.h <= (c.y as number)+(c.h as number)))) return false;
    if (expectsRadial) {
      const sector = c.sector;
      if (!object(sector) || !keys(sector,['path','startAngle','endAngle','outerRadius','labelAngle','labelX','labelY']) ||
          !finite(sector.outerRadius) || sector.outerRadius <= 0 ||
          !['outerRadius','labelX','labelY'].every(k => typeof sector[k] === 'number' && Number.isFinite(sector[k]) && Math.abs(sector[k] as number) <= 1e9) ||
          !['startAngle','endAngle','labelAngle'].every(k => typeof sector[k] === 'number' && Number.isFinite(sector[k]) && Math.abs(sector[k] as number) <= Math.PI*4) ||
          !consistentSector(sector, radial as Record<string, unknown>)) return false;
    }
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
