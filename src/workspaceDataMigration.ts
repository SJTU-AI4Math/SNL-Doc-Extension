import type { DataMigrationReport } from './dataMigrationCore';
import { CURRENT_DATA_VERSION } from './dataMigrationCore';
import {
  inspectWorkspaceData,
  migrateWorkspaceSnapshot,
  type WorkspaceDataInspection,
  type WorkspaceDataSnapshot,
  type WorkspaceMigrationContext
} from './dataMigrations';

export interface DataMigrationStorage {
  readJson(path: string): Promise<unknown | null>;
  listJsonFiles(directory: string): Promise<string[]>;
  /** Must replace one file atomically from the caller's perspective. */
  writeJsonAtomic(path: string, value: unknown, expectedOriginal?: unknown): Promise<void>;
}

export type CanonicalizeMacroPackage = (file: string, raw: unknown) => unknown;

export async function inspectStoredWorkspaceData(
  storage: DataMigrationStorage
): Promise<WorkspaceDataInspection> {
  try {
    return inspectWorkspaceData(await storage.readJson('config.json'));
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
  return {
    config: config as Record<string, unknown>,
    macroPackages,
    relationships: await storage.readJson('relationships.json')
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
    relationships: structuredClone(source.relationships)
  };
  const report = await migrateWorkspaceSnapshot(source, canonicalizeMacroPackage);

  const writes: Array<{ path: string; value: unknown; original: unknown }> = [];
  for (const [file, value] of [...source.macroPackages].sort(([a], [b]) => a.localeCompare(b))) {
    const original = originals.macroPackages.get(file);
    if (!sameJson(value, original)) {
      writes.push({ path: `term_macros/${file}`, value, original });
    }
  }
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
      await storage.writeJsonAtomic(write.path, write.value, write.original);
      completed.push(write);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const write of completed.reverse()) {
      try {
        await storage.writeJsonAtomic(write.path, write.original, write.value);
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
