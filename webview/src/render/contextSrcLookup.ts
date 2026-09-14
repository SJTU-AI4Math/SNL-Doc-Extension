// Browser adapter: the renderer and SSI share exactly one context lookup implementation.
import { extractExportedBinders } from '@sjtu-ai4math/snl-basics/core';
import { buildContextIndex as buildIndex, type EntryPoolItemForLookup } from '../../../src/ssiContext';
export { extractExportedBinders };
export { applyContextSrcLookup, type EntryPoolItemForLookup } from '../../../src/ssiContext';
export const buildContextIndex = (pool: EntryPoolItemForLookup[]) => buildIndex(pool, extractExportedBinders);
