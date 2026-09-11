import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getOrGenerateCache, cachePath, clearCache, readCacheArtifact, cacheFingerprint, cacheStatus } from './derivedCache';
const roots: string[] = [];
async function workspace() {
  const root = await fs.mkdtemp(join(tmpdir(), 'snl-derived-')); roots.push(root);
  await fs.mkdir(join(root, '.SNL_Doc'));
  await fs.writeFile(join(root, '.SNL_Doc', 'config.json'), '{"version":"fixture"}');
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const valid = (v: unknown): v is { value: number } => typeof v === 'object' && v !== null && Number.isFinite((v as { value: number }).value);
it('reuses a validated persisted result without changing authored bytes, then invalidates by input', async () => {
  const root = await workspace(); const generate = vi.fn(() => ({ value: 3 }));
  const r = { id: 'ssi', version: '1', input: { entry: 'A', snl: 'x' }, validate: valid, generate };
  expect(await getOrGenerateCache(root, r)).toEqual({ value: 3 });
  expect(await getOrGenerateCache(root, r)).toEqual({ value: 3 });
  expect(generate).toHaveBeenCalledTimes(1);
  const disk = JSON.parse(await fs.readFile(join(root, '.SNL_Doc/.cache/ssi/result.json'), 'utf8'));
  expect(disk.value).toEqual({ value: 3 });
  await getOrGenerateCache(root, { ...r, input: { entry: 'A', snl: 'y' } });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(await fs.readFile(join(root, '.SNL_Doc/config.json'), 'utf8')).toBe('{"version":"fixture"}');
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function request(generate = vi.fn(() => ({ value: 3 }))) {
  return { id: 'ssi', version: '1', input: { entry: 'A' }, validate: valid, generate };
}
it('self-ignores generated roots even in a workspace without a parent gitignore', async () => {
  const root = await workspace(); await getOrGenerateCache(root, request());
  expect(await fs.readFile(join(root, '.SNL_Doc/.cache/.gitignore'), 'utf8')).toBe('*\n');
});
it('keeps Library-owned caches under their own folder and clears only one owner', async () => {
  const root = await workspace();
  for (const slug of ['one', 'two']) await fs.mkdir(join(root, '.SNL_Doc/libraries', slug), { recursive: true });
  for (const slug of ['one', 'two']) await getOrGenerateCache(root, { ...request(), id: 'graph-layout', scope: { library: slug } });
  await getOrGenerateCache(root, request());
  await clearCache(root, 'graph-layout', { library: 'one' });
  expect(await readCacheArtifact(root, { ...request(), id: 'graph-layout', scope: { library: 'one' } })).toBeUndefined();
  expect((await readCacheArtifact(root, { ...request(), id: 'graph-layout', scope: { library: 'two' } }))?.value).toEqual({ value: 3 });
  expect((await readCacheArtifact(root, request()))?.value).toEqual({ value: 3 });
});
it('rebuilds corrupt JSON, wrong versions and invalid payloads', async () => {
  const root = await workspace(); const r = request(); await getOrGenerateCache(root, r);
  const file = cachePath(root, r.id); const good = JSON.parse(await fs.readFile(file, 'utf8'));
  const corruptions = ['{', JSON.stringify({ ...good, schema: 9 }), JSON.stringify({ ...good, generator: 'other' }),
    JSON.stringify({ ...good, library: 'other' }), JSON.stringify({ ...good, value: { value: 'bad' } }),
    JSON.stringify({ ...good, value: { value: 4 } })];
  for (const bad of corruptions) { await fs.writeFile(file, bad); expect(await getOrGenerateCache(root, r)).toEqual({ value: 3 }); }
  expect(r.generate).toHaveBeenCalledTimes(1 + corruptions.length);
  await getOrGenerateCache(root, { ...r, version: '2' });
  expect(r.generate).toHaveBeenCalledTimes(2 + corruptions.length);
});
it('coalesces equal inputs without coupling subscriber cancellation', async () => {
  const root = await workspace(); const ready = deferred<void>(); const done = deferred<{ value: number }>();
  const generate = vi.fn(() => { ready.resolve(); return done.promise; });
  const controller = new AbortController();
  const r = { ...request(), generate };
  const first = getOrGenerateCache(root, { ...r, signal: controller.signal });
  const second = getOrGenerateCache(root, r);
  await ready.promise; expect(cacheStatus(root, 'ssi')).toBe('generating');
  controller.abort(); await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  done.resolve({ value: 5 }); expect(await second).toEqual({ value: 5 });
  expect(generate).toHaveBeenCalledTimes(1);
});
it('clearing prevents late publication and permits a fresh same-key task', async () => {
  const root = await workspace(); const ready = deferred<void>(); const done = deferred<{ value: number }>();
  const old = getOrGenerateCache(root, { ...request(), generate: () => { ready.resolve(); return done.promise; } });
  await ready.promise; await clearCache(root, 'ssi');
  expect(cacheStatus(root, 'ssi')).toBe('missing');
  expect(await getOrGenerateCache(root, request(vi.fn(() => ({ value: 8 }))))).toEqual({ value: 8 });
  done.resolve({ value: 2 }); await expect(old).rejects.toMatchObject({ name: 'AbortError' });
  expect((await readCacheArtifact(root, request()))?.value).toEqual({ value: 8 });
});
it('a superseded input cannot overwrite a newer result', async () => {
  const root = await workspace(); const ready = deferred<void>(); const done = deferred<{ value: number }>();
  const old = getOrGenerateCache(root, { ...request(), generate: () => { ready.resolve(); return done.promise; } });
  await ready.promise;
  await getOrGenerateCache(root, { ...request(), input: { entry: 'B' } });
  done.resolve({ value: 2 }); await expect(old).rejects.toMatchObject({ name: 'AbortError' });
  expect((await readCacheArtifact(root, request()))?.inputHash).toBe(cacheFingerprint({ entry: 'B' }));
});
it('fails closed on mutated input or invalid output without publishing', async () => {
  const root = await workspace(); const r = request();
  await expect(getOrGenerateCache(root, { ...r, generate: () => { r.input.entry = 'B'; return { value: 5 }; } })).rejects.toThrow('input changed');
  await expect(getOrGenerateCache(root, { ...request(), generate: () => ({ value: NaN }) })).rejects.toThrow('Invalid generated');
  expect(await readCacheArtifact(root, request())).toBeUndefined();
});
it('does not resurrect deleted disk data from a hidden memory cache', async () => {
  const root = await workspace(); const r = request(); await getOrGenerateCache(root, r);
  await fs.unlink(cachePath(root, r.id)); await getOrGenerateCache(root, r);
  expect(r.generate).toHaveBeenCalledTimes(2);
});
it('rejects path traversal and cache symlinks without touching their targets', async () => {
  const root = await workspace(); const outside = await workspace();
  for (const name of ['../other', '.', 'x/y', 'x\\y', 'C:other', 'NUL']) expect(() => cachePath(root, name)).toThrow();
  expect(() => cachePath(root, 'graph-layout', { library: '../other' })).toThrow();
  await fs.symlink(outside, join(root, '.SNL_Doc/.cache'));
  await expect(getOrGenerateCache(root, request())).rejects.toThrow('Unsafe cache directory');
  await expect(clearCache(root, 'ssi')).rejects.toThrow('Unsafe cache directory');
  expect(await fs.readdir(outside)).toEqual(['.SNL_Doc']);
});
it('uses canonical own keys and preserves prototype-like data without input mutation', async () => {
  const input = JSON.parse('{"__proto__":{"value":1},"constructor":"x"}');
  expect(cacheFingerprint(input)).toBe(cacheFingerprint({ constructor: 'x', ['__proto__']: { value: 1 } }));
  expect(cacheFingerprint({ a: 1, b: 2 })).toBe(cacheFingerprint({ b: 2, a: 1 }));
  expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
  expect(() => cacheFingerprint({ value: Infinity })).toThrow();
});

