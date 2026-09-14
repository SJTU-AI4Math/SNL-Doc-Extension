import { entryEntityPath, macroEntityPath, packageManifestPath } from './entityStorage';
import { EntryIdentityIndex, type EntryIdentitySnapshot, StaleEntryIdentityIndexError } from './entryIdentityIndex';
import { readEntryEntityRecordWithOwner, readMacroEntityRecord, readPackageManifestRecord, EntityStorageValidationError,
  type EntryEntityRecord, type MacroEntityRecord, type PackageManifestRecord, type EntityReadStorage } from './entityStorageIo';
import { pointReadRevision, strictPointReadStorage, type PointReadReceipt } from './libraryPointReadStorage';

export interface EntryPointResult {
  id: string;
  packageId: string | null;
  path: string | null;
  record: EntryEntityRecord | null;
  missing: 'unindexed' | 'missing-entity' | null;
}
export interface MacroCandidate { packageId: string; path: string; record: MacroEntityRecord | null }
export interface MacroPointResult { name: string; record: MacroEntityRecord | null; candidates: readonly MacroCandidate[] }

/** One body read operation. Bodies/misses are memoized only within this session.
 * A fresh body request must create a new session; caller invalidates the index
 * on metadata changes and retires sessions on dependency-body events. */
export class LibraryPointReadSession {
  readonly receipts: PointReadReceipt[] = [];
  private readonly entries = new Map<string, Promise<EntryPointResult>>();
  private readonly macros = new Map<string, Promise<MacroPointResult>>();
  private readonly owners = new Map<string, Promise<PackageManifestRecord>>();
  private readonly storage: EntityReadStorage;
  constructor(private readonly index: EntryIdentityIndex, readonly identity: EntryIdentitySnapshot) {
    this.storage = strictPointReadStorage(index.provider, index.root, identity.epoch, 'body-point-read', this.receipts, index.options);
  }
  assertCurrent(): void { this.index.assertCurrent(this.identity); }
  private owner(packageId: string): Promise<PackageManifestRecord> {
    let pending = this.owners.get(packageId);
    if (!pending) {
      pending = (async () => {
        const record = await readPackageManifestRecord(this.storage, packageId);
        this.assertCurrent();
        if (!record) throw new EntityStorageValidationError(`Missing owner Package manifest ${JSON.stringify(packageId)}.`);
        const indexed = this.identity.packages.get(packageId);
        if (!indexed || pointReadRevision(indexed.rawManifest) !== pointReadRevision(record.rawManifest)) {
          this.index.invalidate();
          throw new StaleEntryIdentityIndexError(`Package ${JSON.stringify(packageId)} changed since identity indexing.`);
        }
        return record;
      })();
      this.owners.set(packageId, pending);
    }
    return pending;
  }
  async readEntry(id: string): Promise<EntryPointResult> {
    this.assertCurrent();
    if (!id || id !== id.trim() || id.includes('\0')) throw new EntityStorageValidationError('Entry ID must be canonical and non-empty.');
    let pending = this.entries.get(id);
    if (!pending) {
      pending = (async (): Promise<EntryPointResult> => {
        const packageId = this.identity.owners.get(id);
        if (packageId === undefined) return { id, packageId: null, path: null, record: null, missing: 'unindexed' };
        const owner = await this.owner(packageId);
        const path = entryEntityPath(packageId, id);
        const storage: EntityReadStorage = { ...this.storage, readJson: async p => p === packageManifestPath(packageId) ? owner.rawManifest : this.storage.readJson(p) };
        const record = await readEntryEntityRecordWithOwner(storage, packageId, id);
        return { id, packageId, path, record, missing: record ? null : 'missing-entity' };
      })();
      this.entries.set(id, pending);
    }
    const result = await pending; this.assertCurrent(); return result;
  }
  async readMacro(name: string): Promise<MacroPointResult> {
    this.assertCurrent();
    if (!name || name !== name.trim() || name.includes('\0')) throw new EntityStorageValidationError('Macro name must be canonical and non-empty.');
    let pending = this.macros.get(name);
    if (!pending) {
      pending = (async () => {
        const candidates: MacroCandidate[] = [];
        let record: MacroEntityRecord | null = null;
        // Sequential bounded I/O: winner is file-order last, never completion-order.
        for (const packageId of this.identity.activePackages) {
          await this.owner(packageId);
          const candidate = await readMacroEntityRecord(this.storage, packageId, name);
          this.assertCurrent();
          candidates.push({ packageId, path: macroEntityPath(packageId, name), record: candidate });
          if (candidate) record = candidate;
        }
        return { name, record, candidates };
      })();
      this.macros.set(name, pending);
    }
    const result = await pending; this.assertCurrent(); return result;
  }
}
export async function createLibraryPointReadSession(index: EntryIdentityIndex): Promise<LibraryPointReadSession> {
  return new LibraryPointReadSession(index, await index.snapshot());
}
