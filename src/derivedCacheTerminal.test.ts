import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cacheFingerprint, cachePath, cacheStatus, getOrGenerateCache, writeCache } from './derivedCache';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const validate = (value: unknown): value is { value: number } =>
  typeof value === 'object' && value !== null && Number.isFinite((value as { value: number }).value);
function request(entry: string, value: number) {
  return { id: 'ssi', version: '1', input: { entry }, validate, generate: vi.fn(() => ({ value })) };
}
// Transparent observer: invokes the registered cleanup at its native reaction
// position and returns its exact value, without adding a Promise or an await.
function observeOuterFinally(events: string[], admit: () => Promise<{ value: number }>) {
  const nativeFinally = Promise.prototype.finally;
  const spy = vi.spyOn(Promise.prototype, 'finally').mockImplementationOnce(function (this: Promise<unknown>, callback) {
    return nativeFinally.call(this, () => { events.push('outer-finally-A'); return callback?.(); });
  });
  try { return admit(); } finally { spy.mockRestore(); }
}
async function workspace() {
  const root = await fs.mkdtemp(join(tmpdir(), 'term-')); roots.push(root);
  await fs.mkdir(join(root, '.SNL_Doc'));
  return root;
}

it('admits late A after the terminal output clone but before outer finally with a real publisher', async () => {
  const root = await workspace(), visible = deferred(), proceed = deferred(), bDone = deferred();
  const events: string[] = [];
  const ra = request('A', 10), rb = request('B', 20), rejoin = request('A', 10);
  const output = { value: 10 };
  let lateA!: Promise<{ value: number }>;
  const originalRename = fs.rename;
  vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
    await originalRename(from, to); events.push('physical-rename-A'); visible.resolve(); await proceed.promise;
  });
  // A transparent native JSON seam: return the exact native string and only
  // queue a normal API request. No getters/thenables, awaits or authority edits.
  const stringify = JSON.stringify;
  vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
    const text = stringify(...args);
    if (args[0] === output) {
      events.push('terminal-output-clone');
      queueMicrotask(() => {
        events.push('late-A-microtask'); lateA = getOrGenerateCache(root, rejoin);
      });
    }
    return text;
  });
  // Observe (not reschedule) the actual outer finally registered synchronously
  // by this one admission; publication finally registrations happen later.
  const a = observeOuterFinally(events, () => getOrGenerateCache(root, { ...ra, generate: () => { ra.generate(); return output; } }));
  let b: Promise<{ value: number }> | undefined;
  try {
    await visible.promise;
    expect(JSON.parse(await fs.readFile(cachePath(root, 'ssi'), 'utf8')).value).toEqual(output);
    events.push('admit-B');
    b = getOrGenerateCache(root, { ...rb, generate: async () => { await bDone.promise; return rb.generate(); } });
    proceed.resolve();
    expect(await a).toEqual(output);
    expect(events).toEqual(['physical-rename-A', 'admit-B', 'terminal-output-clone', 'late-A-microtask', 'outer-finally-A']);
    bDone.resolve();
    expect(await Promise.all([b, lateA])).toEqual([{ value: 20 }, output]);
    const text = await fs.readFile(cachePath(root, 'ssi'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return undefined; throw error;
    });
    console.log('terminal-schedule', { events, status: cacheStatus(root, 'ssi'), artifact: text ? JSON.parse(text) : 'ENOENT',
      aCalls: ra.generate.mock.calls.length, bCalls: rb.generate.mock.calls.length, lateCalls: rejoin.generate.mock.calls.length });
    // These must precede any healing get. A fresh terminal successor is allowed
    // to compute; it must not just renew a promise with no continuation left.
    expect.soft(cacheStatus(root, 'ssi')).toBe('ready');
    expect.soft(text).toBeDefined();
    if (text) expect(JSON.parse(text)).toMatchObject({ inputHash: cacheFingerprint(ra.input), value: output });
    const next = request('A', 100);
    expect.soft(await getOrGenerateCache(root, next)).toEqual(output);
    expect.soft(next.generate).not.toHaveBeenCalled();
    expect(ra.generate).toHaveBeenCalledTimes(1); expect(rb.generate).toHaveBeenCalledTimes(1);
  } finally { proceed.resolve(); bDone.resolve(); await Promise.allSettled([a, b, lateA]); }
});


