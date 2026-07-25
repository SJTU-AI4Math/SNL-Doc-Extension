/**
 * Entry-panel view of the pool-wide relationship graph (cat 2026-07-25).
 *
 * The Entry editor shows every relationship the edited entry participates
 * in — EXCEPT the "other entries depend on me" direction.
 *
 * Direction semantics (verified against `regenerateDependencyRelationships`
 * in snlDoc.ts, §"Auto-generated dependency relationships"): the generator
 * walks entry E's SNL, finds the macros it uses, and emits
 *
 *     from = E   →   to = src      label = "depends"
 *
 * i.e. **`from` depends on `to`**. So:
 *   - `from === me`  → "I depend on X"          → KEEP (outgoing)
 *   - `to   === me`  → "X depends on me"        → DROP (reverse dependency)
 *
 * Reverse-dependency edges are exactly the ones that explode on foundational
 * entries (every downstream entry points back at them), which is why cat
 * asked for them to be excluded.
 *
 * Only the `depends` label is treated as a dependency; every other label
 * (including author-written edges and the auto `uses_context` edges) is
 * shown in both directions. See {@link REVERSE_EXCLUDED_LABELS}.
 *
 * Kept free of `vscode` imports so it is directly unit-testable and cheap
 * for both the host and the webview to reason about.
 */

/** Minimal shape of a relationship row this selector needs. */
export interface RelationshipLike {
  id: string;
  from: string;
  to: string;
  label: string;
}

/** Minimal shape of an entry this selector needs. */
export interface EntryLike {
  id: string;
  title?: string;
  kind?: string;
}

/**
 * Labels whose INCOMING direction (`to === me`) is hidden by the Entry
 * panel's Relationships section. Single source of truth for "which edges
 * count as «other entries depend on me»".
 */
export const REVERSE_EXCLUDED_LABELS: readonly string[] = ['depends'];

/** One rendered row in the Entry panel's Relationships section. */
export interface EntryRelationshipRow {
  /** Relationship id from relationships.json. */
  id: string;
  /** Edge label, verbatim. */
  label: string;
  /** `outgoing`: me → other. `incoming`: other → me. */
  direction: 'outgoing' | 'incoming';
  /** The entry at the other end (=== the entry itself for a self-loop). */
  otherId: string;
  /** Title of the other entry; `''` when it is not in the pool. */
  otherTitle: string;
  /** Kind id of the other entry, when known. */
  otherKindId?: string;
}

/**
 * Build the Entry panel's Relationships rows for `entryId`.
 *
 * Returns every edge touching `entryId` except incoming edges whose label
 * is in {@link REVERSE_EXCLUDED_LABELS}. Rows are sorted outgoing-first,
 * then by label, then by the other entry's display name, so the order is
 * stable across pushes regardless of relationships.json ordering.
 */
export function selectEntryRelationships(
  entryId: string,
  relationships: readonly RelationshipLike[],
  entries: readonly EntryLike[]
): EntryRelationshipRow[] {
  if (!entryId) return [];
  const byId = new Map<string, EntryLike>();
  for (const e of entries) {
    if (e && typeof e.id === 'string') byId.set(e.id, e);
  }
  const rows: EntryRelationshipRow[] = [];
  for (const r of relationships) {
    if (!r || typeof r.id !== 'string') continue;
    const outgoing = r.from === entryId;
    const incoming = r.to === entryId;
    if (!outgoing && !incoming) continue;
    // A self-loop is reported once, as outgoing — it is never a *reverse*
    // dependency on someone else's behalf.
    const direction: 'outgoing' | 'incoming' = outgoing ? 'outgoing' : 'incoming';
    if (direction === 'incoming' && REVERSE_EXCLUDED_LABELS.includes(r.label)) {
      continue;
    }
    const otherId = outgoing ? r.to : r.from;
    const other = byId.get(otherId);
    rows.push({
      id: r.id,
      label: r.label,
      direction,
      otherId,
      otherTitle: other?.title ?? '',
      ...(other?.kind ? { otherKindId: other.kind } : {})
    });
  }
  rows.sort((a, b) => {
    if (a.direction !== b.direction) return a.direction === 'outgoing' ? -1 : 1;
    if (a.label !== b.label) return a.label.localeCompare(b.label);
    const an = a.otherTitle || a.otherId;
    const bn = b.otherTitle || b.otherId;
    if (an !== bn) return an.localeCompare(bn);
    return a.id.localeCompare(b.id);
  });
  return rows;
}
