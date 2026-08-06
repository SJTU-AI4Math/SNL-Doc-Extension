/**
 * Normalize the temporary Entry Contributor field.
 *
 * This is intentionally only one string for now. It is not an author object,
 * list, or stable long-term schema; callers must not build structured data on
 * top of it. Missing/null values keep older Entries readable.
 */
export function normalizeEntryContributor(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error('Contributor must be a single string (temporary schema).');
  }
  const contributor = value.trim();
  return contributor || null;
}

/**
 * Update-only compatibility rule for workspaces written before the temporary
 * scalar Contributor contract. A non-scalar incoming value is never accepted
 * as a replacement: when the stored value is also legacy, the stored value is
 * retained unchanged; otherwise validation fails.
 */
export function normalizeUpdatedEntryContributor(
  incoming: unknown,
  stored: unknown
): unknown {
  if (incoming === undefined || incoming === null || typeof incoming === 'string') {
    return normalizeEntryContributor(incoming);
  }
  if (stored !== undefined && stored !== null && typeof stored !== 'string') {
    return stored;
  }
  throw new Error('Contributor must be a single string (temporary schema).');
}
