import { beforeEach, expect, it, vi } from 'vitest';
import { mkdir, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './libraryPointRead.testSupport';
import { makeEntityStorageReceipt } from './dataMigrations';


const state = vi.hoisted(() => ({ base: '', calls: [] as string[], fail: '', watcher: undefined as any, root: undefined as any, pause: undefined as undefined | (() => Promise<void>) }));
vi.mock('vscode', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const uri = (p: string): any => ({ scheme: 'test', authority: 'cost', path: p, fsPath: p, toString: () => 'test://cost' + p });
  const run = async (op: string, u: any, task: () => Promise<any>) => {
    const relative = path.relative(state.base, u.path);
    state.calls.push(op + ':' + relative);
    if (state.fail && relative === state.fail) throw Object.assign(new Error('denied'), { code: 'NoPermissions' });
    try { const result = await task(); if (op === 'read' && relative === 'libraries/notes/meta.json' && state.pause) { const pause = state.pause; state.pause = undefined; await pause(); } return result; } catch (e: any) { if (e.code === 'ENOENT') e.code = 'FileNotFound'; throw e; }
  };
  return { RelativePattern: class {}, window: { showInformationMessage: vi.fn(), showErrorMessage: vi.fn() }, env: { language: 'en' }, FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: { file: uri, joinPath: (u: any, ...parts: string[]) => uri(path.join(u.path, ...parts)) },
    workspace: { get workspaceFolders() { return [{ uri: state.root }]; }, onDidChangeConfiguration: () => ({ dispose() {} }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }), createFileSystemWatcher: () => { const w = { onDidCreate: (cb: any) => { state.watcher = cb; }, onDidChange: (cb: any) => { state.watcher = cb; }, onDidDelete: (cb: any) => { state.watcher = cb; }, dispose() {} }; return w; }, getConfiguration: () => ({ get: () => undefined }), fs: {
      readFile: (u: any) => run('read', u, () => fs.readFile(u.path)),
      readDirectory: (u: any) => run('dir', u, async () => (await fs.readdir(u.path, { withFileTypes: true })).map(d => [d.name, d.isSymbolicLink() ? 64 : d.isDirectory() ? 2 : 1])),
      stat: (u: any) => run('stat', u, async () => { const s = await fs.lstat(u.path); return { type: s.isSymbolicLink() ? 64 : s.isDirectory() ? 2 : 1 }; }),
      writeFile: (u: any, b: Uint8Array) => run('write', u, () => fs.writeFile(u.path, b)),
      createDirectory: (u: any) => run('mkdir', u, () => fs.mkdir(u.path, { recursive: true })),
      rename: (a: any, b: any) => run('rename', a, () => fs.rename(a.path, b.path)),
      delete: (u: any, opts: any) => run('delete', u, () => fs.rm(u.path, { recursive: opts.recursive }))
    } }
  };
});
import * as vscode from 'vscode';
import { entityRevision } from './snlDoc';
let f: Awaited<ReturnType<typeof fixture>>;
let root: vscode.Uri;
const counter = { id: 'c', name: 'Counter', numbering: '1', children: [] };
const graph = { nodes: [{ id: 'n', label: 'Entry', props: { entryId: 'Seed' } }], relationships: [] };

beforeEach(async () => {
  state.calls = []; state.fail = '';
  f = await fixture(); await f.pkg('_unpackaged'); await f.pkg('alpha', ['Seed']); await f.ent('Seed'); await f.mac('M');
  await f.put('config.json', { ...f.config, entity_storage: { ...f.config.entity_storage, receipt: makeEntityStorageReceipt(null, new Map(), false) }, entry_kinds: [], macro_kinds: [] });
  await mkdir(join(f.root, '.SNL_Doc'));
  for (const p of ['config.json', 'packages', 'entries', 'macros']) await rename(join(f.root, p), join(f.root, '.SNL_Doc', p));
  state.base = join(f.root, '.SNL_Doc'); root = vscode.Uri.file(f.root); state.root = root;
  await f.put('.SNL_Doc/libraries/notes/meta.json', { title: 'Notes', extension: true });
  await f.put('.SNL_Doc/libraries/notes/graph.json', graph);
  await f.put('.SNL_Doc/libraries/notes/counters.json', { counters: [counter] });
});

