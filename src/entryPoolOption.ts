export interface EntryPoolSource {
  id: string;
  title?: string;
  content?: { snl?: string } | null;
}

export interface EntryPoolOption {
  id: string;
  title: string;
  hasContent: boolean;
  snl?: string;
}

/** Build the shared entry-pool payload consumed by every EntryRender surface. */
export function toEntryOption(entry: EntryPoolSource): EntryPoolOption {
  const snl = entry.content?.snl;
  return {
    id: entry.id,
    title: entry.title ?? '',
    hasContent: typeof snl === 'string' && snl.trim().length > 0,
    snl
  };
}
