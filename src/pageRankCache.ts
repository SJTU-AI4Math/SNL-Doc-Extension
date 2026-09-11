import { cacheFingerprint, getOrGenerateCache } from './derivedCache';
import { computePageRank, pageRankGraph, pageRankParameters, PAGE_RANK_VERSION, type PageRankEntry, type PageRankRelationship, type PageRankResult } from './pageRank';

export async function readPageRankCache(root: string, entries: readonly PageRankEntry[], relationships: readonly PageRankRelationship[]): Promise<PageRankResult> {
  const graph = pageRankGraph(entries, relationships);
  const parameters = pageRankParameters();
  const input = { graph, parameters };
  const graphInputHash = cacheFingerprint(graph);
  return getOrGenerateCache(root, {
    id: 'pagerank', version: PAGE_RANK_VERSION, input,
    validate(value): value is PageRankResult {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const r = value as PageRankResult;
      if (r.algorithmVersion !== PAGE_RANK_VERSION || r.graphInputHash !== graphInputHash ||
          cacheFingerprint(r.parameters) !== cacheFingerprint(parameters) || typeof r.converged !== 'boolean' ||
          !Number.isInteger(r.iterations) || r.iterations < 0 || r.iterations > parameters.maxIterations ||
          !r.scores || typeof r.scores !== 'object' || Array.isArray(r.scores) || Object.keys(r.scores).length !== graph.nodes.length) return false;
      if (!graph.nodes.every(id => Object.hasOwn(r.scores, id) && Number.isFinite(r.scores[id]) && r.scores[id] >= 0)) return false;
      if (!graph.nodes.length) return r.converged && r.iterations === 0;
      return r.iterations > 0 && (r.converged || r.iterations === parameters.maxIterations) &&
        Math.abs(Object.values(r.scores).reduce((a, b) => a + b, 0) - 1) < 1e-8;
    },
    generate: () => ({ ...computePageRank(graph.nodes.map(id => ({ id })), graph.edges.map(([from, to]) => ({ from, to, label: 'depends' })), parameters), graphInputHash })
  });
}
