import * as vscode from 'vscode';
import { type DashboardCatalog, type EntryData, parseRelationships, snlRootUri } from './snlDoc';
import { readEntryEntityRecords, readMacroEntityRecords, type EntityReadStorage } from './entityStorageIo';

// Do not use the migration adapter's best-effort exists probe here: permission /
// provider failures must remain errors, never successful zero-count snapshots.
function statisticsStorage(root: vscode.Uri) {
  const uri = (path: string) => vscode.Uri.joinPath(snlRootUri(root), ...path.split('/'));
  const missing = (error: unknown) => ['ENOENT', 'FileNotFound'].includes((error as { code?: string } | null)?.code ?? '');
  return {
    async listJsonFiles(path: string): Promise<string[]> {
      let files: [string, vscode.FileType][];
      try { files = await vscode.workspace.fs.readDirectory(uri(path)); }
      catch (error) { if (missing(error)) return []; throw error; }
      return files.filter(([name, type]) => {
        if (!name.toLowerCase().endsWith('.json')) return false;
        if (type !== vscode.FileType.File) throw new Error(`${path}/${name} is not a regular JSON file.`);
        return true;
      }).map(([name]) => name).sort((a, b) => a.localeCompare(b));
    },
    async readJson(path: string): Promise<unknown | null> {
      let bytes: Uint8Array;
      try { bytes = await vscode.workspace.fs.readFile(uri(path)); }
      catch (error) { if (missing(error)) return null; throw error; }
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (value === null) throw new Error(`${path} contains null rather than an object.`);
      return value;
    }
  };
}

async function statisticsRelationships(storage: ReturnType<typeof statisticsStorage>) {
  const raw = await storage.readJson('relationships.json');
  return raw === null ? [] : parseRelationships(raw);
}

export interface DashboardStatistics {
  totalEntryCount: number;
  entryPackages: Array<{ id: string; entryCount: number }>;
  macroPackages: Array<{ file: string; macroCount: number }>;
  relationshipCount: number;
  libraries: Array<{ slug: string; entryCount: number | null; relationshipCount: number | null; error?: string }>;
}

const yieldToHost = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function check(signal: AbortSignal): void { signal.throwIfAborted(); }

/** Retain at most 32 decoded records; the canonical reader uses at most eight
 * concurrent file reads. Yield between batches even for an immediately-resolved
 * filesystem. Cancellation is checked before every subsequent file read.
 * This is a read-only statistic, not a full topology/migration inspection.
 */
async function scan(
  storage: EntityReadStorage, directory: 'entries' | 'macros', signal: AbortSignal,
  accept: (id: string, owner: string, entry?: EntryData) => void
): Promise<void> {
  check(signal);
  const files = await storage.listJsonFiles(directory);
  for (let offset = 0; offset < files.length; offset += 32) {
    await yieldToHost();
    check(signal);
    const batch: EntityReadStorage = {
      listJsonFiles: async () => files.slice(offset, offset + 32),
      readJson: async path => { check(signal); return storage.readJson(path); }
    };
    if (directory === 'entries') {
      for (const { entry, envelope } of await readEntryEntityRecords(batch)) {
        check(signal);
        accept(entry.id, envelope.package, entry as unknown as EntryData);
      }
    } else {
      for (const { macro, envelope } of await readMacroEntityRecords(batch)) {
        check(signal);
        accept(macro.name, envelope.package);
      }
    }
  }
}

export async function readDashboardStatistics(
  root: vscode.Uri, catalog: DashboardCatalog, signal: AbortSignal
): Promise<DashboardStatistics> {
  const storage = statisticsStorage(root);
  const entries = new Map(catalog.entryPackages.map(pkg => [pkg.id, 0]));
  const macros = new Map(catalog.macroPackages.map(pkg => [pkg.file.replace(/\.json$/i, ''), 0]));
  const ids = new Set<string>();
  await scan(storage, 'entries', signal, (id, owner) => {
    if (ids.has(id)) throw new Error(`Duplicate Entry identity ${id}.`);
    if (!entries.has(owner)) throw new Error(`Entry ${id} references missing Package ${owner}.`);
    ids.add(id);
    entries.set(owner, entries.get(owner)! + 1);
  });
  const macroIds = new Set<string>();
  await scan(storage, 'macros', signal, (id, owner) => {
    const key = JSON.stringify([owner, id]);
    if (macroIds.has(key)) throw new Error(`Duplicate Macro identity ${id}.`);
    if (!entries.has(owner)) throw new Error(`Macro ${id} references missing Package ${owner}.`);
    macroIds.add(key);
    macros.set(owner, (macros.get(owner) ?? 0) + 1);
  });
  check(signal);
  const relationshipCount = (await statisticsRelationships(storage)).length;
  const libraries: DashboardStatistics['libraries'] = [];
  for (const { slug } of catalog.libraries) {
    await yieldToHost();
    check(signal);
    try {
      const raw = await storage.readJson(`libraries/${slug}/graph.json`) as { nodes?: unknown[]; relationships?: unknown[] } | null;
      if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.relationships)) {
        throw new Error('Missing or invalid Library graph.');
      }
      const nodeIds = new Set<string>();
      for (let i = 0; i < raw.nodes.length; i++) {
        if (i % 256 === 0) { await yieldToHost(); check(signal); }
        const node = raw.nodes[i] as { label?: string; id?: string } | null;
        if (node?.label === 'Entry' && typeof node.id === 'string') nodeIds.add(node.id);
      }
      libraries.push({ slug, entryCount: nodeIds.size, relationshipCount: raw.relationships.length });
    } catch (error) {
      check(signal);
      libraries.push({ slug, entryCount: null, relationshipCount: null,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
  check(signal);
  return {
    totalEntryCount: ids.size,
    entryPackages: [...entries].map(([id, entryCount]) => ({ id, entryCount })),
    macroPackages: catalog.macroPackages.map(({ file }) => ({ file, macroCount: macros.get(file.replace(/\.json$/i, '')) ?? 0 })),
    relationshipCount, libraries
  };
}

/** Relationship management is opt-in. Only endpoint identity/title projections
 * cross IPC; Entry bodies and the all-Macro index never do. */
export async function readDashboardRelationships(root: vscode.Uri, signal: AbortSignal) {
  check(signal);
  const storage = statisticsStorage(root);
  const relationships = await statisticsRelationships(storage);
  const wanted = new Set(relationships.flatMap(r => [r.from, r.to]));
  const entries: Array<Pick<EntryData, 'id' | 'title'>> = [];
  if (wanted.size) {
    await scan(storage, 'entries', signal, (id, _owner, entry) => {
      if (wanted.has(id) && entry) entries.push({ id, title: entry.title });
    });
  }
  check(signal);
  return { relationships, entries };
}
