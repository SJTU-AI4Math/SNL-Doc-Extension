import { is_valid_i18n_string } from './localizedContent';
import { assertCanonicalMacroPackage } from './dataMigrations';
import {
  CURRENT_ENTRY_SCHEMA_VERSION,
  CURRENT_MACRO_SCHEMA_VERSION,
  CURRENT_PACKAGE_SCHEMA_VERSION,
  ENTRY_STORAGE_VERSION,
  MACRO_STORAGE_VERSION,
  PACKAGE_STORAGE_VERSION,
  entryEntityPath,
  makeEntryEnvelope,
  makeMacroEnvelope,
  makePackageManifest,
  macroEntityPath,
  packageManifestPath,
  upgradeEntryEnvelopeSchema,
  upgradeMacroEnvelopeSchema,
  upgradePackageManifestSchema,
  type EntryEnvelope,
  type MacroEnvelope,
  type PackageManifest
} from './entityStorage';

export interface EntityReadStorage {
  listJsonFiles(directory: string): Promise<string[]>;
  readJson(path: string): Promise<unknown | null>;
  directoryExists?(directory: string): Promise<boolean>;
}

export interface EntryEntityRecord {
  path: string;
  /** Exact parsed disk value used for stale-write compare-and-swap. */
  rawEnvelope: unknown;
  envelope: EntryEnvelope;
  entry: Record<string, unknown> & { id: string; package: string };
}

export interface MacroEntityRecord {
  path: string;
  /** Exact parsed disk value used for stale-write compare-and-swap. */
  rawEnvelope: unknown;
  envelope: MacroEnvelope;
  macro: Record<string, unknown> & { name: string };
}

export interface PackageManifestRecord {
  path: string;
  /** Exact parsed disk value used for stale-write compare-and-swap. */
  rawManifest: unknown;
  manifest: PackageManifest;
}

/** Parsed entity tree owned by one read operation. No module-level state is retained. */
export interface EntityStorageSnapshot {
  readonly packages: readonly PackageManifestRecord[];
  readonly entries: readonly EntryEntityRecord[];
  readonly macros: readonly MacroEntityRecord[];
}

export interface EntityFileRewrite<T> {
  readonly value: T;
  readonly expected: unknown;
}

/** Whether this file's normalized semantic content changed. Raw legacy bytes
 * are intentionally not compared, otherwise one edit would stamp siblings. */
export function entityFileRewriteChanges<T>(rewrite: EntityFileRewrite<T>, current: T): boolean {
  return JSON.stringify(rewrite.value) !== JSON.stringify(current);
}

export function rewriteEntryEntityRecord<T extends Record<string, unknown>>(
  record: EntryEntityRecord,
  packageId: string,
  entry: T
): EntityFileRewrite<EntryEnvelope<T>> {
  return {
    value: { ...record.envelope, ...makeEntryEnvelope(packageId, entry) },
    expected: record.rawEnvelope
  };
}

export function rewriteMacroEntityRecord<T extends Record<string, unknown>>(
  record: MacroEntityRecord,
  packageId: string,
  macro: T
): EntityFileRewrite<MacroEnvelope<T>> {
  return {
    value: { ...record.envelope, ...makeMacroEnvelope(packageId, macro) },
    expected: record.rawEnvelope
  };
}

export function packageManifestEntryIds(manifest: PackageManifest): readonly string[] | null {
  return Array.isArray(manifest.entry_ids) ? manifest.entry_ids : null;
}

export function rewritePackageManifestRecord(
  record: PackageManifestRecord,
  name: string,
  description: string
): EntityFileRewrite<PackageManifest> {
  const entryIds = packageManifestEntryIds(record.manifest);
  const generated = makePackageManifest(record.manifest.id, name, description, entryIds ?? []);
  if (entryIds === null) delete (generated as Partial<PackageManifest>).entry_ids;
  return {
    value: { ...record.manifest, ...generated },
    expected: record.rawManifest
  };
}

