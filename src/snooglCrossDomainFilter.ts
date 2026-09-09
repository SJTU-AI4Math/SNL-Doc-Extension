import type { EntryData } from './snlDoc';
import { extractSnlReferences } from './snlReferences';

export function entryMatchesMacroFilter(entry: EntryData, macroId: string): boolean {
  if (!macroId) return true;
  return extractSnlReferences(entry.content?.snl ?? '').macros.includes(macroId);
}

export function macroMatchesEntryFilter(
  macro: { source?: { entries?: readonly string[] } },
  entryId: string
): boolean {
  if (!entryId) return true;
  return Array.isArray(macro.source?.entries) && macro.source.entries.includes(entryId);
}
