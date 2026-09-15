import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';

const state = vi.hoisted(() => ({ root: '' }));
// Only VS Code transport/preferences are substituted. The Host, entity readers,
// dependency composition, runner and PageRank all execute production code.
vi.mock('vscode', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const uri = (p: string): any => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` });
  return {
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: { file: uri, joinPath: (base: any, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
    workspace: { fs: {
      stat: async (u: any) => { const s = await fs.lstat(u.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; },
      readFile: (u: any) => fs.readFile(u.fsPath),
      readDirectory: async (u: any) => (await fs.readdir(u.fsPath, { withFileTypes: true })).map(d => [d.name, d.isDirectory() ? 2 : 1]),
      createDirectory: (u: any) => fs.mkdir(u.fsPath, { recursive: true }),
      writeFile: (u: any, b: Uint8Array) => fs.writeFile(u.fsPath, b),
      rename: (a: any, b: any) => fs.rename(a.fsPath, b.fsPath),
      delete: (u: any) => fs.rm(u.fsPath, { recursive: true, force: true })
    } },
    window: { showErrorMessage: vi.fn(), createOutputChannel: () => ({ appendLine() {}, dispose() {} }) }
  };
});
vi.mock('./preferences', () => ({ read_extension_preferences: () => ({ language: 'en' }) }));
vi.mock('./panelUtil', () => ({ firstWorkspaceFolder: () => vscode.Uri.file(state.root) }));
import { InfoviewPanel } from './infoviewPanel';
import { LibraryBodyHost } from './libraryBodyHost';
import { initSnlDoc, createEntryKind, createLibrary, createMacroPackage, addMacro,
  addEntry, readEntries, updateEntry, entityRevision, readRelationships } from './snlDoc';
import { cachePath } from './derivedCache';
import * as cache from './derivedCache';
import { entryEntityPath } from './entityStorage';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(async () => { vi.restoreAllMocks(); if (state.root) await fs.rm(state.root, { recursive: true, force: true }); state.root = ''; });
async function fixture() {
  state.root = await fs.mkdtemp(join(tmpdir(), 'snl-reader-race-'));
  const uri = vscode.Uri.file(state.root);
  expect(await initSnlDoc(uri)).toEqual({ status: 'created' });
  expect(await createEntryKind(uri, { id: 'entry', name: 'Entry', description: '', coloring: { light: { stroke: '', background: '' }, dark: { stroke: '', background: '' } }, defaultCounterName: '', style: '' })).toMatchObject({ status: 'created' });
  for (const id of ['A', 'B']) expect(await addEntry(uri, { id, kind: 'entry', title: id, content: { snl: '' }, pointer: null, contribution_info: null })).toMatchObject({ status: 'ok' });
  expect(await createMacroPackage(uri, 'Test', 'Test')).toMatchObject({ status: 'ok' });
  expect(await addMacro(uri, 'Test', { name: 'testMacro', kind: 'const', description: '', source: { entries: ['B'], urls: [] }, dynamic_arity: false, styles: [{ style_name: 'default', template: { mode: 'formula_inline', body: 'x' }, tags: [] }], tags: [] })).toMatchObject({ status: 'ok' });
  expect(await createLibrary(uri, 'lib')).toMatchObject({ status: 'created', slug: 'lib' });
  await fs.writeFile(join(state.root, '.SNL_Doc/libraries/lib/graph.json'), JSON.stringify({ nodes: ['A', 'B'].map(id => ({ id: `node-${id}`, label: 'Entry', props: { entryId: id } })), relationships: [] }));
  await fs.writeFile(join(state.root, '.SNL_Doc/libraries/lib/counters.json'), JSON.stringify({ counters: [] }));
  await fs.writeFile(join(state.root, '.SNL_Doc/relationships.json'), JSON.stringify({ version: 1, relationships: [{ id: 'manual', from: 'B', to: 'A', label: 'depends', metadata: null }] }));
  expect((await readRelationships(uri)).map(r => r.id)).toEqual(['manual']); // warm old A artifact
  const posted: any[] = [];
  const panel: any = Object.assign(Object.create(InfoviewPanel.prototype), {
    libraryBody: new LibraryBodyHost(), viewGeneration: 0, entryHistory: [], fallbackReturnRoute: { kind: 'root' }, contentLanguage: 'en',
    panel: { webview: { postMessage: async (m: unknown) => { posted.push(m); return true; } } }
  });
  return { uri, panel, posted };
}

it.each(['counters', 'relationships'] as const)('keeps current B relationships and PageRank when old A resumes at %s I/O', async boundary => {
  const { uri, panel, posted: allPosted } = await fixture();
  const capturedA = deferred(), oldPaused = deferred(), releaseOld = deferred();
  const currentLookup = deferred(), releaseCurrent = deferred();
  const originalRead = vscode.workspace.fs.readFile.bind(vscode.workspace.fs);
  const aFile = join(state.root, '.SNL_Doc', entryEntityPath('_unpackaged', 'A'));
  const pauseFile = join(state.root, boundary === 'counters' ? '.SNL_Doc/libraries/lib/counters.json' : '.SNL_Doc/relationships.json');
  let paused = false;
  vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async u => {
    const bytes = await originalRead(u);
    if (u.fsPath === aFile) capturedA.resolve();
    if (u.fsPath === pauseFile && !paused) { paused = true; oldPaused.resolve(); await releaseOld.promise; }
    return bytes;
  });
  const open = fs.open;
  let dependencyLookups = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (args[0] === cachePath(state.root, 'dependencies') && ++dependencyLookups === 1) {
      currentLookup.resolve(); await releaseCurrent.promise;
    }
    return open(...args);
  });
  const old = panel.pushLibraryEntries('lib');
  let current: Promise<void> | undefined;
  try {
    await Promise.all([capturedA.promise, oldPaused.promise]);
    const entry = (await readEntries(uri)).find(e => e.id === 'A')!;
    expect(await updateEntry(uri, 'A', { ...entry, content: { snl: 'testMacro' } }, entityRevision(entry))).toMatchObject({ status: 'updated' });
    current = panel.pushLibraryEntries('lib');
    await currentLookup.promise; // current B owns runner lookup, not yet settled
    releaseOld.resolve(); await old; // old A can enter runner after B (no UI publication)
    releaseCurrent.resolve(); await current;
    // The early body is now independent from the complete global ACK. Old A
    // may publish its body before retirement, but must never ACK global data.
    expect(allPosted.map(m => [m.type, m.bodyGeneration])).toEqual(boundary === 'counters'
      ? [['libraryEntries', 2], ['libraryRegions', 2]]
      : [['libraryEntries', 1], ['libraryEntries', 2], ['libraryRegions', 2]]);
    const posted = allPosted.filter(m => m.type === 'libraryRegions');
    expect(posted).toHaveLength(1);
    expect(posted[0].entryRecords.find((e: any) => e.id === 'A').content.snl).toBe('testMacro');
    expect(posted[0].relationships.map((r: any) => r.id).sort()).toEqual(['dep.A.B', 'manual']);
    expect(posted[0].warnings).toEqual([]);
    expect(posted[0].globalPageRank).toMatchObject({ scope: 'workspace', converged: true, scores: { A: expect.any(Number), B: expect.any(Number) } });
    expect(panel.readerSnapshot.relationships.map((r: any) => r.id).sort()).toEqual(['dep.A.B', 'manual']);
    // The pre-entry guard independently matters: a request already retired at
    // the counters boundary must not touch the shared dependency runner at all.
    expect(dependencyLookups).toBe(boundary === 'counters' ? 1 : 2);
  } finally { releaseOld.resolve(); releaseCurrent.resolve(); await Promise.all([old, current]); }
});

it('does not let a retired Library request enter shared SSI/PageRank after graph I/O', async () => {
  const { panel } = await fixture();
  const paused = deferred(), release = deferred();
  const originalRead = vscode.workspace.fs.readFile.bind(vscode.workspace.fs);
  let graphReads = 0;
  vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(async u => {
    const bytes = await originalRead(u);
    // First graph read belongs to the point-read body; second follows the
    // complete dependency computation, matching this historical race seam.
    if (u.fsPath.endsWith('/lib/graph.json') && ++graphReads === 2) { paused.resolve(); await release.promise; }
    return bytes;
  });
  const runner = vi.spyOn(cache, 'getOrGenerateCache');
  const old = panel.pushLibraryEntries('lib');
  try {
    await paused.promise;
    await panel.pushLibraries(); // retire without starting more derived work
    release.resolve(); await old;
    expect(runner.mock.calls.map(([, request]) => request.id)).toEqual(['dependencies']);
  } finally { release.resolve(); await old; }
});
