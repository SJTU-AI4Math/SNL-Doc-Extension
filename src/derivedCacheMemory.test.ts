import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { getOrGenerateCache, readCache, readCacheArtifact, writeCache, clearCache, cacheStatus } from './derivedCache';
let sequence = 0;
const root = () => ({ uri: `memfs://owner/workspace-${++sequence}` });
const valid = (v: unknown): v is { value: number } => !!v && typeof v === 'object' && Number.isFinite((v as { value: number }).value);
const request = () => ({ id: 'ssi', version: '1', input: { entry: 'A' }, validate: valid, generate: vi.fn(() => ({ value: 3 })) });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => vi.restoreAllMocks());
it('isolates complete URI, Library and generator owners without native I/O; clears only one owner', async () => {
  const a = root(), b = { uri: a.uri.replace('owner', 'other') }, c = { uri: a.uri.replace('memfs:', 'remote:') }, r = request();
  const spies = (['lstat', 'stat', 'mkdir', 'open', 'writeFile', 'readFile', 'rename', 'unlink', 'readdir'] as const).map(m => vi.spyOn(fs, m));
  for (const owner of [a, b, c]) for (const library of ['one', 'two']) await writeCache(owner, { ...r, scope: { library } }, { value: 9 });
  await getOrGenerateCache(a, r);
  await clearCache(a, r.id, { library: 'one' });
  expect(await readCache(a, { ...r, scope: { library: 'one' } })).toBeUndefined();
  expect(await readCache(a, r)).toEqual({ value: 3 });
  for (const owner of [b, c]) expect(await readCache(owner, { ...r, scope: { library: 'one' } })).toEqual({ value: 9 });
  expect(await readCache(a, { ...r, scope: { library: 'two' } })).toEqual({ value: 9 });
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});
it('reuses detached JSON and invalidates inputs, versions and validators', async () => {
  const a = root(), r = request();
  (await getOrGenerateCache(a, r)).value = 99;
  expect(await getOrGenerateCache({ ...a }, r)).toEqual({ value: 3 });
  expect(r.generate).toHaveBeenCalledTimes(1);
  await getOrGenerateCache(a, { ...r, version: '2' });
  await getOrGenerateCache(a, { ...r, input: { entry: 'B' } });
  expect(r.generate).toHaveBeenCalledTimes(3);
  expect(await readCacheArtifact(a, { ...r, validate: (_): _ is { value: number } => false })).toBeUndefined();
});
it('coalesces identical inputs while cancelling only one subscriber', async () => {
  const a = root(), r = request(), ready = deferred<void>(), done = deferred<{ value: number }>();
  const generate = vi.fn(() => { ready.resolve(); return done.promise; }), controller = new AbortController();
  const first = getOrGenerateCache(a, { ...r, generate, signal: controller.signal }).catch(e => e);
  const second = getOrGenerateCache({ ...a }, { ...r, generate });
  await ready.promise; controller.abort(); expect((await first).name).toBe('AbortError');
  done.resolve({ value: 7 }); expect(await second).toEqual({ value: 7 }); expect(generate).toHaveBeenCalledTimes(1);
});
it.each(['clear', 'cancel', 'new-input'] as const)('revokes late publication on %s and allows fresh same-key work', async action => {
  const a = root(), r = request(), ready = deferred<void>(), done = deferred<{ value: number }>(), controller = new AbortController();
  const old = getOrGenerateCache(a, { ...r, signal: controller.signal, generate: () => { ready.resolve(); return done.promise; } }).catch(e => e);
  await ready.promise;
  if (action === 'clear') await clearCache(a, r.id);
  else if (action === 'cancel') controller.abort();
  else await getOrGenerateCache(a, { ...r, input: { entry: 'B' } });
  await writeCache(a, r, { value: 8 });
  done.resolve({ value: 2 }); expect((await old).name).toBe('AbortError');
  expect(await readCache(a, r)).toEqual({ value: 8 }); expect(cacheStatus(a, r.id)).toBe('ready');
});
it('rejects bad values and mutated input without publication', async () => {
  const a = root(), r = request();
  await expect(getOrGenerateCache(a, { ...r, generate: () => ({ value: NaN }) })).rejects.toThrow('Invalid generated');
  await expect(getOrGenerateCache(a, { ...r, generate: () => { r.input.entry = 'B'; return { value: 3 }; } })).rejects.toThrow('input changed');
  await expect(writeCache(a, r, { value: Infinity })).rejects.toThrow('Invalid generated');
  expect(await readCacheArtifact(a, r)).toBeUndefined();
  expect(cacheStatus(a, r.id)).toBe('failed');
  await clearCache(a, r.id); expect(cacheStatus(a, r.id)).toBe('missing');
});
it('starts fresh A after A-B-A instead of joining a retired job', async () => {
  const owner = root(), r = request(), a = deferred<number>(), b = deferred<number>();
  const startedA = deferred<void>(), startedB = deferred<void>();
  const oldA = getOrGenerateCache(owner, { ...r, generate: async () => { startedA.resolve(); return { value: await a.promise }; } }).catch(e => e);
  await startedA.promise;
  const oldB = getOrGenerateCache(owner, { ...r, input: { entry: 'B' }, generate: async () => { startedB.resolve(); return { value: await b.promise }; } }).catch(e => e);
  await startedB.promise;
  const generate = vi.fn(() => ({ value: 30 }));
  const current = getOrGenerateCache(owner, { ...r, generate });
  b.resolve(20); a.resolve(10);
  expect(await current).toEqual({ value: 30 }); expect(generate).toHaveBeenCalledTimes(1);
  expect((await oldA).name).toBe('AbortError'); expect((await oldB).name).toBe('AbortError');
  expect(await readCache(owner, r)).toEqual({ value: 30 });
});
it('bounds aggregate envelope bytes independently of entry count', async () => {
  const owner = root(), r = { id: 'large', version: '1', input: null, validate: (v: unknown): v is string => typeof v === 'string' };
  const text = 'x'.repeat(3 * 1024 * 1024);
  await writeCache(owner, r, text);
  for (let i = 0; i < 22; ++i) await writeCache(root(), r, text);
  expect(await readCache(owner, r)).toBeUndefined();
});
it('bounds retained memory artifacts and regenerates evicted owners', async () => {
  const first = root(), r = request(); await getOrGenerateCache(first, r);
  for (let i = 0; i < 256; ++i) await getOrGenerateCache(root(), request());
  expect(await readCache(first, r)).toBeUndefined();
  expect(cacheStatus(first, r.id)).toBe('missing');
  await getOrGenerateCache(first, r); expect(r.generate).toHaveBeenCalledTimes(2);
});
