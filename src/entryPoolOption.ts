import type { Localized } from './snlBasicsHostCompat';

export interface EntryPoolSource {
  id: string;
  package?: string;
  title?: Localized<string, string>;
  content?: { snl?: string } | null;
}

export interface EntryPoolOption {
  id: string;
  package?: string;
  title: Localized<string, string>;
  hasContent: boolean;
  snl?: string;
}

/** Build the shared entry-pool payload consumed by every EntryRender surface. */
export function toEntryOption(entry: EntryPoolSource): EntryPoolOption {
  const snl = entry.content?.snl;
  return {
    id: entry.id,
    ...(typeof entry.package === 'string' && entry.package ? { package: entry.package } : {}),
    title: entry.title ?? '',
    hasContent: typeof snl === 'string' && snl.trim().length > 0,
    snl
  };
}
