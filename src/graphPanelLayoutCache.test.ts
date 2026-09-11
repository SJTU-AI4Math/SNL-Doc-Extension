import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cachePath, clearCache } from './derivedCache';
const state = vi.hoisted(() => ({ root: '', scheme: 'file', language: 'en', title: 'Alpha', macroGate: undefined as Promise<void> | undefined, watchers: [] as Array<{ pattern: string; callback?: () => void }> }));
vi.mock('vscode', () => ({ RelativePattern: class { constructor(public root: unknown, public pattern: string) {} },
  workspace: { createFileSystemWatcher: (p: { pattern: string }) => { const w = { pattern: p.pattern, callback: undefined as (() => void) | undefined }; state.watchers.push(w); return { onDidCreate: (fn: () => void) => { w.callback = fn; }, onDidChange() {}, onDidDelete() {}, dispose() {} }; } },
  window: { showErrorMessage: vi.fn() }, commands: { executeCommand: vi.fn() } }));
vi.mock('./preferences', () => ({ read_extension_preferences: () => ({ language: state.language }) }));
vi.mock('./panelUtil', () => ({ firstWorkspaceFolder: () => ({ scheme: state.scheme, fsPath: state.root, toString: () => `${state.scheme}://provider${state.root}` }), handlePanelNavMessage: async () => false }));
vi.mock('./snlDoc', () => ({
  readEntries: async () => ['a', 'b', 'c'].map(id => ({ id, package: 'p', title: id === 'a' ? state.title : id, kind: 'theorem', content: {} })),
  readEntryKinds: async () => [],
  readRelationships: async () => [['a','b'], ['b','c'], ['a','c']].map(([from,to]) => ({ id: from+to, from, to, label: 'related' })),
  listLibraries: async () => ['one','two'].map(slug => ({ slug, title: slug })),
  readLibraryGraph: async () => ({ status: 'ok', result: { graph: { nodes: ['a','b','c'].map(entryId => ({ label: 'Entry', props: { entryId } })) } } }),
  readAllMacros: async () => { const gate = state.macroGate; state.macroGate = undefined; await gate; return {}; }, readMacroKinds: async () => []
}));
async function panel(slug?: string) {
  const { GraphPanel } = await import('./graphPanel');
  const posted: any[] = [];
  const instance = Object.assign(Object.create(GraphPanel.prototype), { disposables: [], scope: slug ? { mode: 'library', slug } : { mode: 'pool' }, graphGeneration: 0,
    panel: { webview: { postMessage: async (msg: unknown) => { posted.push(msg); return true; } } } });
  return { instance, posted };
}
beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'snl-graph-cache-')); state.title = 'Alpha'; state.language = 'en'; state.scheme = 'file'; state.watchers = [];
  for (const slug of ['one','two']) await fs.mkdir(path.join(state.root, '.SNL_Doc/libraries', slug), { recursive: true });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(state.root, { recursive: true, force: true }); });
it('provider Library graphs retain scoped layout in memory without touching the colliding local tree', async () => {
  state.scheme = 'memfs';
  const { instance, posted } = await panel('one');
  const spies = (['lstat', 'mkdir', 'open', 'writeFile', 'readFile', 'rename', 'unlink'] as const).map(m => vi.spyOn(fs, m));
  await instance.pushGraph(); await instance.pushGraph();
  expect(posted[0].layoutCache).toBeDefined();
  expect(posted[1].layoutCache).toEqual(posted[0].layoutCache);
  await clearCache({ uri: `memfs://provider${state.root}` }, 'graph-layout', { library: 'one' });
  await instance.pushGraph(); expect(posted[2].layoutCache).toEqual(posted[0].layoutCache);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});
