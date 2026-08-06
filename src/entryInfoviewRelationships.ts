import type { RelationshipData } from './snlDoc';

export type RelationshipDirection = 'incoming' | 'outgoing';

export interface RelationshipEntrySummary {
  id: string;
  title: string;
  kind?: string;
  package?: string;
}

export interface EntryRelationshipRow {
  id: string;
  title: string;
  kindId?: string;
  package?: string;
  relationshipId: string;
  metadata: unknown;
}

export interface EntryRelationshipSection {
  label: string;
  direction: RelationshipDirection;
  rows: EntryRelationshipRow[];
}

export type EntryReturnRoute =
  | { kind: 'root' }
  | { kind: 'library'; slug: string; title?: string }
  | { kind: 'entry'; entryId: string; entryPackage?: string }
  | { kind: 'chooseLibrary'; libraries: Array<{ slug: string; title: string }> };

/**
 * Materialize all edges touching one Entry. Sections sort by label then
 * incoming/outgoing; rows sort by title, id, then relationship id. Parallel
 * edges remain visible because relationships, rather than counterpart ids,
 * are the unit shown to readers.
 */
export function groupEntryRelationships(
  entryId: string,
  relationships: RelationshipData[],
  entriesById: ReadonlyMap<string, RelationshipEntrySummary>
): EntryRelationshipSection[] {
  const grouped = new Map<string, EntryRelationshipSection>();
  for (const relationship of relationships) {
    const direction: RelationshipDirection | null =
      relationship.from === entryId
        ? 'outgoing'
        : relationship.to === entryId
          ? 'incoming'
          : null;
    if (!direction) continue;
    const counterpartId = direction === 'outgoing' ? relationship.to : relationship.from;
    const counterpart = entriesById.get(counterpartId);
    if (!counterpart) continue;
    const key = `${relationship.label}\u0000${direction}`;
    let section = grouped.get(key);
    if (!section) {
      section = { label: relationship.label, direction, rows: [] };
      grouped.set(key, section);
    }
    section.rows.push({
      id: counterpart.id,
      title: counterpart.title ?? '',
      kindId: counterpart.kind,
      package: counterpart.package,
      relationshipId: relationship.id,
      metadata: relationship.metadata
    });
  }
  const sections = [...grouped.values()];
  for (const section of sections) {
    section.rows.sort((a, b) =>
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id) ||
      a.relationshipId.localeCompare(b.relationshipId));
  }
  sections.sort((a, b) =>
    a.label.localeCompare(b.label) || a.direction.localeCompare(b.direction));
  return sections;
}

export function parseEntryReturnRoute(value: unknown): EntryReturnRoute | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const route = value as Record<string, unknown>;
  if (route.kind === 'root') return { kind: 'root' };
  if (route.kind === 'library') {
    const slug = typeof route.slug === 'string' ? route.slug.trim() : '';
    if (!slug) return undefined;
    const title = typeof route.title === 'string' ? route.title : undefined;
    return { kind: 'library', slug, ...(title === undefined ? {} : { title }) };
  }
  if (route.kind === 'entry') {
    const entryId = typeof route.entryId === 'string' ? route.entryId.trim() : '';
    if (!entryId) return undefined;
    const entryPackage = typeof route.entryPackage === 'string' && route.entryPackage
      ? route.entryPackage
      : undefined;
    return { kind: 'entry', entryId, ...(entryPackage ? { entryPackage } : {}) };
  }
  if (route.kind === 'chooseLibrary' && Array.isArray(route.libraries)) {
    const libraries = route.libraries.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return [];
      const item = candidate as Record<string, unknown>;
      const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
      const title = typeof item.title === 'string' ? item.title : '';
      return slug ? [{ slug, title }] : [];
    });
    return libraries.length > 0 ? { kind: 'chooseLibrary', libraries } : undefined;
  }
  return undefined;
}

export function chooseEntryReturn(
  libraries: Array<{ slug: string; title: string }>
): EntryReturnRoute {
  const sorted = [...libraries].sort((a, b) => a.slug.localeCompare(b.slug));
  if (sorted.length === 0) return { kind: 'root' };
  if (sorted.length === 1) return { kind: 'library', ...sorted[0] };
  return { kind: 'chooseLibrary', libraries: sorted };
}
