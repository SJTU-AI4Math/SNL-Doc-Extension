import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cachePath } from './derivedCache';
import { computeEntryMetricsForIds, computeEntryMetrics } from '../webview/src/components/EntryMetrics';
import { buildContextIndex, extractExportedBinders } from '../webview/src/render/contextSrcLookup';
import { buildContextIndex as buildSharedContextIndex } from './ssiContext';
import * as coreParser from '@sjtu-ai4math/snl-basics/core';
import { resolveSnlSemantics } from '@sjtu-ai4math/snl-basics';
import type { SsiParser } from './ssiMetrics';
// Exercise the actual CommonJS host, not Vitest's VM (which cannot execute
// a native import() inside Function). No parser/cache mocks.
let readCachedEntryMetrics: typeof import('./ssiCache').readCachedEntryMetrics;
let getGlobalSSI: typeof import('./ssiCache').getGlobalSSI;
const poolForGlobal = [{ id: 'target', content: { snl: 'x@context' } }, { id: 'context', content: { snl: '@x' } }];
let clearCache: typeof import('./derivedCache').clearCache;
let compiled: string;
beforeAll(async () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  compiled = await mkdtemp(join(repo, 'node_modules', '.ssi-host-'));
  await build({ absWorkingDir: repo, entryPoints: ['src/ssiCache.ts', 'src/derivedCache.ts'],
    outdir: compiled, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
  const require = createRequire(import.meta.url);
  readCachedEntryMetrics = require(join(compiled, 'ssiCache.js')).readCachedEntryMetrics;
  getGlobalSSI = require(join(compiled, 'ssiCache.js')).getGlobalSSI;
  clearCache = require(join(compiled, 'derivedCache.js')).clearCache;
});
afterAll(async () => { if (compiled) await rm(compiled, { recursive: true, force: true }); });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const entries = [
  { id: 'target', package: 'one', content: { snl: 'x@context' } },
  { id: 'context', package: 'two', content: { snl: '@x' } },
  { id: 'blank', content: {} }, { id: 'broken', content: { snl: '(' } }
];
it('caches global SSI by Entry, serves subsets, reuses disk, preserves unavailable and authored bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snl-ssi-')); roots.push(root);
  await mkdir(join(root, '.SNL_Doc'));
  const source = join(root, '.SNL_Doc', 'fixture.json');
  const bytes = JSON.stringify(entries); await writeFile(source, bytes);
  const first = await readCachedEntryMetrics(root, entries, {}, ['target', 'blank', 'broken']);
  expect(first).toMatchObject({ scope: 'workspace', status: 'ready', entries: {
    target: { kind: 'ok', metrics: { structuralIndex: 1 } },
    blank: { kind: 'unavailable', reason: 'noContent' }, broken: { kind: 'unavailable', reason: 'parseError' }
  } });
  if (first.status !== 'ready') throw new Error(first.error);
  expect(Object.keys(first.entries)).toEqual(['target', 'blank', 'broken']);
  const file = cachePath(root, 'ssi'); const before = await stat(file);
  expect(await readCachedEntryMetrics(root, entries, {}, ['target', 'blank', 'broken'])).toEqual(first);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  await writeFile(file, 'corrupt');
  expect(await readCachedEntryMetrics(root, entries, {}, ['target', 'blank', 'broken'])).toEqual(first);
  await clearCache(root, 'ssi');
  expect(await readCachedEntryMetrics(root, entries, {}, ['target', 'blank', 'broken'])).toEqual(first);
  expect(await readFile(source, 'utf8')).toBe(bytes);
  expect(await readCachedEntryMetrics(root, entries.map(e => e.id === 'context' ? { ...e, content: { snl: '@y' } } : e), {}, ['target']))
    .toMatchObject({ entries: { target: { metrics: { structuralIndex: 0 } } } });
  expect(await readCachedEntryMetrics(root, entries.map(e => e.id === 'target' ? { ...e, content: {} } : e), {}, ['target']))
    .toMatchObject({ entries: { target: { kind: 'unavailable', reason: 'noContent' } } });
  expect(await readCachedEntryMetrics(root, entries.filter(e => e.id !== 'context'), {}, ['target'])).toMatchObject({ entries: { target: { metrics: { structuralIndex: 0 } } } });
});
it('invalidates for active Macro source changes and does not mutate the snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snl-ssi-')); roots.push(root); await mkdir(join(root, '.SNL_Doc'));
  const pool = [{ id: 'target', content: { snl: 'Known' } }]; const bytes = JSON.stringify(pool);
  const source = (urls: string[]) => ({ Known: { source: { entries: [], urls } } });
  expect(await readCachedEntryMetrics(root, pool, source([]), ['target'])).toMatchObject({ entries: { target: { metrics: { structuralIndex: 0 } } } });
  expect(await readCachedEntryMetrics(root, pool, source(['https://example.test']), ['target'])).toMatchObject({ entries: { target: { metrics: { structuralIndex: 1 } } } });
  expect(await readCachedEntryMetrics(root, pool, {}, ['target'])).toMatchObject({ entries: { target: { metrics: { strongSemanticFreedom: 1, weakSemanticFreedom: 0 } } } });
  expect(JSON.stringify(pool)).toBe(bytes);
});
it('matches browser semantics for explicit contexts, binders, numeric and length-weighted nodes', async () => {
  expect((coreParser as unknown as SsiParser).resolveSnlSemantics).toBe(resolveSnlSemantics);
  const root = await mkdtemp(join(tmpdir(), 'snl-ssi-')); roots.push(root); await mkdir(join(root, '.SNL_Doc'));
  const pool = [...entries, ...[
    'context(@x)', 'x@context', 'y@context', 'x@missing', 'Known', '42',
    '"a long natural language sentence with more than six words"', 'f(@x,x)', 'list-partial(@a,@b)',
    'a b', 'a(b', 'unrecognized', 'Known(7)'
  ].map((snl, n) => ({ id: `case-${n}`, content: { snl } }))];
  const macros = { Known: { source: { entries: ['context'], urls: [] } } };
  const expected = Object.fromEntries(computeEntryMetricsForIds(pool, pool.map(e => e.id), macros));
  expect(await readCachedEntryMetrics(root, pool, macros, pool.map(e => e.id))).toEqual({ scope: 'workspace', status: 'ready', entries: expected });
});
it('matches the browser context index and exported binder contract directly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snl-ssi-')); roots.push(root); await mkdir(join(root, '.SNL_Doc'));
  const pool = [
    { id: 'Set.ctxt.AB', content: { snl: 'Type.judge(list-partial(@A,@B),Set(T@Set.ctxt.T))' } },
    { id: 'Set.ctxt.T', content: { snl: '@T' } },
    { id: 'empty', content: {} }, { id: 'broken', content: { snl: '(' } },
    { id: 'resolved', content: { snl: 'A@Set.ctxt.AB' } },
    { id: 'wrong', content: { snl: 'T@Set.ctxt.AB' } },
    { id: 'missing', content: { snl: 'A@absent' } },
    { id: 'local', content: { snl: 'root(@A,A)' } },
    { id: 'binder', content: { snl: '@A@absent' } }
  ];
  const contextIndex = buildContextIndex(pool);
  expect(contextIndex.get('Set.ctxt.AB')).toEqual(new Set(['A', 'B']));
  expect(contextIndex.get('Set.ctxt.T')).toEqual(new Set(['T']));
  expect(contextIndex.get('empty')).toEqual(new Set());
  expect(contextIndex.has('absent')).toBe(false);
  for (const entry of pool) {
    expect(contextIndex.get(entry.id)).toEqual(extractExportedBinders(entry.content.snl ?? ''));
  }
  expect(buildSharedContextIndex(pool, coreParser.extractExportedBinders)).toEqual(contextIndex);
  const macros = { root: { source: { urls: ['https://example.test'], entries: [] } } };
  const context = { contextIndex, accessibleEntryIds: new Set(pool.map(e => e.id)) };
  const expected = Object.fromEntries(pool.map(e => [e.id, computeEntryMetrics(e.content.snl, macros, context)]));
  expect(await readCachedEntryMetrics(root, pool, macros, pool.map(e => e.id)))
    .toEqual({ scope: 'workspace', status: 'ready', entries: expected });
  expect(expected.resolved).toMatchObject({ metrics: { structuralIndex: 1 } });
  expect(expected.wrong).toMatchObject({ metrics: { strongSemanticFreedom: 1 } });
  expect(expected.local).toMatchObject({ metrics: { structuralIndex: 1 } });
});
it('kind/style metadata do not change the old source-only semantics or invalidate disk; drafts stay local', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snl-ssi-')); roots.push(root); await mkdir(join(root, '.SNL_Doc'));
  const pool = [{ id: 'target', kind: 'definition', title: 'First', content: { snl: 'Known' } }];
  const macros = { Known: { kind: 'binder', styles: [], source: { entries: [], urls: ['https://example.test'] } } };
  const saved = await readCachedEntryMetrics(root, pool, macros, ['target']);
  const file = cachePath(root, 'ssi'); const bytes = await readFile(file, 'utf8'); const before = await stat(file);
  const otherPool = pool.map(e => ({ ...e, kind: 'theorem', title: 'Second' }));
  const otherMacros = { Known: { ...macros.Known, kind: 'fvar', styles: [{ body: 'different' }] } };
  expect(await readCachedEntryMetrics(root, otherPool, otherMacros, ['target'])).toEqual(saved);
  expect(Object.fromEntries(computeEntryMetricsForIds(otherPool, ['target'], otherMacros)))
    .toEqual(saved.status === 'ready' ? saved.entries : undefined);
  const draftPool = [{ ...pool[0], content: { snl: 'free' } }];
  expect(computeEntryMetricsForIds(draftPool, ['target'], macros).get('target'))
    .toMatchObject({ metrics: { structuralIndex: 0 } });
  expect(await readFile(file, 'utf8')).toBe(bytes);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
});
it('exports getGlobalSSI for complete saved-workspace consumers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snl-ssi-')); roots.push(root); await mkdir(join(root, '.SNL_Doc'));
  expect(typeof getGlobalSSI).toBe('function');
  expect(await getGlobalSSI(root, poolForGlobal, {})).toEqual(await readCachedEntryMetrics(root, poolForGlobal, {}, poolForGlobal.map(e => e.id)));
});
it('coalesces concurrent subsets, rejects cancelled/unsafe writes locally, and retries cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snl-ssi-')); roots.push(root); await mkdir(join(root, '.SNL_Doc'));
  const [a, b] = await Promise.all([
    readCachedEntryMetrics(root, entries, {}, ['target']), readCachedEntryMetrics(root, entries, {}, ['context'])
  ]);
  expect(a).toMatchObject({ status: 'ready', entries: { target: { metrics: { structuralIndex: 1 } } } });
  expect(b).toMatchObject({ status: 'ready', entries: { context: { metrics: { structuralIndex: 1 } } } });
  expect(await readCachedEntryMetrics(root, entries, {}, ['target'], AbortSignal.abort())).toMatchObject({ status: 'unavailable' });
  expect(await readCachedEntryMetrics(root, entries, {}, ['target'])).toEqual(a);
  await rm(join(root, '.SNL_Doc', '.cache'), { recursive: true });
  await writeFile(join(root, '.SNL_Doc', '.cache'), 'not a directory');
  expect(await readCachedEntryMetrics(root, entries, {}, ['target'])).toMatchObject({ status: 'unavailable' });
});
