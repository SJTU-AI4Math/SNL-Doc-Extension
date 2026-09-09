import type { RelationshipData } from './snlDoc';

/** Shared Extension/browser graph wire semantics, independent of storage or VS Code. */
export function relationshipGraphEdge(r: RelationshipData) {
  const dependencyLabel = r.label === 'depends' || r.label === 'uses_context';
  const metadata = r.metadata !== null && typeof r.metadata === 'object' ? r.metadata as { generator?: unknown; isAtomic?: unknown } : undefined;
  return {
    id: r.id, from: r.from, to: r.to, label: r.label,
    isDependency: dependencyLabel && metadata?.generator === 'macro-source-scan',
    isAtomic: dependencyLabel && typeof metadata?.isAtomic === 'boolean' ? metadata.isAtomic : null
  };
}