it('retires cache-hit renewal and old finally cannot erase its fresh pending successor', async () => {
  const root = await workspace(), opened = deferred(), proceed = deferred(), bDone = deferred();
  const ra = request('A', 10), rejoin = request('A', 10), newest = request('A', 10), rb = request('B', 20);
  await writeCache(root, ra, { value: 10 });
  const events: string[] = [];
  let lateA!: Promise<{ value: number }>, b!: Promise<{ value: number }>;
  let inputClones = 0, reads = 0;
  const stringify = JSON.stringify;
  vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
    const text = stringify(...args);
    // Canonical input cloning happens at admission, read freshness, and the
    // inner post-lookup guard. The third is synchronous with the cache-hit
    // return; a queued request cannot preempt that guard-to-return stack.
    if (text === '{"entry":"A"}' && ++inputClones === 3) {
      events.push('terminal-hit-input-clone');
      queueMicrotask(() => {
        events.push('late-BA-microtask');
        b = getOrGenerateCache(root, { ...rb, generate: async () => { await bDone.promise; return rb.generate(); } });
        lateA = getOrGenerateCache(root, rejoin);
      });
    }
    return text;
  });
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === cachePath(root, 'ssi') && ++reads >= 2) {
      events.push('successor-native-open');
      // B and fresh A may reach native I/O in either order. Hold both and
      // signal only once both actually opened (baseline has only B's read).
      if (reads === 3) opened.resolve();
      await proceed.promise;
    }
    return handle;
  });
  const a = observeOuterFinally(events, () => getOrGenerateCache(root, ra));
  let newestA: Promise<{ value: number }> | undefined;
  try {
    expect(await a).toEqual({ value: 10 });
    expect(events.slice(0, 3)).toEqual(['terminal-hit-input-clone', 'late-BA-microtask', 'outer-finally-A']);
    // Fail promptly on the old implementation's already-resolved lateA rather
    // than waiting for an open that cannot happen. No internal maps inspected.
    const successorReading = await Promise.race([opened.promise.then(() => true), lateA.then(() => false)]);
    console.log('terminal-hit-schedule', { events, reads, successorReading });
    expect(successorReading).toBe(true);
    // Old outer cleanup has definitely run. Its replacement is held on real
    // native I/O. A further A must coalesce into that still-active replacement.
    newestA = getOrGenerateCache(root, newest);
    proceed.resolve(); bDone.resolve();
    expect(await Promise.all([lateA, newestA, b])).toEqual([{ value: 10 }, { value: 10 }, { value: 20 }]);
    expect(reads).toBe(3); // first A, fresh A, independent B; no fourth A lookup
    expect(ra.generate).not.toHaveBeenCalled(); expect(rejoin.generate).not.toHaveBeenCalled();
    expect(newest.generate).not.toHaveBeenCalled(); expect(rb.generate).toHaveBeenCalledTimes(1);
    expect(cacheStatus(root, 'ssi')).toBe('ready');
    expect(JSON.parse(await fs.readFile(cachePath(root, 'ssi'), 'utf8'))).toMatchObject({
      inputHash: cacheFingerprint(ra.input), value: { value: 10 }
    });
  } finally { proceed.resolve(); bDone.resolve(); await Promise.allSettled([a, lateA, newestA, b]); }
});

it('retires a synchronously throwing generator before outer rejection cleanup', async () => {
  const root = await workspace(), events: string[] = [], rejoin = request('A', 10);
  const failure = new Error('generator failed');
  let lateA!: Promise<{ value: number } | Error>;
  const a = observeOuterFinally(events, () => getOrGenerateCache(root, { ...request('A', 10), generate() {
    events.push('generator-throw');
    queueMicrotask(() => {
      events.push('late-A-microtask');
      lateA = getOrGenerateCache(root, rejoin).catch(error => error as Error);
    });
    throw failure;
  } })).catch(error => error as Error);
  expect(await a).toBe(failure);
  expect(events).toEqual(['generator-throw', 'late-A-microtask', 'outer-finally-A']);
  const result = await lateA;
  console.log('terminal-error-schedule', { events, result, lateCalls: rejoin.generate.mock.calls.length });
  expect(result).toEqual({ value: 10 });
  expect(rejoin.generate).toHaveBeenCalledTimes(1);
  expect(cacheStatus(root, 'ssi')).toBe('ready');
  expect(JSON.parse(await fs.readFile(cachePath(root, 'ssi'), 'utf8'))).toMatchObject({
    inputHash: cacheFingerprint(rejoin.input), value: { value: 10 }
  });
});