export function rewritePackageEntryMembership(
  record: PackageManifestRecord,
  entryIds: readonly string[]
): EntityFileRewrite<PackageManifest> {
  return {
    value: {
      ...record.manifest,
      ...makePackageManifest(
        record.manifest.id,
        record.manifest.name,
        record.manifest.description,
        entryIds
      )
    },
    expected: record.rawManifest
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const RECEIPT_FIELDS = [
  'legacy_backup_present',
  'legacy_entries_present',
  'entry_count',
  'macro_package_count',
  'macro_count',
  'entries_digest',
  'macro_packages_digest'
] as const;

/** Constant-cost structural gate for the current entity-storage topology. */
export function assertCurrentEntityStorageMetadata(config: unknown): void {
  if (!isRecord(config)) {
    throw new Error('Current entity topology requires an object config.');
  }
  const metadata = config.entity_storage;
  if (!isRecord(metadata)) {
    throw new Error('Current entity topology is missing config.json#entity_storage metadata.');
  }
  const receipt = metadata.receipt;
  const receiptKeys = isRecord(receipt) ? Object.keys(receipt).sort() : [];
  const expectedKeys = [...RECEIPT_FIELDS].sort();
  const validReceipt = isRecord(receipt) &&
    receiptKeys.length === expectedKeys.length &&
    receiptKeys.every((key, index) => key === expectedKeys[index]) &&
    typeof receipt.legacy_backup_present === 'boolean' &&
    typeof receipt.legacy_entries_present === 'boolean' &&
    typeof receipt.entry_count === 'number' && Number.isInteger(receipt.entry_count) && receipt.entry_count >= 0 &&
    typeof receipt.macro_package_count === 'number' && Number.isInteger(receipt.macro_package_count) && receipt.macro_package_count >= 0 &&
    typeof receipt.macro_count === 'number' && Number.isInteger(receipt.macro_count) && receipt.macro_count >= 0 &&
    typeof receipt.entries_digest === 'string' &&
    typeof receipt.macro_packages_digest === 'string';
  if (metadata.version !== 1 || metadata.legacy_backup_version !== '0.0.5' ||
      metadata.entry_default_package !== '_unpackaged' || !validReceipt) {
    throw new Error('Current entity topology is missing config.json#entity_storage v1 metadata and receipt.');
  }
}

const ENTITY_READ_CONCURRENCY = 8;

type ReadOutcome =
  | { ok: true; value: unknown | null }
  | { ok: false; error: unknown };

async function readDirectory(
  storage: EntityReadStorage,
  directory: string
): Promise<Array<{ path: string; value: unknown }>> {
  const files = await storage.listJsonFiles(directory);
  const paths = files.map((file) => `${directory}/${file}`);
  const outcomes = new Array<ReadOutcome>(paths.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < paths.length) {
      const index = nextIndex++;
      try {
        outcomes[index] = { ok: true, value: await storage.readJson(paths[index]) };
      } catch (error) {
        outcomes[index] = { ok: false, error };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(ENTITY_READ_CONCURRENCY, paths.length) }, () => worker())
  );

  return outcomes.map((outcome, index) => {
    if (!outcome.ok) throw outcome.error;
    const path = paths[index];
    if (outcome.value === null) {
      throw new Error(`Entity file disappeared while reading: ${path}.`);
    }
    return { path, value: outcome.value };
  });
}

function assertExpectedPath(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`Entity path ${actual} does not match its logical identity path ${expected}.`);
  }
}

function assertCanonicalEntryPayload(path: string, entry: Record<string, unknown>): void {
  if (typeof entry.kind !== 'string' || !entry.kind ||
      (typeof entry.title !== 'string' && !is_valid_i18n_string(entry.title)) ||
      !isRecord(entry.content) ||
      !Object.hasOwn(entry, 'pointer')) {
    throw new Error(`${path} has an invalid canonical Entry payload.`);
  }
  if (entry.content.snl !== undefined && typeof entry.content.snl !== 'string') {
    throw new Error(`${path}#entry.content.snl must be a string.`);
  }
  for (const field of ['typst', 'latex', 'markdown', 'text'] as const) {
    const value = entry.content[field];
    if (value !== undefined &&
        typeof value !== 'string' && !is_valid_i18n_string(value)) {
      throw new Error(`${path}#entry.content.${field} must be a valid localized string.`);
    }
  }
}

function validateEntryEntity(
  path: string,
  value: unknown,
  expectedIdentity?: { package: string; id: string }
): EntryEntityRecord {
  if (!isRecord(value) || value.format !== 'snl-entry' ||
      value.version !== ENTRY_STORAGE_VERSION || typeof value.package !== 'string' ||
      !isRecord(value.entry) || typeof value.entry.id !== 'string' || !value.entry.id ||
      value.entry.id !== value.entry.id.trim() || typeof value.entry.package !== 'string') {
    throw new Error(`${path} is not a valid SNL Entry envelope.`);
  }
  const envelope = upgradeEntryEnvelopeSchema(value) as unknown as EntryEnvelope<
    Record<string, unknown> & { id: string; package: string }
  >;
  if (envelope.entry.package !== envelope.package) {
    throw new Error(`${path} Entry package disagrees with its envelope package.`);
  }
  assertCanonicalEntryPayload(path, envelope.entry);
  assertExpectedPath(path, entryEntityPath(envelope.package, envelope.entry.id));
  if (expectedIdentity &&
      (envelope.package !== expectedIdentity.package || envelope.entry.id !== expectedIdentity.id)) {
    throw new Error(`${path} Entry identity does not match the requested identity.`);
  }
  return {
    path,
    rawEnvelope: value,
    envelope,
    entry: envelope.entry as EntryEntityRecord['entry']
  };
}

