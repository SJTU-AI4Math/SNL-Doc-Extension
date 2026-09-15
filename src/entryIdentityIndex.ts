import { assertPackageId, UNPACKAGED_PACKAGE_ID } from './entityStorage';
import { usesCurrentEntityStorageDataVersion } from './dataMigrationCore';
import { assertCurrentEntityStorageMetadata, readPackageManifestRecords, EntityStorageValidationError, type PackageManifestRecord } from './entityStorageIo';
import { strictPointReadStorage, type LibraryPointReadProvider, type PointReadOptions, type PointReadReceipt } from './libraryPointReadStorage';

export class StaleEntryIdentityIndexError extends Error {}
export interface EntryIdentitySnapshot {
  readonly root: string;
  readonly epoch: number;
  readonly owners: ReadonlyMap<string, string>;
  readonly packages: ReadonlyMap<string, PackageManifestRecord>;
  readonly activePackages: readonly string[];
  readonly receipts: readonly PointReadReceipt[];
}
/** Metadata-only, process-local index. Caller must invalidate on config or ANY
 * Package manifest create/change/delete/move, including in-flight events. Bind
 * one instance to one root; root switches require a new instance and retirement
 * of the old one. This class does not install a watcher or persist an index. */
export class EntryIdentityIndex {
  private epoch = 0;
  private pending: Promise<EntryIdentitySnapshot> | undefined;
  constructor(readonly root: string, readonly provider: LibraryPointReadProvider, readonly options: PointReadOptions = {}) {}
  invalidate(): void { this.epoch++; this.pending = undefined; }
  assertCurrent(snapshot: EntryIdentitySnapshot): void {
    if (snapshot.root !== this.root || snapshot.epoch !== this.epoch) throw new StaleEntryIdentityIndexError('Entry identity metadata was invalidated.');
  }
  snapshot(): Promise<EntryIdentitySnapshot> {
    if (this.pending) return this.pending;
    const epoch = this.epoch;
    const pending = this.build(epoch);
    this.pending = pending;
    void pending.catch(() => { if (this.pending === pending) this.pending = undefined; });
    return pending;
  }
  private async build(epoch: number): Promise<EntryIdentitySnapshot> {
    const receipts: PointReadReceipt[] = [];
    const storage = strictPointReadStorage(this.provider, this.root, epoch, 'identity-metadata', receipts, this.options);
    const raw = await storage.readJson('config.json');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('version' in raw) ||
        typeof raw.version !== 'string' || !usesCurrentEntityStorageDataVersion(raw.version)) {
      throw new EntityStorageValidationError('Point reads require a supported current entity-storage config version; no aggregate fallback.');
    }
    assertCurrentEntityStorageMetadata(raw);
    const configured = Object.hasOwn(raw, 'active_macro_packages') ? (raw as Record<string, unknown>).active_macro_packages : undefined;
    if (Object.hasOwn(raw, 'active_macro_packages') && (!Array.isArray(configured) || !configured.every(id => typeof id === 'string'))) {
      throw new EntityStorageValidationError('config.json#active_macro_packages must be an array of Package ID strings.');
    }
    if (Array.isArray(configured)) {
      const folded = new Map<string, string>();
      for (const id of configured as string[]) {
        assertPackageId(id);
        const previous = folded.get(id.toLowerCase());
        if (previous !== undefined && previous !== id) {
          throw new EntityStorageValidationError('Active Macro Package identities collide under case-folding.');
        }
        folded.set(id.toLowerCase(), id);
      }
    }
    const packages = new Map<string, PackageManifestRecord>();
    const owners = new Map<string, string>();
    for (const record of await readPackageManifestRecords(storage)) {
      packages.set(record.manifest.id, record);
      for (const id of record.manifest.entry_ids) {
        if (owners.has(id)) throw new EntityStorageValidationError(`Duplicate Entry identity ${JSON.stringify(id)} in Package manifests.`);
        owners.set(id, record.manifest.id);
      }
    }
    const active = configured === undefined ? [...packages.keys()] : configured as string[];
    for (const id of active) {
      assertPackageId(id);
      if (!packages.has(id)) throw new EntityStorageValidationError(`Active Macro Package ${JSON.stringify(id)} has no Package manifest.`);
    }
    const snapshot: EntryIdentitySnapshot = { root: this.root, epoch, owners, packages,
      activePackages: [...new Set(active)].filter(id => id !== UNPACKAGED_PACKAGE_ID).sort((a, b) => `${a}.json`.localeCompare(`${b}.json`)), receipts };
    this.assertCurrent(snapshot);
    return snapshot;
  }
}
