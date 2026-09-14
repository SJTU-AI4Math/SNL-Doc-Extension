import { parseSnlSyntaxTree } from './snlBasicsHostCompat';
import type { EntryData, MacroPackageEntry } from './snlDoc';
import type { EntryEntityRecord, MacroEntityRecord } from './entityStorageIo';
import type { EntryPointResult, MacroPointResult } from './libraryPointRead';
import type { PointReadReceipt } from './libraryPointReadStorage';

export interface LibraryRenderPointReader {
  readEntry(id: string): Promise<EntryPointResult>;
  readMacro(name: string): Promise<MacroPointResult>;
  assertCurrent(): void;
  readonly identity: { readonly receipts: readonly PointReadReceipt[] };
  readonly receipts: readonly PointReadReceipt[];
}
export interface LibraryRenderClosure {
  readonly kind: 'render-context';
  entries: Map<string, EntryEntityRecord>;
  macros: Map<string, MacroEntityRecord>;
  requestedEntryIds: Set<string>;
  missingEntryIds: Set<string>;
  requestedMacroNames: Set<string>;
  missingMacroNames: Set<string>;
  entryResults: Map<string, EntryPointResult>;
  macroResults: Map<string, MacroPointResult>;
  receipts: readonly PointReadReceipt[];
}
/** Current parser, not the legacy mdata.src or prefix scanner. Binder/env and
 * literal nodes retain the same lookup boundary as sharedReaderSnapshot. */
export function collectLibraryRenderDependencies(snl: string): { entryIds: Set<string>; macroNames: Set<string> } {
  return collectLibraryRenderTreeDependencies(snl ? parseSnlSyntaxTree(snl) : null);
}
/** Also accepts an actual resolved current AST; no parser or semantic resolver
 * substitution is needed to test the canonical source branch. */
export function collectLibraryRenderTreeDependencies(tree: ReturnType<typeof parseSnlSyntaxTree> | null): { entryIds: Set<string>; macroNames: Set<string> } {
  const entryIds = new Set<string>();
  const macroNames = new Set<string>();
  const nodes = tree ? [tree] : [];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (node.source?.type === 'entry') entryIds.add(node.source.entry_id);
    if (node.postfix?.type === 'name') entryIds.add(node.postfix.name);
    if (!node.env_mode && node.macro_name) macroNames.add(node.macro_name);
    nodes.push(...node.children);
  }
  return { entryIds, macroNames };
}
/** Disk fixed point for body render contexts ONLY. No relationships, global
 * metrics, frozen-capture authority, or fallback pools enter this API. */
export async function readLibraryRenderClosure(seeds: readonly string[], reader: LibraryRenderPointReader): Promise<LibraryRenderClosure> {
  const result: LibraryRenderClosure = { kind: 'render-context', entries: new Map(), macros: new Map(),
    requestedEntryIds: new Set(), missingEntryIds: new Set(), requestedMacroNames: new Set(), missingMacroNames: new Set(),
    entryResults: new Map(), macroResults: new Map(), receipts: [] };
  const queue: Array<{ kind: 'entry' | 'macro'; id: string }> = [];
  const addEntry = (id: string): void => {
    if (!result.requestedEntryIds.has(id)) { result.requestedEntryIds.add(id); queue.push({ kind: 'entry', id }); }
  };
  const addMacro = (id: string): void => {
    if (!result.requestedMacroNames.has(id)) { result.requestedMacroNames.add(id); queue.push({ kind: 'macro', id }); }
  };
  seeds.forEach(addEntry);
  for (let i = 0; i < queue.length; i++) {
    reader.assertCurrent();
    const { kind, id } = queue[i];
    if (kind === 'entry') {
      const found = await reader.readEntry(id);
      reader.assertCurrent();
      result.entryResults.set(id, found);
      if (!found.record) { result.missingEntryIds.add(id); continue; }
      result.entries.set(id, found.record);
      const entry = found.record.entry as unknown as EntryData;
      const dependencies = collectLibraryRenderDependencies(entry.content.snl ?? '');
      dependencies.entryIds.forEach(addEntry);
      dependencies.macroNames.forEach(addMacro);
    } else {
      const found = await reader.readMacro(id);
      reader.assertCurrent();
      result.macroResults.set(id, found);
      if (!found.record) { result.missingMacroNames.add(id); continue; }
      result.macros.set(id, found.record);
      const macro = found.record.macro as unknown as MacroPackageEntry;
      // Valid current Macro sources are string arrays, not canonical Entry IDs.
      // The frozen closure does exact Map.get(rawId): never trim into an owner,
      // or dispatch an unlocatable source through the strict external point API.
      for (const sourceId of macro.source.entries) {
        if (!sourceId || sourceId !== sourceId.trim() || sourceId.includes('\0')) {
          result.requestedEntryIds.add(sourceId);
          result.missingEntryIds.add(sourceId);
          result.entryResults.set(sourceId, { id: sourceId, packageId: null, path: null, record: null, missing: 'unindexed' });
        } else {
          addEntry(sourceId);
        }
      }
    }
  }
  reader.assertCurrent();
  result.receipts = [...reader.identity.receipts, ...reader.receipts];
  return result;
}
