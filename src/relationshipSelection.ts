/** Relationship IDs are unique within a source, not across saved/current pools. */
export type RelationshipSource = 'saved' | 'current';

/** Omitted source preserves legacy Graph/command callers; invalid values fail closed. */
export function parseRelationshipSource(value: unknown): RelationshipSource | undefined {
  if (value === undefined) return 'current';
  return value === 'saved' || value === 'current' ? value : undefined;
}
