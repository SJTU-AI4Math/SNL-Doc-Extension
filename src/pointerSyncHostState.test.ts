import { describe, expect, it } from 'vitest';
import { PointerIndexCoordinator, onPointerEntriesWritten, notifyPointerEntriesWritten } from './pointerSyncHostState';

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe('PointerIndexCoordinator', () => {
  it.each([0, 1, 2, 3, 4, 5])('does not lose invalidation after %i settlement microtasks', async ticks => {
    let builds = 0;
    const state = new PointerIndexCoordinator({ build: async () => ++builds, publish: async () => {} });
    const first = state.ensure();
    for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
    state.invalidate();
    const refreshed = state.ensure();
    await first;
    expect(await refreshed).toBe(2);
    expect(builds).toBe(2);
  });
  it('coalesces warm queries and rebuilds after a definition notification', async () => {
    let builds = 0;
    const writes: number[] = [];
    const state = new PointerIndexCoordinator({ build: async () => ++builds, publish: async n => { writes.push(n); } });
    expect(await Promise.all([state.ensure(), state.ensure()])).toEqual([1, 1]);
    expect(await state.ensure()).toBe(1);
    state.invalidate();
    expect(await state.ensure()).toBe(2);
    expect(writes).toEqual([1, 2]);
  });
  it('does not publish a result superseded during its build', async () => {
    const first = deferred<number>(); let calls = 0; const writes: number[] = [];
    const state = new PointerIndexCoordinator({ build: async () => ++calls === 1 ? first.promise : 2, publish: async n => { writes.push(n); } });
    const result = state.ensure();
    state.invalidate(); first.resolve(1);
    expect(await result).toBe(2); expect(writes).toEqual([2]);
  });
  it('publication failures keep the cache dirty and allow explicit retry', async () => {
    let failure = true;
    const state = new PointerIndexCoordinator({ build: async () => 1, publish: async () => { if (failure) throw Error('disk full'); } });
    await expect(state.ensure()).rejects.toThrow('disk full');
    failure = false; expect(await state.ensure()).toBe(1);
  });
  it('a stale publish completion is followed by the latest revision', async () => {
    const published = deferred<void>(); let calls = 0; const writes: number[] = [];
    const state = new PointerIndexCoordinator({ build: async () => ++calls, publish: async n => { writes.push(n); if (n === 1) await published.promise; } });
    const promise = state.ensure(); await Promise.resolve(); await Promise.resolve();
    state.invalidate(); published.resolve();
    expect(await promise).toBe(2); expect(writes).toEqual([1, 2]);
  });
  it('no listener means canonical writes need no index subsystem', async () => {
    await expect(notifyPointerEntriesWritten('unregistered')).resolves.toBeUndefined();
  });
  it('write notification is root-scoped, awaited and errors do not undo canonical data', async () => {
    let hits = 0; const errors: string[] = [];
    const dispose = onPointerEntriesWritten('root', async () => { hits++; throw Error('index failure'); }, e => errors.push(String(e)));
    await notifyPointerEntriesWritten('other'); expect(hits).toBe(0);
    await notifyPointerEntriesWritten('root'); expect(hits).toBe(1); expect(errors[0]).toContain('index failure');
    dispose.dispose(); await notifyPointerEntriesWritten('root'); expect(hits).toBe(1);
  });
});
