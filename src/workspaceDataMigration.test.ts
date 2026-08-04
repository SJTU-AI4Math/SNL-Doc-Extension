import { describe, expect, it } from 'vitest';
import {
  inspectStoredWorkspaceData,
  migrateStoredWorkspaceData,
  type DataMigrationStorage
} from './workspaceDataMigration';

class MemoryStorage implements DataMigrationStorage {
  readonly values = new Map<string, unknown>();
  readonly writes: string[] = [];
  failOnceAt: string | null = null;
  beforeWrite: ((path: string) => void) | null = null;

  async readJson(path: string): Promise<unknown | null> {
    return this.values.has(path) ? structuredClone(this.values.get(path)) : null;
  }
  async listJsonFiles(directory: string): Promise<string[]> {
    const prefix = `${directory}/`;
    return [...this.values.keys()]
      .filter((path) => path.startsWith(prefix) && path.endsWith('.json'))
      .map((path) => path.slice(prefix.length))
      .sort();
  }
  async writeJsonAtomic(path: string, value: unknown, expected?: unknown): Promise<void> {
    this.writes.push(path);
    this.beforeWrite?.(path);
    if (expected !== undefined && JSON.stringify(this.values.get(path)) !== JSON.stringify(expected)) {
      throw new Error(`${path} changed during migration`);
    }
    if (this.failOnceAt === path) {
      this.failOnceAt = null;
      throw new Error(`cannot write ${path}`);
    }
    this.values.set(path, structuredClone(value));
  }
}

function legacyStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  storage.values.set('config.json', {
    version: '0.0.3',
    entry_kinds: [{ id: 'theorem', numbering: '.1', color: '#123' }],
    macro_kinds: []
  });
  storage.values.set('term_macros/Logic.json', {
    version: '6', name: 'Logic', macros: { x: { styles: [] } }
  });
  storage.values.set('relationships.json', { version: 1, relationships: [] });
  return storage;
}

describe('stored workspace data migration', () => {
  it('inspects without writing and reports the exact pending chain', async () => {
    const storage = legacyStorage();
    const inspection = await inspectStoredWorkspaceData(storage);
    expect(inspection.status).toBe('needsMigration');
    expect(inspection.currentVersion).toBe('0.0.3');
    expect(inspection.pending?.map((step) => step.to)).toEqual(['0.0.4']);
    expect(storage.writes).toEqual([]);
  });

  it('persists canonical package files first and commits config version last', async () => {
    const storage = legacyStorage();
    const report = await migrateStoredWorkspaceData(
      storage,
      (_file, raw) => ({ ...(raw as Record<string, unknown>), version: '7' })
    );
    expect(report.from).toBe('0.0.3');
    expect(report.to).toBe('0.0.4');
    expect(storage.writes).toEqual(['term_macros/Logic.json', 'config.json']);
    expect((storage.values.get('config.json') as Record<string, unknown>).version).toBe('0.0.4');
    expect((storage.values.get('term_macros/Logic.json') as Record<string, unknown>).version).toBe('7');
  });

  it('rolls every already-written file back if the final config commit fails', async () => {
    const storage = legacyStorage();
    const before = structuredClone([...storage.values]);
    storage.failOnceAt = 'config.json';
    await expect(migrateStoredWorkspaceData(
      storage,
      (_file, raw) => ({ ...(raw as Record<string, unknown>), version: '7' })
    )).rejects.toThrow(/rolled back/);
    expect([...storage.values]).toEqual(before);
    expect(storage.writes).toEqual([
      'term_macros/Logic.json',
      'config.json',
      'term_macros/Logic.json'
    ]);
  });

  it('aborts without overwriting an external edit made during migration', async () => {
    const storage = legacyStorage();
    let injected = false;
    storage.beforeWrite = (path) => {
      if (!injected && path === 'term_macros/Logic.json') {
        injected = true;
        storage.values.set('config.json', {
          ...(storage.values.get('config.json') as Record<string, unknown>),
          collaborator_edit: true
        });
      }
    };
    const originalPackage = structuredClone(storage.values.get('term_macros/Logic.json'));
    await expect(migrateStoredWorkspaceData(
      storage,
      (_file, raw) => ({ ...(raw as Record<string, unknown>), version: '7' })
    )).rejects.toThrow(/changed during migration/);
    expect(storage.values.get('config.json')).toMatchObject({
      version: '0.0.3', collaborator_edit: true
    });
    expect(storage.values.get('term_macros/Logic.json')).toEqual(originalPackage);
  });

  it('does not rewrite a current workspace', async () => {
    const storage = legacyStorage();
    (storage.values.get('config.json') as Record<string, unknown>).version = '0.0.4';
    const report = await migrateStoredWorkspaceData(storage, (_file, raw) => raw);
    expect(report.applied).toEqual([]);
    expect(storage.writes).toEqual([]);
  });
});
