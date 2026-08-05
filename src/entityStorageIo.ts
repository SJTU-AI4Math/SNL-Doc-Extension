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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readDirectory(
  storage: EntityReadStorage,
  directory: string
): Promise<Array<{ path: string; value: unknown }>> {
  const records: Array<{ path: string; value: unknown }> = [];
  for (const file of await storage.listJsonFiles(directory)) {
    const path = `${directory}/${file}`;
    const value = await storage.readJson(path);
    if (value === null) throw new Error(`Entity file disappeared while reading: ${path}.`);
    records.push({ path, value });
  }
  return records;
}

function assertExpectedPath(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`Entity path ${actual} does not match its logical identity path ${expected}.`);
  }
}

export async function readEntryEntityRecords(storage: EntityReadStorage): Promise<EntryEntityRecord[]> {
  const records: EntryEntityRecord[] = [];
  const ids = new Set<string>();
  for (const { path, value } of await readDirectory(storage, 'entries')) {
    if (!isRecord(value) || value.format !== 'snl-entry' ||
        value.version !== ENTRY_STORAGE_VERSION || typeof value.package !== 'string' ||
        !isRecord(value.entry) || typeof value.entry.id !== 'string' || !value.entry.id ||
        value.entry.id !== value.entry.id.trim() || typeof value.entry.package !== 'string') {
      throw new Error(`${path} is not a valid SNL Entry envelope.`);
    }
    if (value.entry.package !== value.package) {
      throw new Error(`${path} Entry package disagrees with its envelope package.`);
    }
    assertExpectedPath(path, entryEntityPath(value.package, value.entry.id));
    if (ids.has(value.entry.id)) throw new Error(`Duplicate Entry identity ${JSON.stringify(value.entry.id)}.`);
    ids.add(value.entry.id);
    records.push({ path, envelope: value as unknown as EntryEnvelope, entry: value.entry as EntryEntityRecord['entry'] });
  }
  return records.sort((left, right) => left.envelope.package.localeCompare(right.envelope.package) || left.entry.id.localeCompare(right.entry.id));
}

export async function readPackageManifestRecords(storage: EntityReadStorage): Promise<PackageManifestRecord[]> {
  const records: PackageManifestRecord[] = [];
  const ids = new Set<string>();
  for (const { path, value } of await readDirectory(storage, 'packages')) {
    if (!isRecord(value) || value.format !== 'snl-package' || value.version !== PACKAGE_STORAGE_VERSION ||
        typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.description !== 'string') {
      throw new Error(`${path} is not a valid SNL Package manifest.`);
    }
    assertExpectedPath(path, packageManifestPath(value.id));
    const folded = value.id.toLowerCase();
    if (ids.has(folded)) throw new Error(`Duplicate Package identity under case-folding: ${value.id}.`);
    ids.add(folded);
    records.push({ path, manifest: value as PackageManifest });
  }
  return records.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

export async function readMacroEntityRecords(storage: EntityReadStorage): Promise<MacroEntityRecord[]> {
  const records: MacroEntityRecord[] = [];
  const ids = new Set<string>();
  for (const { path, value } of await readDirectory(storage, 'macros')) {
    if (!isRecord(value) || value.format !== 'snl-macro' || value.version !== MACRO_STORAGE_VERSION ||
        typeof value.package !== 'string' || !isRecord(value.macro) || typeof value.macro.name !== 'string' ||
        !value.macro.name || value.macro.name !== value.macro.name.trim()) {
      throw new Error(`${path} is not a valid SNL Macro envelope.`);
    }
    assertExpectedPath(path, macroEntityPath(value.package, value.macro.name));
    const identity = `${value.package}\0${value.macro.name}`;
    if (ids.has(identity)) throw new Error(`Duplicate Macro identity ${JSON.stringify(identity)}.`);
    ids.add(identity);
    records.push({ path, envelope: value as unknown as MacroEnvelope, macro: value.macro as MacroEntityRecord['macro'] });
  }
  return records.sort((left, right) => left.envelope.package.localeCompare(right.envelope.package) || left.macro.name.localeCompare(right.macro.name));
}
