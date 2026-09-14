import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cacheFingerprint, cachePath, cacheStatus, clearCache, getOrGenerateCache, readCacheArtifact, writeCache } from './derivedCache';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function workspace() {
  const root = await fs.mkdtemp(join(tmpdir(), 'pub-')); roots.push(root);
  await fs.mkdir(join(root, '.SNL_Doc'));
  return root;
}
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

it('renews live A publication after physical rename in A-B-A without regenerating', async () => {
  const root = await workspace(), visible = deferred(), proceed = deferred();
  const original = fs.rename;
  const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
    await original(from, to); visible.resolve(); await proceed.promise;
  });
  try {
    const ra = request('A', 10), rb = request('B', 20), rejoin = request('A', 99);
    const a = getOrGenerateCache(root, ra);
    await visible.promise;
    // Verify the barrier is after the real atomic effect, not before rename.
    expect(JSON.parse(await fs.readFile(cachePath(root, 'ssi'), 'utf8')).value).toEqual({ value: 10 });
    const b = getOrGenerateCache(root, rb);
    const lateA = getOrGenerateCache(root, rejoin);
    proceed.resolve();
    expect(await Promise.all([a, b, lateA])).toEqual([{ value: 10 }, { value: 20 }, { value: 10 }]);
    expect(ra.generate).toHaveBeenCalledTimes(1); expect(rb.generate).toHaveBeenCalledTimes(1);
    expect(rejoin.generate).not.toHaveBeenCalled();
    // Check final state/disk before any subsequent get can heal a lost artifact.
    expect.soft(cacheStatus(root, 'ssi')).toBe('ready');
    const text = await fs.readFile(cachePath(root, 'ssi'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    expect.soft(text).toBeDefined();
    if (text !== undefined) expect(JSON.parse(text)).toMatchObject({ inputHash: cacheFingerprint(ra.input), value: { value: 10 } });
    const next = request('A', 100);
    expect.soft(await getOrGenerateCache(root, next)).toEqual({ value: 10 });
    expect.soft(next.generate).not.toHaveBeenCalled();
  } finally { proceed.resolve(); rename.mockRestore(); }
});


function holdRenames(count: number) {
  const gates = Array.from({ length: count }, () => ({ visible: deferred(), proceed: deferred() }));
  const original = fs.rename;
  let index = 0;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    const gate = gates[index++];
    await original(from, to);
    if (gate) { gate.visible.resolve(); await gate.proceed.promise; }
  });
  return { gates, spy, release() { for (const gate of gates) gate.proceed.resolve(); } };
}
async function expectArtifact(root: string, entry: string, value: number) {
  expect(cacheStatus(root, 'ssi')).toBe('ready');
  expect(JSON.parse(await fs.readFile(cachePath(root, 'ssi'), 'utf8'))).toMatchObject({
    inputHash: cacheFingerprint({ entry }), value: { value }
  });
  expect(await fs.readdir(join(root, '.SNL_Doc/.cache/ssi'))).toEqual(['result.json']);
}

it('continues through repeated publication renewals without restarting A computation', async () => {
  const root = await workspace(), renames = holdRenames(3);
  try {
    const ra = request('A', 10), rejoin = request('A', 99);
    const a = getOrGenerateCache(root, ra);
    await renames.gates[0].visible.promise;
    const b = getOrGenerateCache(root, request('B', 20));
    const lateA = getOrGenerateCache(root, rejoin);
    renames.gates[0].proceed.resolve();
    await renames.gates[1].visible.promise;
    const c = getOrGenerateCache(root, request('C', 30));
    const latestA = getOrGenerateCache(root, rejoin);
    renames.gates[1].proceed.resolve();
    await renames.gates[2].visible.promise;
    renames.gates[2].proceed.resolve();
    expect(await Promise.all([a, b, lateA, c, latestA])).toEqual([
      { value: 10 }, { value: 20 }, { value: 10 }, { value: 30 }, { value: 10 }
    ]);
    expect(ra.generate).toHaveBeenCalledTimes(1); expect(rejoin.generate).not.toHaveBeenCalled();
    expect(renames.spy).toHaveBeenCalledTimes(3);
    await expectArtifact(root, 'A', 10);
    expect(await getOrGenerateCache(root, rejoin)).toEqual({ value: 10 });
    expect(rejoin.generate).not.toHaveBeenCalled();
  } finally { renames.release(); renames.spy.mockRestore(); }
});

