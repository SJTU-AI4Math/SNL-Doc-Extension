/** Read-only projection of a full-workspace calculation; never an Entry authoring field. */
export interface GlobalPageRankView {
  scope: 'workspace';
  scores: Record<string, number>;
  converged: boolean;
  iterations: number;
}

/** Export only requested identities while retaining the global calculation's meaning. */
export function projectPageRank(result: GlobalPageRankView, ids: Iterable<string>): GlobalPageRankView {
  return { scope: 'workspace', converged: result.converged, iterations: result.iterations,
    scores: Object.fromEntries([...new Set(ids)].filter(id => Object.hasOwn(result.scores, id)).map(id => [id, result.scores[id]])) };
}
