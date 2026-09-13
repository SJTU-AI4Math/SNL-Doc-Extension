import { relationshipGraphEdge } from '../../../src/relationshipGraphWire';
import type { GraphMessage } from '../SnlGraphApp';
import type { FrozenReaderSnapshot } from '../../../src/sharedReaderSnapshot';
import { createSnooglSearchDocument, rankSnooglDocuments } from '../../../src/snooglSearch';
import { entryMatchesMacroFilter, macroMatchesEntryFilter } from '../../../src/snooglCrossDomainFilter';

export function frozenRelationshipGraph(snapshot: FrozenReaderSnapshot): GraphMessage {
  const byId = new Map(snapshot.entries.map(entry => [entry.id, entry]));
  const kinds = new Map(snapshot.entryKinds.map(kind => [kind.id, kind]));
  const edges = snapshot.relationships.filter(edge => byId.has(edge.from) && byId.has(edge.to)).map(relationshipGraphEdge);
  const participating = new Set(edges.flatMap(edge => [edge.from, edge.to]));
  return {
    type: 'graph', scope: { mode: 'pool' }, title: snapshot.library.title, warnings: [], edges,
    nodes: snapshot.entries.filter(entry => participating.has(entry.id)).map(entry => ({
      id: entry.id, packageId: entry.package?.trim() || '_unpackaged', title: entry.title || entry.id,
      kind: kinds.get(entry.kind)?.name ?? entry.kind, kindId: entry.kind, coloring: kinds.get(entry.kind)?.coloring ?? null
    })),
    entryOptions: snapshot.entries.map(entry => ({ id: entry.id, package: entry.package, title: entry.title, hasContent: !!entry.content.snl, snl: entry.content.snl })),
    entryPackages: snapshot.entryPackages, macros: snapshot.macros, macroKinds: snapshot.macroKinds
  };
}

export interface FrozenSearchQuery {
  q: string;
  mode: 'entry' | 'macro';
  filters: { kindId?: string; counterpartId?: string };
}

/** Only projects the already-authorized snapshot; never fetches or expands its closure. */
export function frozenSearchResults(snapshot: FrozenReaderSnapshot, query: FrozenSearchQuery) {
  const unique = (values: string[]) => [...new Set(values)].sort();
  const macros = Object.entries(snapshot.macros);
  const { q, mode, filters } = query;
  const documents = mode === 'entry'
    ? snapshot.entries
      .filter(entry => (!filters.kindId || entry.kind === filters.kindId) && entryMatchesMacroFilter(entry, filters.counterpartId ?? ''))
      .map(entry => createSnooglSearchDocument({ id: entry.id,
        value: { kind: 'entry' as const, id: entry.id, title: entry.title, entryKind: entry.kind, score: 0 },
        labels: typeof entry.title === 'string' ? [entry.title] : Object.values(entry.title.values).filter((value): value is string => typeof value === 'string') }))
    : macros
      .filter(([, macro]) => (!filters.kindId || macro.kind === filters.kindId) && macroMatchesEntryFilter(macro, filters.counterpartId ?? ''))
      .map(([id, macro]) => createSnooglSearchDocument({ id,
        value: { kind: 'macro' as const, id, packageFile: '', packageName: '', macroKind: macro.kind ?? null, tags: macro.tags, score: 0 },
        labels: macro.tags }));
  // Both domains use the Extension's same namespace/token ranker and pure cross-domain filters.
  const results = rankSnooglDocuments<(typeof documents)[number]['value']>(q, documents).map(result => ({ ...result.value, score: result.score }));
  return { type: 'results', query, results,
    kindsByMode: { entry: unique(snapshot.entries.map(entry => entry.kind)), macro: unique(macros.map(([, macro]) => macro.kind ?? '').filter(Boolean)) },
    counterpartIdsByMode: { entry: macros.map(([name]) => name).sort(), macro: snapshot.entries.map(entry => entry.id).sort() }
  };
}
