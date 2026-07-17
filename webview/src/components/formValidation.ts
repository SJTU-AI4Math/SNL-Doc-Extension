import type { EntryOption } from '../render/EntryRender';

export function isEntityIdUnique(
  value: string,
  entries: readonly EntryOption[],
  currentId?: string
): boolean {
  const id = value.trim();
  if (!id) return false;
  return !entries.some((entry) => entry.id === id && entry.id !== currentId);
}

export function areEntityReferencesResolved(
  values: readonly string[],
  entries: readonly EntryOption[]
): boolean {
  const ids = new Set(entries.map((entry) => entry.id));
  return values.every((value) => {
    const id = value.trim();
    return id.length === 0 || ids.has(id);
  });
}
