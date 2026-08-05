import type { DataMigrationReport } from './dataMigrationCore';
import { assertPackageId, UNPACKAGED_PACKAGE_ID } from './entityStorage';
import {
  readEntryEntityRecords,
  readMacroEntityRecords,
  readPackageManifestRecords
} from './entityStorageIo';
import { CURRENT_DATA_VERSION } from './dataMigrationCore';
import {
  inspectWorkspaceData,
  isEntityStorageReceipt,
  makeEntityStorageReceipt,
  migrateWorkspaceSnapshot,
  type WorkspaceDataInspection,
  type WorkspaceDataSnapshot,
  type WorkspaceMigrationContext
} from './dataMigrations';

export interface DataMigrationStorage {
  readJson(path: string): Promise<unknown | null>;
  listJsonFiles(directory: string): Promise<string[]>;
  /** Optional strict topology probe used for current per-entity workspaces. */
  directoryExists?(directory: string): Promise<boolean>;
  /** Must replace one file atomically from the caller's perspective. */
  writeJsonAtomic(path: string, value: unknown, expectedOriginal?: unknown): Promise<void>;
  /** Delete only when the current JSON still matches the expected value. */
  deleteJsonAtomic(path: string, expectedOriginal: unknown): Promise<void>;
}

export type CanonicalizeMacroPackage = (file: string, raw: unknown) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function inspectStoredWorkspaceData(
  storage: Pick<DataMigrationStorage, 'readJson' | 'listJsonFiles' | 'directoryExists'>
): Promise<WorkspaceDataInspection> {
  try {
    const config = await storage.readJson('config.json');
    const inspection = inspectWorkspaceData(config);
    if (inspection.status === 'current') {
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('Current entity topology requires an object config.');
      }
      if (storage.directoryExists) {
        for (const directory of ['packages', 'entries', 'macros']) {
          if (!(await storage.directoryExists(directory))) {
            throw new Error(`Current entity topology is missing .SNL_Doc/${directory}/.`);
          }
        }
      }
      const activePackages = (config as Record<string, unknown>).active_macro_packages;
      if (
        Object.prototype.hasOwnProperty.call(config, 'active_macro_packages') &&
        (!Array.isArray(activePackages) || !activePackages.every((value) => typeof value === 'string'))
      ) {
        throw new Error('config.json#active_macro_packages must be an array of Package ID strings.');
      }
      if (Array.isArray(activePackages)) {
        const activeByFold = new Map<string, string>();
        for (const packageId of activePackages as string[]) {
          if (packageId !== packageId.trim()) {
            throw new Error('config.json#active_macro_packages contains a whitespace-padded Package ID.');
          }
          assertPackageId(packageId);
          if (packageId === UNPACKAGED_PACKAGE_ID) {
            throw new Error('config.json#active_macro_packages cannot activate the system _unpackaged Package.');
          }
          const folded = packageId.toLowerCase();
          const prior = activeByFold.get(folded);
          if (prior) {
            throw new Error(
              `config.json#active_macro_packages has duplicate or case-fold-colliding Package IDs ${JSON.stringify(prior)} and ${JSON.stringify(packageId)}.`
            );
          }
          activeByFold.set(folded, packageId);
        }
      }
      const entityStorage = (config as Record<string, unknown>).entity_storage;
      if (!isRecord(entityStorage) || entityStorage.version !== 1 ||
          entityStorage.entry_path_version !== 2 ||
          entityStorage.legacy_backup_version !== '0.0.4' ||
          entityStorage.entry_default_package !== '_unpackaged' ||
          !isEntityStorageReceipt(entityStorage.receipt)) {
        throw new Error('Current entity topology is missing config.json#entity_storage v1 / Entry-path v2 metadata and receipt.');
      }
      const legacyEntries = await storage.readJson('entries.json');
      const legacyMacroFiles = await storage.listJsonFiles('term_macros');
      const legacyMacroPackages = new Map<string, unknown>();
      for (const file of legacyMacroFiles) {
        const value = await storage.readJson(`term_macros/${file}`);
        if (value === null) throw new Error(`Legacy Macro backup disappeared: ${file}.`);
        legacyMacroPackages.set(file, value);
      }
      const actualReceipt = makeEntityStorageReceipt(
        legacyEntries,
        legacyMacroPackages,
        legacyEntries !== null || legacyMacroFiles.length > 0
      );
      if (!sameJson(entityStorage.receipt, actualReceipt)) {
        throw new Error('Current entity topology migration receipt does not match the frozen legacy backup.');
      }
      const [packages, entries, macros] = await Promise.all([
        readPackageManifestRecords(storage),
        readEntryEntityRecords(storage),
        readMacroEntityRecords(storage)
      ]);
      const packageIds = new Set(packages.map(({ manifest }) => manifest.id));
      if (!packageIds.has(UNPACKAGED_PACKAGE_ID)) {
        throw new Error('Current entity topology is missing the _unpackaged Package manifest.');
      }
      if (Array.isArray(activePackages)) {
        for (const packageId of activePackages as string[]) {
          if (!packageIds.has(packageId)) {
            throw new Error(`Active Macro Package ${JSON.stringify(packageId)} has no Package manifest.`);
          }
        }
      }
      for (const { envelope } of entries) {
        if (!packageIds.has(envelope.package)) {
          throw new Error(`Entry entity references missing Package ${envelope.package}.`);
        }
      }
      for (const { envelope } of macros) {
        if (!packageIds.has(envelope.package)) {
          throw new Error(`Macro entity references missing Package ${envelope.package}.`);
        }
      }
    }
    return inspection;
  } catch (error) {
    return {
      status: 'invalid',
      currentVersion: null,
      targetVersion: CURRENT_DATA_VERSION,
      message: `Could not read config.json: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
}

async function loadSnapshot(storage: DataMigrationStorage): Promise<WorkspaceDataSnapshot> {
  const config = await storage.readJson('config.json');
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('.SNL_Doc/config.json is missing or is not a JSON object.');
  }
  const macroPackages = new Map<string, unknown>();
  for (const file of await storage.listJsonFiles('term_macros')) {
    const value = await storage.readJson(`term_macros/${file}`);
    if (value === null) {
      throw new Error(`Macro package disappeared while migrating: ${file}`);
    }
    macroPackages.set(file, value);
  }
  const loadEntityDirectory = async (directory: string): Promise<Map<string, unknown>> => {
    const values = new Map<string, unknown>();
    for (const file of await storage.listJsonFiles(directory)) {
      const path = `${directory}/${file}`;
      const value = await storage.readJson(path);
      if (value === null) throw new Error(`Entity file disappeared while migrating: ${path}`);
      values.set(path, value);
    }
    return values;
  };
  return {
    config: config as Record<string, unknown>,
    macroPackages,
    relationships: await storage.readJson('relationships.json'),
    entries: await storage.readJson('entries.json'),
    packageManifests: await loadEntityDirectory('packages') as WorkspaceDataSnapshot['packageManifests'],
    entryEntities: await loadEntityDirectory('entries') as WorkspaceDataSnapshot['entryEntities'],
    macroEntities: await loadEntityDirectory('macros') as WorkspaceDataSnapshot['macroEntities']
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function verifyEntityStorageCommit(
  storage: DataMigrationStorage,
  source: WorkspaceDataSnapshot
): Promise<void> {
  const verifyMap = async (values: Map<string, unknown>): Promise<void> => {
    for (const [path, expected] of values) {
      const actual = await storage.readJson(path);
      if (!sameJson(actual, expected)) {
        throw new Error(`Entity migration verification failed for ${path}.`);
      }
    }
  };
  await verifyMap(source.packageManifests);
  await verifyMap(source.entryEntities);
  await verifyMap(source.macroEntities);
  const [packages, entries, macros] = await Promise.all([
    readPackageManifestRecords(storage),
    readEntryEntityRecords(storage),
    readMacroEntityRecords(storage)
  ]);
  if (packages.length !== source.packageManifests.size ||
      entries.length !== source.entryEntities.size ||
      macros.length !== source.macroEntities.size) {
    throw new Error('Entity migration verification failed: identity counts changed after writing.');
  }
}

async function verifyLegacySourcesUnchanged(
  storage: DataMigrationStorage,
  expected: Pick<WorkspaceDataSnapshot, 'entries' | 'macroPackages' | 'relationships'>
): Promise<void> {
  const currentEntries = await storage.readJson('entries.json');
  if (!sameJson(currentEntries, expected.entries)) {
    throw new Error('Legacy source entries.json changed during migration.');
  }
  const currentFiles = await storage.listJsonFiles('term_macros');
  const expectedFiles = [...expected.macroPackages.keys()].sort((left, right) => left.localeCompare(right));
  if (!sameJson(currentFiles, expectedFiles)) {
    throw new Error('Legacy source term_macros directory listing changed during migration.');
  }
  for (const file of expectedFiles) {
    const current = await storage.readJson(`term_macros/${file}`);
    if (!sameJson(current, expected.macroPackages.get(file))) {
      throw new Error(`Legacy source term_macros/${file} changed during migration.`);
    }
  }
  const currentRelationships = await storage.readJson('relationships.json');
  if (!sameJson(currentRelationships, expected.relationships)) {
    throw new Error('Legacy source relationships.json changed during migration.');
  }
}

export async function migrateStoredWorkspaceData(
  storage: DataMigrationStorage,
  canonicalizeMacroPackage: CanonicalizeMacroPackage
): Promise<DataMigrationReport<WorkspaceMigrationContext>> {
  const inspection = await inspectStoredWorkspaceData(storage);
  if (inspection.status === 'current') {
    return {
      from: inspection.targetVersion,
      to: inspection.targetVersion,
      applied: []
    };
  }
  if (inspection.status !== 'needsMigration') {
    throw new Error(inspection.message);
  }

  const source = await loadSnapshot(storage);
  const originals = {
    config: structuredClone(source.config),
    macroPackages: new Map(
      [...source.macroPackages].map(([file, raw]) => [file, structuredClone(raw)])
    ),
    relationships: structuredClone(source.relationships),
    entries: structuredClone(source.entries),
    packageManifests: new Map(
      [...source.packageManifests].map(([path, value]) => [path, structuredClone(value)])
    ),
    entryEntities: new Map(
      [...source.entryEntities].map(([path, value]) => [path, structuredClone(value)])
    ),
    macroEntities: new Map(
      [...source.macroEntities].map(([path, value]) => [path, structuredClone(value)])
    )
  };
  const report = await migrateWorkspaceSnapshot(source, canonicalizeMacroPackage);

  type MigrationOperation =
    | { kind: 'write'; path: string; value: unknown; original: unknown }
    | { kind: 'delete'; path: string; original: unknown };
  const writes: MigrationOperation[] = [];
  for (const [file, value] of [...source.macroPackages].sort(([a], [b]) => a.localeCompare(b))) {
    const original = originals.macroPackages.get(file);
    if (!sameJson(value, original)) {
      writes.push({ kind: 'write', path: `term_macros/${file}`, value, original });
    }
  }
  const appendEntityWrites = (
    values: Map<string, unknown>,
    originalValues: Map<string, unknown>
  ): void => {
    for (const [path, value] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
      const original = originalValues.get(path) ?? null;
      if (!sameJson(value, original)) writes.push({ kind: 'write', path, value, original });
    }
    for (const [path, original] of [...originalValues].sort(([a], [b]) => a.localeCompare(b))) {
      if (!values.has(path)) writes.push({ kind: 'delete', path, original });
    }
  };
  appendEntityWrites(source.packageManifests, originals.packageManifests);
  appendEntityWrites(source.entryEntities, originals.entryEntities);
  appendEntityWrites(source.macroEntities, originals.macroEntities);
  if (!sameJson(source.relationships, originals.relationships)) {
    writes.push({
      kind: 'write',
      path: 'relationships.json',
      value: source.relationships,
      original: originals.relationships
    });
  }
  // Config carries the committed workspace data version, so it is always the
  // final write. Readers never observe the new version before payloads land.
  if (!sameJson(source.config, originals.config)) {
    writes.push({ kind: 'write', path: 'config.json', value: source.config, original: originals.config });
  }

  const completed: typeof writes = [];
  try {
    for (const write of writes) {
      if (write.path === 'config.json' && source.config.version === CURRENT_DATA_VERSION) {
        await verifyLegacySourcesUnchanged(storage, source);
        await verifyEntityStorageCommit(storage, source);
      }
      if (write.kind === 'delete') {
        await storage.deleteJsonAtomic(write.path, write.original);
      } else {
        await storage.writeJsonAtomic(write.path, write.value, write.original);
      }
      completed.push(write);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const write of completed.reverse()) {
      try {
        if (write.kind === 'delete') {
          await storage.writeJsonAtomic(write.path, write.original, null);
        } else if (write.original === null) {
          await storage.deleteJsonAtomic(write.path, write.value);
        } else {
          await storage.writeJsonAtomic(write.path, write.original, write.value);
        }
      } catch (rollbackError) {
        rollbackErrors.push(
          `${write.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
    }
    const suffix = rollbackErrors.length === 0
      ? 'All completed writes were rolled back.'
      : `Rollback also failed: ${rollbackErrors.join('; ')}`;
    throw new Error(
      `Data migration write failed: ${error instanceof Error ? error.message : String(error)}. ${suffix}`
    );
  }
  return report;
}
