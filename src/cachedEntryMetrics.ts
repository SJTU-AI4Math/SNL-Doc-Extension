import type { EntryMetricResult } from './ssiMetrics';

/** Saved whole-workspace analysis, projected to only the requested Entry identities. */
export type CachedEntryMetrics =
  | { scope: 'workspace'; status: 'ready'; entries: Record<string, EntryMetricResult> }
  | { scope: 'workspace'; status: 'unavailable'; error?: string };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function isEntryMetricResult(v: unknown): v is EntryMetricResult {
  if (!record(v)) return false;
  if (v.kind === 'unavailable') return v.reason === 'noContent' || (v.reason === 'parseError' && typeof v.error === 'string');
  if (v.kind !== 'ok' || !record(v.metrics)) return false;
  const m = v.metrics;
  if (!['structuralIndex', 'weakSemanticFreedom', 'strongSemanticFreedom', 'weightedTotal', 'weightedWeakSemanticFreedom', 'weightedStrongSemanticFreedom'].every(k => typeof m[k] === 'number' && Number.isFinite(m[k]) && m[k] >= 0)) return false;
  return (m.structuralIndex as number) <= 1 && Number.isInteger(m.weakSemanticFreedom) && Number.isInteger(m.strongSemanticFreedom);
}
export function isCachedEntryMetrics(v: unknown): v is CachedEntryMetrics {
  return record(v) && v.scope === 'workspace' && (
    (v.status === 'unavailable' && (v.error === undefined || typeof v.error === 'string')) ||
    (v.status === 'ready' && record(v.entries) && Object.values(v.entries).every(isEntryMetricResult))
  );
}