it('opening a Library graph publishes and consumes a scoped cache; clear rebuilds identical geometry', async () => {
  const { instance, posted } = await panel('one');
  await instance.handleMessage({ type: 'ready' });
  expect(posted[0].layoutCache).toBeDefined();
  const file = cachePath(state.root, 'graph-layout', { library: 'one' });
  const bytes = await fs.readFile(file, 'utf8');
  expect(JSON.parse(bytes).value).toEqual(posted[0].layoutCache.layout);
  const before = await fs.stat(file);
  await instance.pushGraph();
  expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  expect(posted[1].layoutCache).toEqual(posted[0].layoutCache);
  await clearCache(state.root, 'graph-layout', { library: 'one' });
  await instance.pushGraph();
  expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  expect(posted[2].layoutCache).toEqual(posted[0].layoutCache);
  expect(posted[0].layoutCache.layout.edges.some((e: any) => e.waypoints.length)).toBe(true);
});
it('isolates two Library owners and invalidates titles/language without persisting a pool cache', async () => {
  const one = await panel('one'), two = await panel('two');
  await one.instance.pushGraph(); await two.instance.pushGraph();
  const a = cachePath(state.root, 'graph-layout', { library: 'one' }), b = cachePath(state.root, 'graph-layout', { library: 'two' });
  const originalA = await fs.readFile(a, 'utf8'), originalB = await fs.readFile(b, 'utf8');
  expect(one.posted[0].layoutCache.key).not.toBe(two.posted[0].layoutCache.key);
  state.title = 'A substantially longer title that changes node width'; state.language = 'zh-CN';
  await one.instance.pushGraph();
  expect(await fs.readFile(a, 'utf8')).not.toBe(originalA);
  expect(await fs.readFile(b, 'utf8')).toBe(originalB);
  const pool = await panel(); await pool.instance.pushGraph();
  expect(pool.posted[0].type).toBe('graph');
  expect(pool.posted[0].layoutCache).toBeUndefined();
  await expect(fs.stat(cachePath(state.root, 'graph-layout'))).rejects.toThrow();
});

it('cache outputs do not match the authored watcher subscription and arbitrary cache messages cannot publish', async () => {
  const { instance, posted } = await panel('one');
  instance.installWatcher();
  const authored = '.SNL_Doc/libraries/one/graph.json';
  const cache = '.SNL_Doc/libraries/one/.cache/graph-layout/result.json';
  // These are the actual VS Code RelativePattern subscriptions installed by GraphPanel.
  const matches = (pattern: string, file: string) => new RegExp('^' + pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$').test(file);
  expect(state.watchers.some(w => matches(w.pattern, authored))).toBe(true);
  expect(state.watchers.some(w => matches(w.pattern, cache))).toBe(false);
  for (const type of ['writeGraphLayout', 'graph-layout/write', 'readCache']) {
    await instance.handleMessage({ type, path: '/tmp/not-authorized', library: 'two', layout: { nodes: [] } });
  }
  expect(posted).toHaveLength(0);
  await expect(fs.stat(cachePath(state.root, 'graph-layout', { library: 'two' }))).rejects.toThrow();
  instance.disposables.forEach((d: { dispose(): void }) => d.dispose());
});

it('does not let an older graph generation replace the current Library cache or message', async () => {
  const { instance, posted } = await panel('one');
  let release!: () => void;
  state.macroGate = new Promise<void>(r => { release = r; });
  const older = instance.pushGraph();
  // Wait until the real old request has captured its canonical nodes and is parked.
  await vi.waitFor(() => expect(state.macroGate).toBeUndefined());
  state.title = 'new authoritative title';
  await instance.pushGraph();
  release(); await older;
  expect(posted).toHaveLength(1);
  expect(posted[0].nodes.find((n: any) => n.id === 'a').title).toBe(state.title);
  const disk = JSON.parse(await fs.readFile(cachePath(state.root, 'graph-layout', { library: 'one' }), 'utf8'));
  expect(disk.value.nodes.find((n: any) => n.id === 'a').title).toBe(state.title);
});
