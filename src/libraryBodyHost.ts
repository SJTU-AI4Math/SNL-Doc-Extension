import * as vscode from 'vscode';
import { EntryIdentityIndex, StaleEntryIdentityIndexError } from './entryIdentityIndex';
import { createLibraryPointReadSession } from './libraryPointRead';
import { readLibraryRenderClosure, type LibraryRenderClosure } from './libraryDependencyClosure';
import { readLibraryGraph, type EntryData, type MacroPackageEntry } from './snlDoc';

/** One panel lifetime. Identity metadata is cached; bodies and misses never are.
 * Dependencies are authoritative only after a successful settled body request. */
export class LibraryBodyHost {
  private index?: EntryIdentityIndex;
  private root?: vscode.Uri;
  private generation = 0;
  private dependencies: Set<string> | undefined;
  private pending = false;

  retire(): void {
    this.generation++;
    this.index?.invalidate();
    this.dependencies = undefined;
  }

  invalidate(uri: vscode.Uri, slug: string): boolean {
    const base = this.root && vscode.Uri.joinPath(this.root, '.SNL_Doc').toString(true);
    const key = uri.toString(true);
    if (!base || !key.startsWith(base + '/')) { this.retire(); return true; }
    const path = key.slice(base.length + 1);
    const metadata = path === 'config.json' || path.startsWith('packages/');
    const ownLibrary = path.startsWith(`libraries/${slug}/`);
    const entity = /^(entries|macros)\//.test(path);
    const relevant = metadata || ownLibrary || (!path.startsWith('libraries/') && !entity) ||
      (entity && (this.pending || !this.dependencies || this.dependencies.has(path)));
    if (relevant) this.retire();
    return relevant;
  }

  private bind(root: vscode.Uri): EntryIdentityIndex {
    if (this.root?.toString(true) !== root.toString(true) || !this.index) {
      this.retire(); this.root = root;
      const base = vscode.Uri.joinPath(root, '.SNL_Doc');
      this.index = new EntryIdentityIndex(base.toString(true), {
        readFile: path => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.joinPath(base, path))),
        readDirectory: path => Promise.resolve(vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(base, path)))
      });
    }
    return this.index;
  }

  async lookup(root: vscode.Uri, id: string): Promise<EntryData | null> {
    const index = this.bind(root);
    const generation = this.generation;
    const session = await createLibraryPointReadSession(index);
    const result = await session.readEntry(id);
    if (generation !== this.generation) throw new StaleEntryIdentityIndexError('Library lookup retired.');
    return result.record?.entry as unknown as EntryData ?? null;
  }

  async read(root: vscode.Uri, slug: string) {
    const index = this.bind(root);
    const generation = ++this.generation;
    this.pending = true;
    this.dependencies = undefined;
    try {
      const session = await createLibraryPointReadSession(index);
      let closure: LibraryRenderClosure | undefined;
      const graph = await readLibraryGraph(root, slug, { resolveEntries: async ids => {
        closure = await readLibraryRenderClosure(ids, session);
        return [...closure.entries.values()].map(r => r.entry as unknown as EntryData);
      } });
      if (graph.status === 'error') throw new Error(graph.message);
      closure ??= await readLibraryRenderClosure([], session);
      session.assertCurrent();
      if (generation !== this.generation) throw new StaleEntryIdentityIndexError('Library body retired.');
      this.dependencies = new Set(closure.receipts.filter(r => r.phase === 'body-point-read').map(r => r.path));
      return { graph, closure, entries: [...closure.entries.values()].map(r => r.entry as unknown as EntryData),
        macros: Object.fromEntries([...closure.macros].map(([name, r]) => [name, r.macro as unknown as MacroPackageEntry])) };
    } finally {
      if (generation === this.generation) this.pending = false;
    }
  }
}
