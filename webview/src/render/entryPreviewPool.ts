import type { EntryOption } from './EntrySurface';

export interface DraftEntryContext {
  id: string;
  title: string;
  snl: string;
}

/** Overlay the unsaved draft so preview bvar lookup is truly WYSIWYG. */
export function mergeDraftIntoEntryPool(
  entries: readonly EntryOption[],
  draft: DraftEntryContext
): EntryOption[] {
  const option: EntryOption = {
    id: draft.id,
    title: draft.title,
    hasContent: draft.snl.trim().length > 0,
    snl: draft.snl
  };
  const withoutSavedVersion = entries.filter((entry) => entry.id !== draft.id);
  return [...withoutSavedVersion, option];
}