/** Read exactly one current-storage Entry by its stable logical identity. */
export async function readEntryEntityRecord(
  storage: EntityReadStorage,
  packageId: string,
  entryId: string
): Promise<EntryEntityRecord | null> {
  const path = entryEntityPath(packageId, entryId);
  const value = await storage.readJson(path);
  if (value === null) return null;
  return validateEntryEntity(path, value, { package: packageId, id: entryId });
}

export async function readEntryEntityRecords(storage: EntityReadStorage): Promise<EntryEntityRecord[]> {
  const records: EntryEntityRecord[] = [];
  const ids = new Set<string>();
  for (const { path, value } of await readDirectory(storage, 'entries')) {
    const record = validateEntryEntity(path, value);
    if (ids.has(record.entry.id)) throw new Error(`Duplicate Entry identity ${JSON.stringify(record.entry.id)}.`);
    ids.add(record.entry.id);
    records.push(record);
  }
  return records.sort((left, right) => left.envelope.package.localeCompare(right.envelope.package) || left.entry.id.localeCompare(right.entry.id));
}

function validatePackageManifest(path: string, value: unknown): PackageManifestRecord {
  if (!isRecord(value) || value.format !== 'snl-package' || value.version !== PACKAGE_STORAGE_VERSION ||
      typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.description !== 'string') {
    throw new Error(`${path} is not a valid SNL Package manifest.`);
  }
  const manifest = upgradePackageManifestSchema(value) as unknown as PackageManifest;
  if (Object.hasOwn(manifest, 'entry_ids')) {
    if (!Array.isArray(manifest.entry_ids) || manifest.entry_ids.some(
      (entryId) => typeof entryId !== 'string' || !entryId || entryId !== entryId.trim()
    ) || new Set(manifest.entry_ids).size !== manifest.entry_ids.length ||
        manifest.entry_ids.some((entryId, index) => index > 0 && manifest.entry_ids[index - 1].localeCompare(entryId) > 0)) {
      throw new Error(`${path}#entry_ids must be a sorted array of unique, non-empty canonical Entry ids.`);
    }
  }
  assertExpectedPath(path, packageManifestPath(manifest.id));
  return { path, rawManifest: value, manifest };
}

/** Read exactly one Package manifest from its deterministic identity path. */
export async function readPackageManifestRecord(
  storage: EntityReadStorage,
  packageId: string
): Promise<PackageManifestRecord | null> {
  const path = packageManifestPath(packageId);
  const value = await storage.readJson(path);
  if (value === null) return null;
  const record = validatePackageManifest(path, value);
  if (record.manifest.id !== packageId) {
    throw new Error(`${path} Package identity does not match the requested identity.`);
  }
  return record;
}

/**
 * Point-read one Entry and validate its requested owner Package before
 * returning it. A missing Entry remains a normal miss; an orphan Entry is
 * invalid current topology.
 */
export async function readEntryEntityRecordWithOwner(
  storage: EntityReadStorage,
  packageId: string,
  entryId: string
): Promise<EntryEntityRecord | null> {
  const entry = await readEntryEntityRecord(storage, packageId, entryId);
  if (!entry) return null;
  const owner = await readPackageManifestRecord(storage, packageId);
  if (!owner) {
    throw new Error(`Entry ${JSON.stringify(entryId)} references missing Package manifest ${JSON.stringify(packageId)}.`);
  }
  return entry;
}

/** Point-read exactly the Entry identities owned by an indexed Package. */
export async function readIndexedPackageEntryRecords(
  storage: EntityReadStorage,
  packageId: string,
  entryIds: readonly string[]
): Promise<EntryEntityRecord[]> {
  const records = await Promise.all(entryIds.map(async (entryId) => {
    const record = await readEntryEntityRecord(storage, packageId, entryId);
    if (!record) {
      throw new Error(`Package ${JSON.stringify(packageId)} indexes missing Entry ${JSON.stringify(entryId)}.`);
    }
    return record;
  }));
  return records;
}

/**
 * One-time compatibility read for a pre-index manifest. Directory metadata is
 * filtered by the Package's exact deterministic filename shape before any
 * entity is read, so unrelated Entry contents are never scanned.
 */
