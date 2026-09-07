import type { EntryData, EntryKind, MacroKind, MacroPackageEntry, RelationshipData } from './snlDoc';
import { fromMarkdown, parseSnlSyntaxTree } from './snlBasicsHostCompat';
import { parseBlockRendererSpec } from './blockRendererSpec';

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

/** Least fixed point of render contexts, Macro sources and navigable relationships.
 * Pass the whole relationship pool, not edges pre-clipped to the Library outline.
 * Invalid SNL fails capture rather than guessing a broader private-data closure.
 */
export function readerDependencyClosure(
  outline: FrozenOutlineNode[], entries: EntryData[], macros: Record<string, MacroPackageEntry>, relationships: RelationshipData[],
): Pick<FrozenReaderSnapshot, 'entries' | 'macros' | 'relationships'> {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const ids = new Set<string>();
  const names = new Set<string>();
  const queue: EntryData[] = [];
  const add = (id: string): void => {
    const entry = byId.get(id);
    if (entry && !ids.has(id)) { ids.add(id); queue.push(entry); }
  };
  const neighbors = new Map<string, string[]>();
  for (const { from, to } of relationships) {
    if (!neighbors.has(from)) neighbors.set(from, []);
    if (!neighbors.has(to)) neighbors.set(to, []);
    neighbors.get(from)!.push(to);
    neighbors.get(to)!.push(from);
  }
  const visit = (nodes: FrozenOutlineNode[]): void => {
    for (const node of nodes) { if (node.entry) add(node.entry.id); visit(node.children); }
  };
  visit(outline);
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index];
    for (const neighbor of neighbors.get(entry.id) ?? []) add(neighbor);
    if (!entry.content.snl) continue;
    const nodes = [parseSnlSyntaxTree(entry.content.snl)];
    while (nodes.length) {
      const node = nodes.pop()!;
      if (node.postfix?.type === 'name') add(node.postfix.name);
      if (!node.env_mode && Object.hasOwn(macros, node.macro_name) && !names.has(node.macro_name)) {
        names.add(node.macro_name);
        for (const id of macros[node.macro_name].source.entries) add(id);
      }
      nodes.push(...node.children);
    }
  }
  return {
    entries: entries.filter(entry => ids.has(entry.id)),
    macros: Object.fromEntries(Object.entries(macros).filter(([name]) => names.has(name))),
    relationships: relationships.filter(edge => ids.has(edge.from) && ids.has(edge.to)),
  };
}

/** Compatibility for callers that only need render contexts, without relation routes. */
export function readerEntryClosure(outline: FrozenOutlineNode[], entries: EntryData[], macros: Record<string, MacroPackageEntry>): EntryData[] {
  return readerDependencyClosure(outline, entries, macros, []).entries;
}

/** Enumerate authored asset references across every localized projection.
 * Call only on the dependency closure, before authorizing any asset reads.
 */
export function readerAssetPaths(value: unknown): string[] {
  const paths = new Set<string>();
  const add = (raw: string): void => {
    let path: string;
    try { path = decodeURIComponent(raw.split(/[?#]/)[0]).replace(/^assets\//, ''); } catch { return; }
    if (!path || /[:\\\u0000-\u001f\u007f-\u009f]/u.test(path) || path.startsWith('/') ||
        path.split('/').some(s => !s || s === '.' || s === '..')) return;
    // Refuse a second encoded interpretation at downstream URL/filesystem boundaries.
    try { if (decodeURIComponent(path) !== path) return; } catch { return; }
    paths.add(path);
  };
  const markdown = (text: string): void => {
    const tree = fromMarkdown(text);
    type Node = (typeof tree.children)[number] | typeof tree;
    const visit = (node: Node, fn: (node: Node) => void): void => {
      fn(node);
      if ('children' in node) for (const child of node.children) visit(child, fn);
    };
    const definitions = new Map<string, string>();
    visit(tree, node => {
      if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    });
    visit(tree, node => {
      if (node.type === 'image') add(node.url);
      if (node.type === 'imageReference') {
        const url = definitions.get(node.identifier);
        if (url !== undefined) add(url);
      }
    });
  };
  const walk = (node: unknown): void => {
    if (typeof node === 'string') markdown(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      const svg = record.svg_template as { asset?: { source?: unknown } } | undefined;
      if (typeof svg?.asset?.source === 'string') add(svg.asset.source);
      if (typeof record.block_template_name === 'string') {
        try {
          const spec = parseBlockRendererSpec(record.block_template_name);
          if (spec.name === 'image' && spec.params.src) add(spec.params.src);
        } catch { /* Invalid presets are not permission to read a file. */ }
      }
      Object.values(record).forEach(walk);
    }
  };
  walk(value);
  return [...paths].sort();
}

/** Export-only copy: source authority lives in the remapped manifest, never raw pointers. */
export function projectSnapshotForExport(snapshot: FrozenReaderSnapshot): FrozenReaderSnapshot {
  const projected = structuredClone(snapshot);
  for (const entry of projected.entries) entry.pointer = null;
  const visit = (nodes: FrozenOutlineNode[]): void => {
    for (const node of nodes) { if (node.entry) node.entry.pointer = null; visit(node.children); }
  };
  visit(projected.library.outline);
  return projected;
}

export function frozenReaderScript(snapshot: FrozenReaderSnapshot): string {
  // Parsing JSON preserves nested own __proto__ keys instead of object-literal semantics.
  const data = JSON.stringify(JSON.stringify(snapshot)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return 'window.__SNL_READER__=JSON.parse(' + data + ');';
}
