import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { CachedEntryMetrics } from './cachedEntryMetrics';
const state = vi.hoisted(() => ({ root: '', scheme: 'file', posted: [] as any[], nativeRead: null as any,
  entries: [
    { id: 'target', package: 'one', title: 'Target', kind: 'definition', content: { snl: 'x@context' }, pointer: null },
    { id: 'context', package: 'two', title: 'Context', kind: 'definition', content: { snl: '@x' }, pointer: null }
  ]
}));
vi.mock('vscode', () => ({ window: { showErrorMessage: vi.fn() }, commands: { executeCommand: vi.fn() } }));
vi.mock('./preferences', () => ({ read_extension_preferences: () => ({ language: 'en' }) }));
vi.mock('./snlDoc', () => ({
  readEntries: vi.fn(async () => state.entries), readEntryKinds: async () => [], readRelationships: async () => [],
  readAllMacros: async () => ({}), readMacroKinds: async () => [], readWorkspaceSupportedLanguages: async () => ['en'],
  listLibraries: async () => [{ slug: 'lib', title: 'Library' }], readLibraryCounters: async () => [],
  readLibraryGraph: async () => ({ status: 'ok', result: { warnings: [], graph: {
    nodes: [{ id: 'occurrence', label: 'Entry', props: { entryId: 'target' } }], relationships: []
  } } })
}));
vi.mock('./panelUtil', () => ({
  firstWorkspaceFolder: () => ({ scheme: state.scheme, fsPath: state.root, path: state.root, toString: () => `${state.scheme}://provider${state.root}` })
}));
// Load the real CJS host implementation outside Vitest's ESM VM. Only I/O-bound
// workspace reads and VS Code transport are faked, not the calculator/cache.
vi.mock('./ssiCache', () => ({ readCachedEntryMetrics: (...args: unknown[]) => state.nativeRead(...args) }));
let compiled = '';
beforeAll(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'snl-ssi-panel-')); await mkdir(join(state.root, '.SNL_Doc'));
  const repo = fileURLToPath(new URL('..', import.meta.url));
  compiled = await mkdtemp(join(repo, 'node_modules', '.ssi-panel-'));
  await build({ absWorkingDir: repo, entryPoints: ['src/ssiCache.ts'], outdir: compiled,
    bundle: true, packages: 'external', platform: 'node', format: 'cjs' });
  state.nativeRead = createRequire(import.meta.url)(join(compiled, 'ssiCache.js')).readCachedEntryMetrics;
});
afterAll(async () => { await Promise.all([state.root, compiled].filter(Boolean).map(p => rm(p, { recursive: true, force: true }))); });
async function harness(): Promise<any> {
  const { InfoviewPanel } = await import('./infoviewPanel');
  return Object.assign(Object.create(InfoviewPanel.prototype), {
    viewGeneration: 0, entryHistory: [], fallbackReturnRoute: { kind: 'root' }, contentLanguage: 'en',
    assetBaseUri: () => '',
    panel: { webview: { postMessage: async (m: unknown) => { state.posted.push(m); return true; } } }
  });
}
it('Entry and Library host messages consume one saved global cache while returning only visible Entry results', async () => {
  const panel = await harness();
  await panel.pushLibraryEntries('lib');
  const frozen = panel.readerSnapshot;
  await panel.pushEntryDetailsForEntry('target');
  const library = state.posted.find(m => m.type === 'libraryEntries');
  const entry = state.posted.find(m => m.type === 'entryDetails');
  for (const message of [library, entry]) {
    expect(message?.cachedEntryMetrics).toMatchObject({ scope: 'workspace', status: 'ready', entries: {
      target: { kind: 'ok', metrics: { structuralIndex: 1 } }
    } });
    expect(Object.keys((message.cachedEntryMetrics as Extract<CachedEntryMetrics, { status: 'ready' }>).entries)).toEqual(['target']);
  }
  const stored = JSON.parse(await readFile(join(state.root, '.SNL_Doc/.cache/ssi/result.json'), 'utf8'));
  expect(Object.keys(stored.value)).toEqual(['context', 'target']);
  const rank = JSON.parse(await readFile(join(state.root,'.SNL_Doc/.cache/pagerank/result.json'),'utf8')).value;
  for (const message of [library, entry]) {
    expect(message.globalPageRank).toMatchObject({scope:'workspace',converged:true,scores:{target:rank.scores.target}});
    expect(Object.keys(message.globalPageRank.scores)).toEqual(['target']);
  }
  expect(Object.keys(frozen.cachedEntryMetrics.entries).sort()).toEqual(['context','target']);
  expect(frozen.globalPageRank.scores).toEqual(rank.scores);
});
it('provider Entry and Library projections consume ready SSI/PageRank without native cache I/O', async () => {
  state.scheme = 'memfs'; state.posted.length = 0;
  const spies = (['lstat', 'mkdir', 'open', 'writeFile', 'readFile', 'rename', 'unlink'] as const).map(m => vi.spyOn(fs, m));
  try {
    const panel = await harness(); await panel.pushLibraryEntries('lib'); await panel.pushEntryDetailsForEntry('target');
    for (const message of state.posted.filter(m => ['libraryEntries', 'entryDetails'].includes(m.type))) {
      expect(message.cachedEntryMetrics).toMatchObject({ status: 'ready', entries: { target: { kind: 'ok' } } });
      expect(message.globalPageRank).toMatchObject({ scope: 'workspace', converged: true });
    }
    expect(state.posted.filter(m => ['libraryEntries', 'entryDetails'].includes(m.type))).toHaveLength(2);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); state.scheme = 'file'; }
});
it('freezes global values for the closure without exporting an unrelated private Entry', async () => {
  state.posted.length = 0;
  state.entries.push({id:'private',package:'two',title:'Private',kind:'definition',content:{snl:'z'},pointer:null});
  try {
    const panel = await harness(); await panel.pushLibraryEntries('lib');
    const frozen = panel.readerSnapshot;
    expect(frozen.entries.map((e:any) => e.id).sort()).toEqual(['context','target']);
    expect(Object.keys(frozen.cachedEntryMetrics.entries).sort()).toEqual(['context','target']);
    expect(Object.keys(frozen.globalPageRank.scores).sort()).toEqual(['context','target']);
    const rank = JSON.parse(await readFile(join(state.root,'.SNL_Doc/.cache/pagerank/result.json'),'utf8')).value;
    expect(Object.keys(rank.scores).sort()).toEqual(['context','private','target']);
    expect(frozen.globalPageRank.scores.target).toBe(rank.scores.target);
    expect(JSON.stringify(frozen)).not.toContain('"private"');
  } finally { state.entries.pop(); }
});
