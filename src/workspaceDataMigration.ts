import type { DataMigrationReport } from './dataMigrationCore';
import { assertPackageId, UNPACKAGED_PACKAGE_ID } from './entityStorage';
import {
  readEntityStorageSnapshot,
  readEntryEntityRecords,
  readMacroEntityRecords,
  readPackageManifestRecords,
  type EntityStorageSnapshot
} from './entityStorageIo';
import { CURRENT_DATA_VERSION } from './dataMigrationCore';
import {
  cloneWorkspaceDataSnapshot,
  inspectWorkspaceData,
  makeEntityStorageReceipt,
  migrateWorkspaceSnapshot,
  type MacroPackageSchemaVersion,
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

export type CanonicalizeMacroPackage = (
  file: string,
  raw: unknown,
  targetVersion: MacroPackageSchemaVersion
) => unknown;

export interface StoredWorkspaceDataReadSnapshot {
  readonly config: unknown | null;
  readonly entities?: EntityStorageSnapshot;
}

/** Capture the parsed data shared by one Dashboard overview and inspection. */
export async function readStoredWorkspaceDataSnapshot(
  storage: Pick<DataMigrationStorage, 'readJson' | 'listJsonFiles'>
): Promise<StoredWorkspaceDataReadSnapshot> {
  const config = await storage.readJson('config.json');
  const versionInspection = inspectWorkspaceData(config);
  if (versionInspection.status !== 'current') return Object.freeze({ config });
  const entities = await readEntityStorageSnapshot(storage);
  return Object.freeze({ config, entities });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function inspectStoredWorkspaceData(
  storage: Pick<DataMigrationStorage, 'readJson' | 'listJsonFiles' | 'directoryExists'>,
  snapshot?: StoredWorkspaceDataReadSnapshot
): Promise<WorkspaceDataInspection> {
  try {
    const config = snapshot ? snapshot.config : await storage.readJson('config.json');
    const inspection = inspectWorkspaceData(config);
    const hasEntityTopology = inspection.status === 'current' ||
      (inspection.status === 'needsMigration' &&
        (inspection.currentVersion === '0.0.6' || inspection.currentVersion === '0.0.7'));
    if (hasEntityTopology) {
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
        for (const packageId of activePackages as string[]) {
          if (packageId !== packageId.trim()) {
            throw new Error('config.json#active_macro_packages contains a whitespace-padded Package ID.');
          }
          assertPackageId(packageId);
          if (packageId === UNPACKAGED_PACKAGE_ID) {
            throw new Error('config.json#active_macro_packages cannot activate the system _unpackaged Package.');
          }
        }
      }
      const entityStorage = (config as Record<string, unknown>).entity_storage;
      if (!isRecord(entityStorage) || entityStorage.version !== 1 ||
          entityStorage.legacy_backup_version !== '0.0.5' ||
          entityStorage.entry_default_package !== '_unpackaged' ||
          !isRecord(entityStorage.receipt)) {
        throw new Error('Current entity topology is missing config.json#entity_storage v1 metadata and receipt.');
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
      const macroSchemaVersion = inspection.currentVersion === '0.0.6'
        ? '8'
        : inspection.currentVersion === '0.0.7' ? '9' : '10';
      const { packages, entries, macros } = snapshot?.entities ??
        await readEntityStorageSnapshot(storage, macroSchemaVersion);
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

function snapshotReadStorage(
  snapshot: WorkspaceDataSnapshot
): Pick<DataMigrationStorage, 'readJson' | 'listJsonFiles' | 'directoryExists'> {
  const entityMaps = [snapshot.packageManifests, snapshot.entryEntities, snapshot.macroEntities];
  return {
    readJson: async (path) => {
      if (path === 'config.json') return snapshot.config;
      if (path === 'entries.json') return snapshot.entries ?? null;
      if (path === 'relationships.json') return snapshot.relationships ?? null;
      if (path.startsWith('term_macros/')) {
        return snapshot.macroPackages.get(path.slice('term_macros/'.length)) ?? null;
      }
      for (const values of entityMaps) {
        if (values.has(path)) return values.get(path) ?? null;
      }
      return null;
    },
    listJsonFiles: async (directory) => {
      if (directory === 'term_macros') return [...snapshot.macroPackages.keys()].sort();
      const values = directory === 'packages'
        ? snapshot.packageManifests
        : directory === 'entries'
          ? snapshot.entryEntities
          : directory === 'macros'
            ? snapshot.macroEntities
            : new Map<string, unknown>();
      const prefix = `${directory}/`;
      return [...values.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length))
        .sort();
    },
    directoryExists: async (directory) =>
      directory === 'packages' || directory === 'entries' || directory === 'macros'
  };
}

async function assertSnapshotTopology(
  snapshot: WorkspaceDataSnapshot,
  expectedVersion: string,
  expectedStatus: 'current' | 'needsMigration'
): Promise<void> {
  const inspection = await inspectStoredWorkspaceData(snapshotReadStorage(snapshot));
  if (inspection.status !== expectedStatus || inspection.currentVersion !== expectedVersion) {
    throw new Error(`Loaded migration snapshot failed topology validation: ${inspection.message}`);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function verifyEntityStorageCommit(
  storage: DataMigrationStorage,
  source: WorkspaceDataSnapshot
): Promise<void> {
  const [packages, entries, macros] = await Promise.all([
    readPackageManifestRecords(storage),
    readEntryEntityRecords(storage),
    readMacroEntityRecords(storage)
  ]);
  const actualMaps = [
    new Map(packages.map((record) => [record.path, record.manifest] as const)),
    new Map(entries.map((record) => [record.path, record.envelope] as const)),
    new Map(macros.map((record) => [record.path, record.envelope] as const))
  ];
  const expectedMaps = [source.packageManifests, source.entryEntities, source.macroEntities];
  for (let index = 0; index < expectedMaps.length; index += 1) {
    const actual = [...actualMaps[index].entries()].sort(([left], [right]) => left.localeCompare(right));
    const expected = [...expectedMaps[index].entries()].sort(([left], [right]) => left.localeCompare(right));
    if (!sameJson(actual, expected)) {
      throw new Error('Entity migration verification failed: exact path/value set changed after writing.');
    }
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
  await assertSnapshotTopology(source, inspection.currentVersion!, 'needsMigration');
  const originals = cloneWorkspaceDataSnapshot(source);
  const report = await migrateWorkspaceSnapshot(source, canonicalizeMacroPackage);
  await assertSnapshotTopology(source, CURRENT_DATA_VERSION, 'current');

  const writes: Array<{ path: string; value: unknown; original: unknown }> = [];
  for (const [file, value] of [...source.macroPackages].sort(([a], [b]) => a.localeCompare(b))) {
    const original = originals.macroPackages.get(file);
    if (!sameJson(value, original)) {
      writes.push({ path: `term_macros/${file}`, value, original });
    }
  }
  const appendEntityWrites = (
    values: Map<string, unknown>,
    originalValues: Map<string, unknown>
  ): void => {
    for (const [path, value] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
      const original = originalValues.get(path) ?? null;
      if (!sameJson(value, original)) writes.push({ path, value, original });
    }
  };
  appendEntityWrites(source.packageManifests, originals.packageManifests);
  appendEntityWrites(source.entryEntities, originals.entryEntities);
  appendEntityWrites(source.macroEntities, originals.macroEntities);
  if (!sameJson(source.relationships, originals.relationships)) {
    writes.push({
      path: 'relationships.json',
      value: source.relationships,
      original: originals.relationships
    });
  }
  // Config carries the committed workspace data version, so it is always the
  // final write. Readers never observe the new version before payloads land.
  if (!sameJson(source.config, originals.config)) {
    writes.push({ path: 'config.json', value: source.config, original: originals.config });
  }

  const completed: typeof writes = [];
  try {
    for (const write of writes) {
      if (write.path === 'config.json' && source.config.version === CURRENT_DATA_VERSION) {
        await verifyLegacySourcesUnchanged(storage, source);
        await verifyEntityStorageCommit(storage, source);
      }
      await storage.writeJsonAtomic(write.path, write.value, write.original);
      completed.push(write);
      if (write.path === 'config.json' && source.config.version === CURRENT_DATA_VERSION) {
        const postCommit = await inspectStoredWorkspaceData(storage);
        if (postCommit.status !== 'current') {
          throw new Error(`Post-commit topology validation failed: ${postCommit.message}`);
        }
        await verifyLegacySourcesUnchanged(storage, source);
        // This exact path/value/count comparison is deliberately the final
        // awaited operation before success, so no weaker self-consistency
        // inspection can open a deterministic seam after it.
        await verifyEntityStorageCommit(storage, source);
      }
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const write of completed.reverse()) {
      try {
        if (write.original === null) {
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
