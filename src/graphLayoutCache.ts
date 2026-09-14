import { getOrGenerateCache, type CacheRoot } from './derivedCache';
import { GRAPH_LAYOUT_VERSION, type Layout } from './graphLayout';
import { generateGraphLayout, graphLayoutKey, isGraphLayout, type GraphLayoutInput, type GraphLayoutArtifact } from './graphLayoutCacheModel';

/** Host-only: input and Library owner are assembled from canonical graph reads.
 * There is intentionally no Webview write/read-cache message or caller-supplied path. */
export async function getLibraryGraphLayout(root: CacheRoot, input: GraphLayoutInput): Promise<GraphLayoutArtifact> {
  if (!input.library) throw new Error('A Library must own persistent layout data');
  const result = await getOrGenerateCache(root, {
    id: 'graph-layout', version: GRAPH_LAYOUT_VERSION, scope: { library: input.library }, input,
    validate: (value: unknown): value is Layout => isGraphLayout(value, input),
    generate: () => generateGraphLayout(input)
  });
  return { key: graphLayoutKey(input), layout: result };
}
