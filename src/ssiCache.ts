import { pathToFileURL } from 'node:url';
import { getOrGenerateCache, type CacheRoot } from './derivedCache';
import { isEntryMetricResult, type CachedEntryMetrics } from './cachedEntryMetrics';
import { createSsiEngine, type EntryMetricResult, type SnlMacroSourceLookup, type SsiParser } from './ssiMetrics';
import type { EntryPoolItemForLookup } from './ssiContext';

// TypeScript's CJS emit rewrites import() to require(); retain native ESM loading
// of the public Basics package (the browser adapter uses the same exports).
// Resolve here, not relative to the workspace being analysed.
const importEsm = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>;
let engine: Promise<ReturnType<typeof createSsiEngine>> | undefined;
function hostEngine(): Promise<ReturnType<typeof createSsiEngine>> {
  if (!engine) {
    engine = importEsm(pathToFileURL(require.resolve('@sjtu-ai4math/snl-basics/core')).href)
      // Basics 0.3.5 core runtime exports the identical resolver as root,
      // although core.d.ts omits it. The host parity test pins that contract.
      .then(core => createSsiEngine(core as SsiParser));
    void engine.catch(() => { engine = undefined; });
  }
  return engine;
}

/** Complete saved-workspace SSI product for HTML export, PageRank, and other
 * host consumers. Reuses the same cache as Entry/Library projections below.
 * Call with cacheRootForWorkspace(root), all saved readEntries(root), and readAllMacros(root).
 * No draft/Library/export-subset inputs: these change the semantic universe.
 */
export function getGlobalSSI(
  root: CacheRoot,
  entries: EntryPoolItemForLookup[],
  activeMacroSources: SnlMacroSourceLookup,
  signal?: AbortSignal
): Promise<CachedEntryMetrics> {
  return readCachedEntryMetrics(root, entries, activeMacroSources, entries.map(e => e.id), signal);
}

/** Inputs MUST be the saved readEntries + readAllMacros workspace snapshots,
 * never Library members, Package rows, export closures, or in-memory drafts.
 * One global cache job builds the context once; Entry instances only select rows.
 * No independent workspace scan here: reuse the panel's authoritative reads.
 */
export async function readCachedEntryMetrics(
  root: CacheRoot,
  entries: EntryPoolItemForLookup[],
  activeMacroSources: SnlMacroSourceLookup,
  entryIds: Iterable<string>,
  signal?: AbortSignal
): Promise<CachedEntryMetrics> {
  try {
    // Detach minimal semantic input; title/locale/style changes do not invalidate SSI.
    const input = {
      entries: entries.map(e => ({ id: e.id, content: { snl: e.content?.snl ?? '' } }))
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      macros: Object.fromEntries(Object.entries(activeMacroSources).map(([id, m]) => [id, {
        source: { entries: [...(m.source?.entries ?? [])], urls: [...(m.source?.urls ?? [])] }
      }]))
    };
    const ids = new Set(input.entries.map(e => e.id));
    const values = await getOrGenerateCache<Record<string, EntryMetricResult>>(root, {
      id: 'ssi', version: '1-basics-0.3.5', input, signal,
      validate: (v): v is Record<string, EntryMetricResult> => !!v && typeof v === 'object' && !Array.isArray(v) &&
        Object.keys(v).length === ids.size && Object.entries(v).every(([id, result]) => ids.has(id) && isEntryMetricResult(result)),
      generate: async () => Object.fromEntries((await hostEngine()).computeEntryMetricsForIds(input.entries, ids, input.macros))
    });
    return { scope: 'workspace', status: 'ready', entries: Object.fromEntries(
      [...new Set(entryIds)].filter(id => Object.hasOwn(values, id)).map(id => [id, values[id]])
    ) };
  } catch (error) {
    // Failure is local to this optional derived product, not authored corruption.
    return { scope: 'workspace', status: 'unavailable', error: error instanceof Error ? error.message : String(error) };
  }
}