vi.mock('./preferencesHost', () => ({ bind_preferences_panel_title: () => undefined }));
vi.mock('./preferences', () => ({ extension_preferences_runtime: { query_environment: () => ({ language: 'en' }) } }));
vi.mock('./panelUtil', async original => ({ ...await original<any>(), buildPanelHtml: () => '', handlePanelNavMessage: async () => false }));
import { CreateLibraryPanel } from './createLibraryPanel';
const bodies = () => state.calls.filter(p => /^(read|dir):(entries|macros)(\/|$)/.test(p));
it('real watcher metadata and legacy update retain graph/counters without body I/O; errors recover', async () => {
  const posted: any[] = [];
  const panel = { webview: { postMessage: async (m: any) => { posted.push(m); return true; }, onDidReceiveMessage() {} }, onDidChangeViewState() {}, onDidDispose() {}, dispose() {} };
  const host = new (CreateLibraryPanel as any)(panel, root, 'edit', 'notes');
  try {
    await host.handleMessage({ type: 'ready' });
    expect(posted.some(m => m.type === 'graph' && m.nodes.length === 1)).toBe(true);
    expect(posted.some(m => m.type === 'countersLoaded')).toBe(true);
    state.calls = []; posted.length = 0;
    await f.put('.SNL_Doc/libraries/notes/meta.json', { title: 'Foreign' });
    state.watcher(vscode.Uri.joinPath(root, '.SNL_Doc/libraries/notes/meta.json'));
    await vi.waitFor(() => expect(posted.some(m => m.type === 'libraryMetadata')).toBe(true));
    expect(posted).toEqual([expect.objectContaining({ type: 'libraryMetadata', slug: 'notes', existing: { slug: 'notes', title: 'Foreign' }, libraryRevision: entityRevision({ title: 'Foreign' }) })]);
    expect(bodies()).toEqual([]);
    expect(state.calls.some(p => /libraries\/notes\/(graph|counters)\.json/.test(p))).toBe(false);
    posted.length = 0; state.calls = [];
    await host.handleMessage({ type: 'update', title: 'Legacy', expectedRevision: entityRevision({ title: 'Foreign' }) });
    expect(posted.map(m => m.type)).toEqual(['updated', 'libraryMetadata']);
    expect(posted[0].revision).toBe(entityRevision({ title: 'Legacy' }));
    expect(bodies()).toEqual([]);
    const good = JSON.parse(await readFile(join(state.base, 'config.json'), 'utf8'));
    await f.put('.SNL_Doc/config.json', { ...good, entity_storage: {} });
    posted.length = 0; state.calls = [];
    state.watcher(vscode.Uri.joinPath(root, '.SNL_Doc/libraries/notes/meta.json'));
    await vi.waitFor(() => expect(posted.some(m => m.type === 'libraryMetadataError')).toBe(true));
    expect(bodies()).toEqual([]);
    await f.put('.SNL_Doc/config.json', good);
    posted.length = 0;
    state.watcher(vscode.Uri.joinPath(root, '.SNL_Doc/libraries/notes/meta.json'));
    await vi.waitFor(() => expect(posted.some(m => m.type === 'libraryMetadata')).toBe(true));
    posted.length = 0;
    await host.handleMessage({ type: 'requestGraph' });
    expect(posted.some(m => m.type === 'graph' && m.nodes.length === 1)).toBe(true);
  } finally { host.dispose(); }
});

it('metadata invalidation during initial context still hydrates and retarget rejects a pending metadata reply', async () => {
  const posted: any[] = [];
  const panel = { webview: { postMessage: async (m: any) => { posted.push(m); return true; }, onDidReceiveMessage() {} }, onDidChangeViewState() {}, onDidDispose() {}, dispose() {} };
  const host = new (CreateLibraryPanel as any)(panel, root, 'edit', 'notes');
  try {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    state.pause = () => { entered(); return new Promise<void>(done => { release = done; }); };
    const initial = host.handleMessage({ type: 'ready' });
    await started;
    await f.put('.SNL_Doc/libraries/notes/meta.json', { title: 'Latest' });
    state.watcher(vscode.Uri.joinPath(root, '.SNL_Doc/libraries/notes/meta.json'));
    release(); await initial;
    expect(posted.find(m => m.type === 'context').existing.title).toBe('Latest');
    expect(posted.some(m => m.type === 'graph' && m.nodes.length === 1)).toBe(true);
    expect(posted.some(m => m.type === 'countersLoaded')).toBe(true);
    await vi.waitFor(() => expect(posted.some(m => m.type === 'libraryMetadata')).toBe(true));
    posted.length = 0;
    let enteredAgain!: () => void;
    const again = new Promise<void>(done => { enteredAgain = done; });
    state.pause = () => { enteredAgain(); return new Promise<void>(done => { release = done; }); };
    const pending = host.pushMetadata(); await again;
    host.transitionToEdit('other');
    release(); await pending;
    expect(posted).toEqual([]);
  } finally { host.dispose(); }
});
