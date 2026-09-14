/** Browser-safe deterministic global graph analysis; no Authoring mutation. */
export const PAGE_RANK_VERSION = '1';
export interface PageRankParameters { damping: number; tolerance: number; maxIterations: number }
export interface PageRankResult {
  scores: Record<string, number>;
  converged: boolean;
  iterations: number;
  algorithmVersion: string;
  parameters: PageRankParameters;
  /** Populated by the global cache host; not an Entry field. */
  graphInputHash?: string;
}
export interface PageRankGraph { nodes: string[]; edges: Array<[string, string]> }
export const DEFAULT_PAGE_RANK_PARAMETERS: Readonly<PageRankParameters> = Object.freeze({ damping: 0.85, tolerance: 1e-10, maxIterations: 500 });
export type PageRankEntry = { id: string };
export type PageRankRelationship = { from: string; to: string; label: string };

/** Topology only: title, metadata, layout, Library membership and UI filters
 * have no role. Duplicate manual/automatic edges have weight one. */
export function pageRankGraph(entries: readonly PageRankEntry[], relationships: readonly PageRankRelationship[]): PageRankGraph {
  const nodes = [...new Set(entries.map(e => e.id))].sort();
  const pool = new Set(nodes);
  const pairs = new Map<string, [string, string]>();
  for (const r of relationships) {
    if (r.label !== 'depends' || r.from === r.to || !pool.has(r.from) || !pool.has(r.to)) continue;
    pairs.set(JSON.stringify([r.from, r.to]), [r.from, r.to]);
  }
  const edges = [...pairs.values()].sort(([a, b], [c, d]) => a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0);
  return { nodes, edges };
}
export function pageRankParameters(options: Partial<PageRankParameters> = {}): PageRankParameters {
  const p = { ...DEFAULT_PAGE_RANK_PARAMETERS, ...options };
  if (!Number.isFinite(p.damping) || p.damping < 0 || p.damping >= 1) throw new Error('PageRank damping must be finite in [0, 1).');
  if (!Number.isFinite(p.tolerance) || p.tolerance <= 0) throw new Error('PageRank tolerance must be positive and finite.');
  if (!Number.isSafeInteger(p.maxIterations) || p.maxIterations < 1) throw new Error('PageRank maxIterations must be a positive safe integer.');
  return p;
}
export function computePageRank(
  entries: readonly PageRankEntry[],
  relationships: readonly PageRankRelationship[],
  options: Partial<PageRankParameters> = {}
): PageRankResult {
  const parameters = pageRankParameters(options);
  const { damping, tolerance, maxIterations } = parameters;
  const { nodes, edges } = pageRankGraph(entries, relationships);
  const scores: Record<string, number> = Object.create(null);
  const result: PageRankResult = { scores, converged: true, iterations: 0, algorithmVersion: PAGE_RANK_VERSION, parameters };
  const n = nodes.length;
  if (!n) return result;
  const index = new Map(nodes.map((id, i) => [id, i]));
  const outgoing: number[][] = nodes.map(() => []);
  for (const [from, to] of edges) outgoing[index.get(from)!].push(index.get(to)!);
  let rank: number[] = nodes.map(() => 1 / n);
  result.converged = false;
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let dangling = 0;
    for (let i = 0; i < n; i++) if (!outgoing[i].length) dangling += rank[i];
    const next = nodes.map(() => (1 - damping) / n + damping * dangling / n);
    for (let i = 0; i < n; i++) {
      if (!outgoing[i].length) continue;
      const share = damping * rank[i] / outgoing[i].length;
      for (const to of outgoing[i]) next[to] += share;
    }
    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i] - rank[i]);
    rank = next; result.iterations = iteration;
    if (delta <= tolerance) { result.converged = true; break; }
  }
  nodes.forEach((id, i) => { scores[id] = rank[i]; });
  return result;
}
