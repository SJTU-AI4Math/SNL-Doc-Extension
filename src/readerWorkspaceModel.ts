import { indexLibraryGraph, numberAllForIndexed, type CounterNode, type LibraryGraph } from './libraryGraph';
import { supportedLanguagesFromConfig } from './workspaceLanguages';
import { renderDependencyId } from './sourceExport/renderSnapshot';
import type { EntryData, EntryKind, LibraryMetaFile, MacroKind, MacroPackageEntry, RelationshipData } from './snlDoc';
import type { FrozenReaderSnapshot } from './sharedReaderSnapshot';
export { readerAssetPaths } from './sharedReaderSnapshot';

export interface WorkspaceReaderInput {
  config: unknown;
  entries: EntryData[];
  entryKinds: EntryKind[];
  macros: Record<string, MacroPackageEntry>;
  macroKinds: MacroKind[];
  relationships: RelationshipData[];
  library: { slug: string; metadata: LibraryMetaFile | null; graph: LibraryGraph; counters: CounterNode[] };
  preferences?: Partial<FrozenReaderSnapshot['preferences']>;
  contentLanguage?: string;
}

/** Workspace navigation is deliberately broader than an HTML export closure.
 * Only materialization is host-specific; graph indexing and numbering use the
 * same pure engine as Infoview. No filesystem access or VS Code runtime here.
 */
export function buildWorkspaceReaderSnapshot(input: WorkspaceReaderInput): FrozenReaderSnapshot {
  const { graph, counters, metadata, slug } = input.library;
  const entries = new Map(input.entries.map(entry => [entry.id, entry]));
  const kinds = new Map(input.entryKinds.map(kind => [kind.id, kind]));
  const index = indexLibraryGraph(graph);
  const labels = numberAllForIndexed(index, entries, kinds, counters);
  const warnings: string[] = [];
  const counterIds = new Set<string>();
  const collectCounters = (nodes: CounterNode[]): void => {
    for (const node of nodes) { counterIds.add(node.id); collectCounters(node.children); }
  };
  collectCounters(counters);
  for (const node of graph.nodes) {
    const counterId = node.props?.counterId;
    if (typeof counterId === 'string' && counterId && !counterIds.has(counterId)) {
      warnings.push(`Entry node “${node.id}” pins missing counter “${counterId}”; falling back to the kind default.`);
    }
  }
  type OutlineNode = FrozenReaderSnapshot['library']['outline'][number];
  const onPath = new Set<string>();
  const reached = new Set<string>();
  const visit = (nodeId: string): OutlineNode | null => {
    if (onPath.has(nodeId)) return null;
    const node = index.nodesById.get(nodeId);
    if (!node) return null;
    onPath.add(nodeId);
    reached.add(nodeId);
    const entryId = node.props?.entryId;
    const entry = typeof entryId === 'string' ? entries.get(entryId) ?? null : null;
    if (entryId && !entry) warnings.push(`Entry “${entryId}” referenced by node “${nodeId}” not found in shared pool.`);
    const children = (index.childrenOf.get(nodeId) ?? []).flatMap(id => {
      const child = visit(id); return child ? [child] : [];
    });
    onPath.delete(nodeId);
    return { nodeId, entry, kind: entry ? kinds.get(entry.kind) ?? null : null, counterLabel: labels.get(nodeId) ?? null, children };
  };
  const outline: OutlineNode[] = [];
  for (const node of graph.nodes) {
    if (!index.parentOf.has(node.id)) { const built = visit(node.id); if (built) outline.push(built); }
  }
  for (const node of graph.nodes) {
    if (!reached.has(node.id)) { const built = visit(node.id); if (built) outline.push(built); }
  }
  const preferences = { language: 'en', color_scheme: 'light', motion: 'full', ...input.preferences };
  // structuredClone isolates every returned nested record from caller-owned raw
  // data; Object.fromEntries preserves canonical own __proto__ identities.
  return structuredClone({
    version: 1, renderSnapshotId: renderDependencyId(input),
    library: { slug, title: metadata?.title || slug, description: metadata?.description, outline, warnings },
    entries: input.entries, entryKinds: input.entryKinds,
    entryPackages: Object.fromEntries(input.entries.filter(entry => entry.package).map(entry => [entry.id, entry.package!])),
    macros: input.macros, macroKinds: input.macroKinds, relationships: input.relationships,
    preferences, contentLanguage: input.contentLanguage ?? preferences.language,
    languages: supportedLanguagesFromConfig(input.config), resources: {},
  });
}
