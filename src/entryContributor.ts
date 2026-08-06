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
