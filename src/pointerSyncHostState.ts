/** Host-only coordination; persistence/resolution remains in pointerSync. */
type IndexPorts<T> = { build(previous?: T): Promise<T>; publish(index: T): Promise<void> };
export class PointerIndexCoordinator<T> {
  private revision = 0;
  private cleanRevision = -1;
  private index: T | undefined;
  private pending: Promise<T> | undefined;
  private disposed = false;
  constructor(private readonly ports: IndexPorts<T>) {}
  invalidate(): void { this.revision++; }
  dispose(): void { this.disposed = true; this.invalidate(); }
  get generation(): number { return this.revision; }
  ensure(): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Pointer index disposed'));
    if (this.pending) return this.pending;
    if (this.index !== undefined && this.cleanRevision === this.revision) return Promise.resolve(this.index);
    // Install ownership before invoking ports: their code may synchronously reenter.
    let resolve!: (index: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    this.pending = promise;
    void this.rebuild(index => { this.pending = undefined; resolve(index); }).catch(error => { this.pending = undefined; reject(error); });
    return promise;
  }
  private async rebuild(complete: (index: T) => void): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (this.disposed) throw new Error('Pointer index disposed');
      const revision = this.revision;
      const next = await this.ports.build(this.index);
      if (this.disposed) throw new Error('Pointer index disposed');
      if (revision !== this.revision) continue;
      await this.ports.publish(next);
      if (this.disposed) throw new Error('Pointer index disposed');
      if (revision !== this.revision) continue;
      this.index = next;
      this.cleanRevision = revision;
      // Publish the clean state and settle ownership in the same continuation.
      complete(next);
      return;
    }
    throw new Error('Pointer definitions are changing; retry maintenance when edits settle');
  }
}

type Listener = { run(): Promise<void>; report(error: unknown): void };
const listeners = new Map<string, Set<Listener>>();
export function onPointerEntriesWritten(root: string, listener: () => Promise<void>, report: (error: unknown) => void): { dispose(): void } {
  const record: Listener = { run: listener, report };
  const set = listeners.get(root) ?? new Set<Listener>();
  listeners.set(root, set); set.add(record);
  return { dispose() { set.delete(record); if (!set.size && listeners.get(root) === set) listeners.delete(root); } };
}
/** Called only after canonical mutation succeeds. A failed derived index must not lie about that save. */
export async function notifyPointerEntriesWritten(root: string): Promise<void> {
  for (const listener of [...(listeners.get(root) ?? [])]) {
    try { await listener.run(); }
    catch (error) {
      try { listener.report(error); }
      catch (reportError) { console.warn('Pointer index failure reporting failed', reportError); }
    }
  }
}