it.each(['first-cancel', 'final-cancel', 'clear', 'new-input'] as const)(
  'preserves ownership when %s interrupts the renewed physical publication', async action => {
    const root = await workspace(), renames = holdRenames(2);
    const bStarted = deferred(), bDone = deferred();
    const first = new AbortController(), last = new AbortController();
    const ra = request('A', 10), rejoin = request('A', 99), rb = request('B', 20);
    let clearing: Promise<void> | undefined;
    try {
      const a = getOrGenerateCache(root, { ...ra, signal: first.signal }).catch(error => error);
      await renames.gates[0].visible.promise;
      const b = getOrGenerateCache(root, { ...rb, generate: async () => {
        bStarted.resolve(); await bDone.promise; return rb.generate();
      } }).catch(error => error);
      const lateA = getOrGenerateCache(root, { ...rejoin, signal: last.signal }).catch(error => error);
      renames.gates[0].proceed.resolve();
      await Promise.all([renames.gates[1].visible.promise, bStarted.promise]);
      // A has physically republished; B remains a live, non-publishing computation.
      let c: Promise<{ value: number }> | undefined;
      if (action === 'clear') clearing = clearCache(root, 'ssi');
      else if (action === 'new-input') c = getOrGenerateCache(root, request('C', 30));
      else {
        first.abort(); expect((await a).name).toBe('AbortError');
        if (action === 'final-cancel') { last.abort(); expect((await lateA).name).toBe('AbortError'); }
      }
      renames.gates[1].proceed.resolve(); bDone.resolve();
      const [aValue, bValue, lateValue] = await Promise.all([a, b, lateA]);
      await clearing;
      // Drains the serialized publication including temporary cleanup; cancelled
      // subscriber promises alone do not establish that underlying I/O has stopped.
      const artifact = await readCacheArtifact(root, ra);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (action === 'clear' || action === 'final-cancel') {
        expect(aValue.name).toBe('AbortError'); expect(lateValue.name).toBe('AbortError');
        if (action === 'clear') expect(bValue.name).toBe('AbortError');
        else expect(bValue).toEqual({ value: 20 });
        expect(artifact).toBeUndefined(); expect(cacheStatus(root, 'ssi')).toBe('missing');
        await expect(fs.stat(cachePath(root, 'ssi'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readdir(join(root, '.SNL_Doc/.cache/ssi'))).toEqual([]);
        expect(renames.spy).toHaveBeenCalledTimes(2);
      } else {
        expect(lateValue).toEqual({ value: 10 }); expect(bValue).toEqual({ value: 20 });
        if (action === 'first-cancel') {
          expect(aValue.name).toBe('AbortError'); await expectArtifact(root, 'A', 10);
          expect(renames.spy).toHaveBeenCalledTimes(2);
        } else {
          expect(aValue).toEqual({ value: 10 }); expect(await c).toEqual({ value: 30 });
          await expectArtifact(root, 'C', 30); expect(renames.spy).toHaveBeenCalledTimes(3);
        }
      }
      expect(ra.generate).toHaveBeenCalledTimes(1); expect(rejoin.generate).not.toHaveBeenCalled();
    } finally { bDone.resolve(); renames.release(); await clearing; renames.spy.mockRestore(); }
  }
);

it('renews after publish selected success but is still awaiting temporary cleanup', async () => {
  const root = await workspace(), cleaning = deferred(), proceed = deferred();
  const original = fs.unlink;
  let paused = false;
  const unlink = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
    if (String(file).endsWith('.tmp') && !paused) {
      paused = true; cleaning.resolve(); await proceed.promise;
    }
    return original(file);
  });
  try {
    const ra = request('A', 10), rejoin = request('A', 99);
    const a = getOrGenerateCache(root, ra);
    await cleaning.promise;
    expect(cacheStatus(root, 'ssi')).toBe('ready');
    const b = getOrGenerateCache(root, request('B', 20));
    const lateA = getOrGenerateCache(root, rejoin);
    proceed.resolve();
    expect(await Promise.all([a, b, lateA])).toEqual([{ value: 10 }, { value: 20 }, { value: 10 }]);
    await expectArtifact(root, 'A', 10);
    expect(ra.generate).toHaveBeenCalledTimes(1); expect(rejoin.generate).not.toHaveBeenCalled();
  } finally { proceed.resolve(); unlink.mockRestore(); }
});

it('does not turn a revoked direct write into a renewable computation', async () => {
  const root = await workspace(), renames = holdRenames(1);
  try {
    const old = writeCache(root, request('A', 10), { value: 10 }).catch(error => error);
    await renames.gates[0].visible.promise;
    const b = getOrGenerateCache(root, request('B', 20));
    renames.release();
    expect((await old).name).toBe('AbortError'); expect(await b).toEqual({ value: 20 });
    await expectArtifact(root, 'B', 20); expect(renames.spy).toHaveBeenCalledTimes(2);
  } finally { renames.release(); renames.spy.mockRestore(); }
});

it.each(['EIO', 'EINVAL'])('handles %s on renewed publication without regenerating or hanging', async code => {
  const root = await workspace(), visible = deferred(), proceed = deferred();
  const original = fs.rename;
  const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
    await original(from, to); visible.resolve(); await proceed.promise;
  }).mockRejectedValueOnce(Object.assign(new Error('renewal failed'), { code }));
  try {
    const ra = request('A', 10), rejoin = request('A', 99);
    const a = getOrGenerateCache(root, ra).catch(error => error);
    await visible.promise;
    const b = getOrGenerateCache(root, request('B', 20));
    const lateA = getOrGenerateCache(root, rejoin).catch(error => error);
    proceed.resolve();
    const [aValue, bValue, lateValue] = await Promise.all([a, b, lateA]);
    expect(bValue).toEqual({ value: 20 });
    if (code === 'EIO') {
      expect(aValue).toEqual({ value: 10 }); expect(lateValue).toEqual({ value: 10 });
    } else {
      expect(aValue).toMatchObject({ message: 'renewal failed', code }); expect(lateValue).toBe(aValue);
    }
    expect(cacheStatus(root, 'ssi')).toBe('failed');
    await expect(fs.stat(cachePath(root, 'ssi'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(join(root, '.SNL_Doc/.cache/ssi'))).toEqual([]);
    expect(ra.generate).toHaveBeenCalledTimes(1); expect(rejoin.generate).not.toHaveBeenCalled();
    expect(rename).toHaveBeenCalledTimes(2);
  } finally { proceed.resolve(); rename.mockRestore(); }
});
