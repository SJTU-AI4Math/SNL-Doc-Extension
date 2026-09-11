/** Read-only projection of a full-workspace calculation; never an Entry authoring field. */
export interface GlobalPageRankView {
  scope: 'workspace';
  scores: Record<string, number>;
  converged: boolean;
  iterations: number;
}

export function isGlobalPageRankView(value: unknown): value is GlobalPageRankView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Partial<GlobalPageRankView>;
  return v.scope === 'workspace' && typeof v.converged === 'boolean' && Number.isInteger(v.iterations) &&
    v.iterations! >= 0 && !!v.scores && typeof v.scores === 'object' && !Array.isArray(v.scores) &&
    Object.values(v.scores).every(score => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1);
}

/** Export only requested identities while retaining the global calculation's meaning. */
export function projectPageRank(result: GlobalPageRankView, ids: Iterable<string>): GlobalPageRankView {
  return { scope: 'workspace', converged: result.converged, iterations: result.iterations,
    scores: Object.fromEntries([...new Set(ids)].filter(id => Object.hasOwn(result.scores, id)).map(id => [id, result.scores[id]])) };
}
