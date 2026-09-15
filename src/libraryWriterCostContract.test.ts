import { beforeEach, expect, it, vi } from 'vitest';
import { mkdir, rename, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './libraryPointRead.testSupport';
import { makeEntityStorageReceipt } from './dataMigrations';
import { entryEntityPath, macroEntityPath, packageManifestPath } from './entityStorage';

const state = vi.hoisted(() => ({ base: '', calls: [] as string[], fail: '' }));
vi.mock('vscode', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const uri = (p: string): any => ({ scheme: 'test', authority: 'cost', path: p, fsPath: p, toString: () => 'test://cost' + p });
  const run = async (op: string, u: any, task: () => Promise<any>) => {
    const relative = path.relative(state.base, u.path);
    state.calls.push(op + ':' + relative);
    if (state.fail && relative === state.fail) throw Object.assign(new Error('denied'), { code: 'NoPermissions' });
    try { return await task(); } catch (e: any) { if (e.code === 'ENOENT') e.code = 'FileNotFound'; throw e; }
  };
  return { env: { language: 'en' }, FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: { file: uri, joinPath: (u: any, ...parts: string[]) => uri(path.join(u.path, ...parts)) },
    workspace: { getConfiguration: () => ({ get: () => undefined }), fs: {
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
import { updateLibrary, writeLibraryMeta, writeLibraryGraph, writeLibraryCounters, mutateLibraryGraph,
  mutateLibraryCounters, updateLibraryGraphNodeEntryId, wrapLibraryGraphNodeWithParent,
  updateLibraryDraft, createLibrary, deleteLibrary, entityRevision } from './snlDoc';
let f: Awaited<ReturnType<typeof fixture>>;
let root: vscode.Uri;
const counter = { id: 'c', name: 'Counter', numbering: '1', children: [] };
const graph = { nodes: [{ id: 'n', label: 'Entry', props: { entryId: 'Seed' } }], relationships: [] };
const read = async (name: string) => JSON.parse(await readFile(join(state.base, 'libraries/notes', name + '.json'), 'utf8'));
beforeEach(async () => {
  state.calls = []; state.fail = '';
  f = await fixture(); await f.pkg('_unpackaged'); await f.pkg('alpha', ['Seed']); await f.ent('Seed'); await f.mac('M');
  await f.put('config.json', { ...f.config, entity_storage: { ...f.config.entity_storage, receipt: makeEntityStorageReceipt(null, new Map(), false) }, entry_kinds: [], macro_kinds: [] });
  await mkdir(join(f.root, '.SNL_Doc'));
  for (const p of ['config.json', 'packages', 'entries', 'macros']) await rename(join(f.root, p), join(f.root, '.SNL_Doc', p));
  state.base = join(f.root, '.SNL_Doc'); root = vscode.Uri.file(f.root);
  await f.put('.SNL_Doc/libraries/notes/meta.json', { title: 'Notes', extension: true });
  await f.put('.SNL_Doc/libraries/notes/graph.json', graph);
  await f.put('.SNL_Doc/libraries/notes/counters.json', { counters: [counter] });
});
const writers = [
  ['updateLibrary', async () => updateLibrary(root, 'notes', { title: 'Saved' }, entityRevision(await read('meta')))],
  ['writeLibraryMeta', async () => writeLibraryMeta(root, 'notes', { title: 'Saved' })],
  ['writeLibraryGraph', async () => writeLibraryGraph(root, 'notes', graph)],
  ['writeLibraryCounters', async () => { await writeLibraryCounters(root, 'notes', [counter]); return { status: 'ok' }; }],
  ['mutateLibraryGraph', async () => mutateLibraryGraph(root, 'notes', g => { g.nodes[0].props.entryId = 'Changed'; return true; })],
  ['mutateLibraryCounters', async () => mutateLibraryCounters(root, 'notes', cs => { cs[0].name = 'Changed'; return true; })],
  ['updateLibraryGraphNodeEntryId', async () => updateLibraryGraphNodeEntryId(root, 'notes', 'n', 'Seed', 'Changed')],
  ['wrapLibraryGraphNodeWithParent', async () => wrapLibraryGraphNodeWithParent(root, 'notes', 'n', { id: 'parent', label: 'Entry', props: {} })],
  ['updateLibraryDraft', async () => updateLibraryDraft(root, 'notes', { title: 'Saved', graph, counters: [counter], expectedRevisions: {
    meta: entityRevision(await read('meta')), graph: entityRevision(await read('graph')), counters: entityRevision(await read('counters'))
  } })],
  ['createLibrary', async () => createLibrary(root, 'Created')],
  ['deleteLibrary', async () => deleteLibrary(root, 'notes')]
] as const;
const bodies = () => state.calls.filter(p => /^(read|dir):(entries|macros)(\/|$)/.test(p));
const writes = () => state.calls.filter(p => /^(write|mkdir|rename|delete):/.test(p));
it.each(writers)('%s performs zero Entry/Macro body reads or enumeration', async (_name, writer) => {
  // Real valid bodies make baseline admission succeed: this RED measures I/O,
  // not a mocked validator or an invalid unrelated fixture.
  const result = await writer();
  expect(['ok', 'updated', 'created']).toContain(result.status);
  expect(writes().length).toBeGreaterThan(0);
  expect(state.calls).toContain('dir:packages');
  expect(bodies()).toEqual([]);
});
it.each(writers)('%s rejects invalid current receipts before any mutation', async (_name, writer) => {
  await f.put('.SNL_Doc/config.json', { ...f.config, entry_kinds: [], macro_kinds: [], entity_storage: {} });
  let result: any;
  try { result = await writer(); } catch (error) { result = { status: 'error', error }; }
  expect(result.status).toBe('error'); expect(writes()).toEqual([]);
});
it.each(writers)('%s rejects unreadable Package metadata before any mutation', async (_name, writer) => {
  state.fail = packageManifestPath('alpha');
  let result: any;
  try { result = await writer(); } catch (error) { result = { status: 'error', error }; }
  expect(result.status).toBe('error'); expect(writes()).toEqual([]);
});
it.each(writers)('%s ignores unrelated malformed bodies, not metadata', async (_name, writer) => {
  await f.put('.SNL_Doc/' + entryEntityPath('alpha', 'Unrelated'), {});
  await f.put('.SNL_Doc/' + macroEntityPath('alpha', 'Unrelated'), {});
  const result = await writer();
  expect(['ok', 'updated', 'created']).toContain(result.status); expect(bodies()).toEqual([]);
});

it.each(['receipt-digest', 'future-version', 'kind-schema', 'active-system', 'missing-system', 'duplicate-membership', 'symlink-directory'])('legacy metadata admission preserves %s rejection', async defect => {
  const config = JSON.parse(await readFile(join(state.base, 'config.json'), 'utf8'));
  if (defect === 'receipt-digest') config.entity_storage.receipt.entries_digest = 'wrong';
  if (defect === 'future-version') config.version = '99.0.0';
  if (defect === 'kind-schema') config.entry_kinds = [{ id: 'broken' }];
  if (defect === 'active-system') config.active_macro_packages = ['_unpackaged'];
  if (defect === 'missing-system') await rm(join(state.base, packageManifestPath('_unpackaged')));
  if (defect === 'duplicate-membership') {
    const manifest = JSON.parse(await readFile(join(state.base, packageManifestPath('_unpackaged')), 'utf8'));
    manifest.entry_ids = ['Seed']; await f.put('.SNL_Doc/' + packageManifestPath('_unpackaged'), manifest);
  }
  if (defect === 'symlink-directory') {
    await rename(join(state.base, 'entries'), join(state.base, 'saved-entries'));
    await symlink(join(state.base, 'saved-entries'), join(state.base, 'entries'));
  }
  await f.put('.SNL_Doc/config.json', config);
  expect(await writeLibraryGraph(root, 'notes', graph)).toMatchObject({ status: 'error' });
  expect(writes()).toEqual([]);
});
