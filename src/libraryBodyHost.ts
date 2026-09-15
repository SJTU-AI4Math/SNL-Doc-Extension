import * as vscode from 'vscode';
import { AsyncLocalStorage } from 'node:async_hooks';
import { firstWorkspaceFolder, installSnlDocWatcher } from './panelUtil';
import { EntryIdentityIndex, StaleEntryIdentityIndexError } from './entryIdentityIndex';
import { createLibraryPointReadSession } from './libraryPointRead';
import { readLibraryRenderClosure, type LibraryRenderClosure } from './libraryDependencyClosure';
import { readLibraryGraph, type EntryData, type MacroPackageEntry } from './snlDoc';

/** Rebind real subscriptions and their debounce on first-root replacement.
 * Binding generations reject late provider callbacks, including root ABA. */
export function installLibraryWatcher(
  owner: vscode.Disposable[],
  refresh: (uris?: readonly vscode.Uri[]) => void | Promise<void>,
  pathFilter?: RegExp,
  invalidate?: (uri: vscode.Uri) => boolean | void,
  rootChanged?: () => void
): void {
  let root = firstWorkspaceFolder();
  const binding: vscode.Disposable[] = [];
  let generation = 0;
  let disposed = false;
  const release = () => { generation++; for (const d of binding.splice(0)) d.dispose(); };
  const bind = () => {
    if (!root) return;
    const key = root.toString(true);
    const base = vscode.Uri.joinPath(root, '.SNL_Doc').toString(true) + '/';
    const token = generation;
    const current = () => !disposed && token === generation && key === firstWorkspaceFolder()?.toString(true);
    installSnlDocWatcher(binding, uris => { if (current()) return refresh(uris); }, pathFilter, uri => {
      if (!current() || !uri.toString(true).startsWith(base)) return false;
      return invalidate?.(uri);
    });
  };
  bind();
  const folders = vscode.workspace.onDidChangeWorkspaceFolders?.(() => {
    const next = firstWorkspaceFolder();
    if (disposed || next?.toString(true) === root?.toString(true)) return;
    release(); root = next; rootChanged?.(); bind(); void refresh();
  });
  owner.push({ dispose: () => { if (disposed) return; disposed = true; release(); folders?.dispose(); } });
}

/** One panel lifetime. Identity metadata is cached; bodies and misses never are.
 * Dependencies are authoritative only after a successful settled body request. */
export class LibraryBodyHost {
  // Only coalesce provider reads within one body/lookup operation. A warm
  // identity index still revalidates owners against fresh bytes next time.
  private readonly operationReads = new AsyncLocalStorage<Map<string, Promise<Uint8Array>>>();

  private readFile(base: vscode.Uri, path: string): Promise<Uint8Array> {
    const uri = vscode.Uri.joinPath(base, path);
    const reads = this.operationReads.getStore();
    if (!reads) return Promise.resolve(vscode.workspace.fs.readFile(uri));
    const key = uri.toString(true);
    let pending = reads.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => vscode.workspace.fs.readFile(uri));
      reads.set(key, pending);
    }
    return pending;
  }

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
        readFile: path => this.readFile(base, path),
        readDirectory: path => Promise.resolve(vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(base, path)))
      });
    }
    return this.index;
  }

  async lookup(root: vscode.Uri, id: string): Promise<EntryData | null> {
    return this.operationReads.run(new Map(), () => this.lookupEntry(root, id));
  }

  private async lookupEntry(root: vscode.Uri, id: string): Promise<EntryData | null> {
    const index = this.bind(root);
    const generation = this.generation;
    const session = await createLibraryPointReadSession(index);
    const result = await session.readEntry(id);
    if (generation !== this.generation) throw new StaleEntryIdentityIndexError('Library lookup retired.');
    return result.record?.entry as unknown as EntryData ?? null;
  }

  async read(root: vscode.Uri, slug: string) {
    return this.operationReads.run(new Map(), () => this.readBody(root, slug));
  }

  private async readBody(root: vscode.Uri, slug: string) {
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
