/** Canonical Entry tag identity is the exact authored string, including empty strings. */
export function hasValidEntryTags(entry: object & { tags?: unknown }): boolean {
  return !Object.hasOwn(entry, 'tags') ||
    (Array.isArray(entry.tags) && Array.from(entry.tags).every(tag => typeof tag === 'string'));
}
