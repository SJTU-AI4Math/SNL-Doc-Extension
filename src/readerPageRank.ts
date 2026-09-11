import type { EntryData, RelationshipData } from './snlDoc';
import { readPageRankCache } from './pageRankCache';
import { projectPageRank, type GlobalPageRankView } from './entryPageRankView';

/** Full saved workspace inputs in; a display/export projection out. Cache/graph
 * failure stays local to the metric, and never becomes a synthetic zero score. */
export async function readReaderPageRank(root: string, entries: readonly EntryData[],
  relationshipRead: { relationships: readonly RelationshipData[]; error: string | null },
  ids: Iterable<string>): Promise<GlobalPageRankView | null> {
  if (relationshipRead.error !== null) return null;
  try {
    const result = await readPageRankCache(root, entries, relationshipRead.relationships);
    return projectPageRank({ scope: 'workspace', scores: result.scores,
      converged: result.converged, iterations: result.iterations }, ids);
  } catch { return null; }
}
