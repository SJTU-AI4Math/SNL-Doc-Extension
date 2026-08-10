import { is_valid_i18n_string } from './localizedContent';
import { assertCanonicalMacroPackage } from './dataMigrations';
import {
  ENTRY_STORAGE_VERSION,
  MACRO_STORAGE_VERSION,
  PACKAGE_STORAGE_VERSION,
  entryEntityPath,
  macroEntityPath,
  packageManifestPath,
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
  envelope: EntryEnvelope;
  entry: Record<string, unknown> & { id: string; package: string };
}

export interface MacroEntityRecord {
  path: string;
  envelope: MacroEnvelope;
  macro: Record<string, unknown> & { name: string };
}

export interface PackageManifestRecord {
  path: string;
  manifest: PackageManifest;
}

/** Parsed entity tree owned by one read operation. No module-level state is retained. */
export interface EntityStorageSnapshot {
  readonly packages: readonly PackageManifestRecord[];
  readonly entries: readonly EntryEntityRecord[];
  readonly macros: readonly MacroEntityRecord[];
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
  if (value.entry.package !== value.package) {
    throw new Error(`${path} Entry package disagrees with its envelope package.`);
  }
  assertCanonicalEntryPayload(path, value.entry);
  assertExpectedPath(path, entryEntityPath(value.package, value.entry.id));
  if (expectedIdentity &&
      (value.package !== expectedIdentity.package || value.entry.id !== expectedIdentity.id)) {
    throw new Error(`${path} Entry identity does not match the requested identity.`);
  }
  return {
    path,
    envelope: value as unknown as EntryEnvelope,
    entry: value.entry as EntryEntityRecord['entry']
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
  assertExpectedPath(path, packageManifestPath(value.id));
  return { path, manifest: value as PackageManifest };
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

export async function readMacroEntityRecords(
  storage: EntityReadStorage,
  schemaVersion: '8' | '9' | '10' | '11' = '11'
): Promise<MacroEntityRecord[]> {
  const records: MacroEntityRecord[] = [];
  const ids = new Set<string>();
  for (const { path, value } of await readDirectory(storage, 'macros')) {
    if (!isRecord(value) || value.format !== 'snl-macro' || value.version !== MACRO_STORAGE_VERSION ||
        typeof value.package !== 'string' || !isRecord(value.macro) || typeof value.macro.name !== 'string' ||
        !value.macro.name || value.macro.name !== value.macro.name.trim()) {
      throw new Error(`${path} is not a valid SNL Macro envelope.`);
    }
    assertExpectedPath(path, macroEntityPath(value.package, value.macro.name));
    assertCanonicalMacroPackage(path, {
      version: schemaVersion,
      name: value.package,
      macros: { [value.macro.name]: value.macro }
    }, schemaVersion);
    const identity = `${value.package}\0${value.macro.name}`;
    if (ids.has(identity)) throw new Error(`Duplicate Macro identity ${JSON.stringify(identity)}.`);
    ids.add(identity);
    records.push({ path, envelope: value as unknown as MacroEnvelope, macro: value.macro as MacroEntityRecord['macro'] });
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