export async function readUnindexedPackageEntryRecords(
  storage: EntityReadStorage,
  packageId: string
): Promise<EntryEntityRecord[]> {
  const prefix = `${packageId}-`;
  const files = (await storage.listJsonFiles('entries')).filter((file) =>
    file.startsWith(prefix) && /^[0-9a-f]{20}\.json$/.test(file.slice(prefix.length))
  );
  const records: EntryEntityRecord[] = [];
  for (const file of files) {
    const path = `entries/${file}`;
    const value = await storage.readJson(path);
    if (value === null) throw new Error(`Entity file disappeared while reading: ${path}.`);
    const record = validateEntryEntity(path, value);
    if (record.envelope.package !== packageId) {
      throw new Error(`${path} does not belong to Package ${JSON.stringify(packageId)}.`);
    }
    records.push(record);
  }
  return records.sort((left, right) => left.entry.id.localeCompare(right.entry.id));
}

export async function readPackageManifestRecords(storage: EntityReadStorage): Promise<PackageManifestRecord[]> {
  const records: PackageManifestRecord[] = [];
  const ids = new Set<string>();
  for (const { path, value } of await readDirectory(storage, 'packages')) {
    const record = validatePackageManifest(path, value);
    const folded = record.manifest.id.toLowerCase();
    if (ids.has(folded)) throw new Error(`Duplicate Package identity under case-folding: ${record.manifest.id}.`);
    ids.add(folded);
    records.push(record);
  }
  return records.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

function validateMacroEntity(
  path: string,
  value: unknown,
  schemaVersion: '8' | '9' | '10' | '11' = '11'
): MacroEntityRecord {
  if (!isRecord(value) || value.format !== 'snl-macro' || value.version !== MACRO_STORAGE_VERSION ||
      typeof value.package !== 'string' || !isRecord(value.macro) || typeof value.macro.name !== 'string' ||
      !value.macro.name || value.macro.name !== value.macro.name.trim()) {
    throw new Error(`${path} is not a valid SNL Macro envelope.`);
  }
  const declaredSchema = Object.hasOwn(value, 'schema_version');
  const envelope = upgradeMacroEnvelopeSchema(value) as unknown as MacroEnvelope<
    Record<string, unknown> & { name: string }
  >;
  const payloadSchemaVersion = declaredSchema ? '11' : schemaVersion;
  assertExpectedPath(path, macroEntityPath(envelope.package, envelope.macro.name));
  assertCanonicalMacroPackage(path, {
    version: payloadSchemaVersion,
    name: envelope.package,
    macros: { [envelope.macro.name]: envelope.macro }
  }, payloadSchemaVersion);
  return {
    path,
    rawEnvelope: value,
    envelope,
    macro: envelope.macro as MacroEntityRecord['macro']
  };
}

/** Strict output gate for every ordinary split-entity write. Legacy marker
 * absence is accepted only by readers and migration/rollback paths. */
export function assertCurrentEntityFile(path: string, value: unknown): void {
  const assertMarker = (current: number): void => {
    if (!isRecord(value) || value.schema_version !== current) {
      throw new Error(`${path} must carry the current schema_version ${current} before writing.`);
    }
  };
  if (path.startsWith('entries/')) {
    assertMarker(CURRENT_ENTRY_SCHEMA_VERSION);
    validateEntryEntity(path, value);
    return;
  }
  if (path.startsWith('packages/')) {
    assertMarker(CURRENT_PACKAGE_SCHEMA_VERSION);
    validatePackageManifest(path, value);
    return;
  }
  if (path.startsWith('macros/')) {
    assertMarker(CURRENT_MACRO_SCHEMA_VERSION);
    validateMacroEntity(path, value, '11');
    return;
  }
  throw new Error(`${path} is not a managed split-entity path.`);
}

export async function readMacroEntityRecords(
  storage: EntityReadStorage,
  schemaVersion: '8' | '9' | '10' | '11' = '11'
): Promise<MacroEntityRecord[]> {
  const records: MacroEntityRecord[] = [];
  const ids = new Set<string>();
  for (const { path, value } of await readDirectory(storage, 'macros')) {
    const record = validateMacroEntity(path, value, schemaVersion);
    const identity = `${record.envelope.package}\0${record.macro.name}`;
    if (ids.has(identity)) throw new Error(`Duplicate Macro identity ${JSON.stringify(identity)}.`);
    ids.add(identity);
    records.push(record);
  }
  return records.sort((left, right) => left.envelope.package.localeCompare(right.envelope.package) || left.macro.name.localeCompare(right.macro.name));
}

export async function readEntityStorageSnapshot(
  storage: EntityReadStorage,
  macroSchemaVersion: '8' | '9' | '10' | '11' = '11'
): Promise<EntityStorageSnapshot> {
  const [packages, entries, macros] = await Promise.all([
    readPackageManifestRecords(storage),
    readEntryEntityRecords(storage),
    readMacroEntityRecords(storage, macroSchemaVersion)
  ]);
  return Object.freeze({
    packages: Object.freeze(packages),
    entries: Object.freeze(entries),
    macros: Object.freeze(macros)
  });
}
