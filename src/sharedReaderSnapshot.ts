import type { EntryData, EntryKind, MacroKind, MacroPackageEntry, RelationshipData } from './snlDoc';

/** Raw versioned read model, never harvested HTML. Host owns this snapshot. */
export interface FrozenOutlineNode {
  nodeId: string;
  entry: EntryData | null;
  kind: EntryKind | null;
  counterLabel: string | null;
  children: FrozenOutlineNode[];
}
export interface FrozenReaderSnapshot {
  version: 1;
  renderSnapshotId: string;
  library: { slug: string; title: string; description?: string; outline: FrozenOutlineNode[]; warnings: string[] };
  entries: EntryData[];
  entryKinds: EntryKind[];
  entryPackages: Record<string, string>;
  macros: Record<string, MacroPackageEntry>;
  macroKinds: MacroKind[];
  relationships: RelationshipData[];
  preferences: { language: string; color_scheme: string; motion: string; popover_hover_enabled?: boolean; formatter_indent_spaces?: number; formatter_inline_parenthesis_depth?: number };
  contentLanguage: string;
  languages: Array<{ id: string; display_name: string }>;
  /** Asset paths are relative to .SNL_Doc/assets, with frozen bytes and revision. */
  resources: Record<string, { url: string; text?: string; revision: string }>;
}

/** Conservative render dependency closure; unrelated Entry bodies stay private. */
export function readerEntryClosure(outline: FrozenOutlineNode[], entries: EntryData[], macros: Record<string, MacroPackageEntry>): EntryData[] {
  const ids = new Set<string>();
  const visit = (nodes: FrozenOutlineNode[]): void => { for (const node of nodes) { if (node.entry) ids.add(node.entry.id); visit(node.children); } };
  visit(outline);
  let changed = true;
  while (changed) {
    const before = ids.size;
    for (const entry of entries) if (ids.has(entry.id)) {
      const snl = entry.content.snl ?? '';
      for (const candidate of entries) if (snl.includes('@' + candidate.id)) ids.add(candidate.id);
      for (const [name, macro] of Object.entries(macros)) if (snl.includes(name)) {
        for (const id of macro.source.entries) ids.add(id);
      }
    }
    changed = before !== ids.size;
  }
  return entries.filter(entry => ids.has(entry.id));
}

/** Enumerate authored asset references across every localized projection. */
export function readerAssetPaths(value: unknown): string[] {
  const paths = new Set<string>();
  const add = (raw: string): void => {
    let path: string;
    try { path = decodeURIComponent(raw).replace(/^assets\//, '').split(/[?#]/)[0]; } catch { return; }
    if (!path || /[:\\]/.test(path) || path.startsWith('/') || path.split('/').some(s => !s || s === '.' || s === '..')) return;
    paths.add(path);
  };
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)[^)]*\)/g)) add(match[1]);
      for (const match of node.matchAll(/[?&]src=([^&#\s]+)/g)) add(match[1]);
    } else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (typeof record.source === 'string' && record.source.startsWith('assets/')) add(record.source);
      Object.values(record).forEach(walk);
    }
  };
  walk(value);
  return [...paths].sort();
}

export function frozenReaderScript(snapshot: FrozenReaderSnapshot): string {
  return 'window.__SNL_READER__=' + JSON.stringify(snapshot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ';';
}
