import { describe, expect, it } from 'vitest';
import { entryEntityPath, legacy005EntryEntityPath } from './entityStorage';
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
  afterWrite: ((path: string) => void) | null = null;

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
    const current = this.values.has(path) ? this.values.get(path) : null;
    if (expected !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`${path} changed during migration`);
    }
    if (this.failOnceAt === path) {
      this.failOnceAt = null;
      throw new Error(`cannot write ${path}`);
    }
    this.values.set(path, structuredClone(value));
    this.afterWrite?.(path);
  }
  async deleteJsonAtomic(path: string, expected: unknown): Promise<void> {
    this.writes.push(`delete:${path}`);
    if (JSON.stringify(this.values.get(path)) !== JSON.stringify(expected)) {
      throw new Error(`${path} changed during migration`);
    }
    this.values.delete(path);
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
  storage.values.set('entries.json', [{ id: 'Set.mem', kind: 'theorem', title: 'Membership' }]);
  return storage;
}

describe('stored workspace data migration', () => {
  it('inspects without writing and reports the exact pending chain', async () => {
    const storage = legacyStorage();
    const inspection = await inspectStoredWorkspaceData(storage);
    expect(inspection.status).toBe('needsMigration');
    expect(inspection.currentVersion).toBe('0.0.3');
    expect(inspection.pending?.map((step) => step.to)).toEqual(['0.0.4', '0.0.5', '0.0.6']);
    expect(storage.writes).toEqual([]);
  });

  it('persists canonical package files first and commits config version last', async () => {
    const storage = legacyStorage();
    const report = await migrateStoredWorkspaceData(
      storage,
      (_file, raw) => ({ ...(raw as Record<string, unknown>), version: '7' })
    );
    expect(report.from).toBe('0.0.3');
    expect(report.to).toBe('0.0.6');
    expect(storage.writes).toEqual([
      'term_macros/Logic.json',
      'packages/_unpackaged-60979c6e210d0e2a20cb.json',
      'packages/Logic-277a664e3d2332d369d7.json',
      'entries/dc23c2ae0a0b9459393a.json',
      'macros/Logic-dd2136b29efc47b38142.json',
      'config.json'
    ]);
    expect((storage.values.get('config.json') as Record<string, unknown>).version).toBe('0.0.6');
    expect((storage.values.get('term_macros/Logic.json') as Record<string, unknown>).version).toBe('7');
  });

  it('atomically renames existing 0.0.5 Entry files before committing 0.0.6', async () => {
    const storage = legacyStorage();
    await migrateStoredWorkspaceData(
      storage,
      (_file, raw) => ({ ...(raw as Record<string, unknown>), version: '7' })
    );
    const config = storage.values.get('config.json') as Record<string, unknown>;
    config.version = '0.0.5';
    delete (config.entity_storage as Record<string, unknown>).entry_path_version;
    const newPath = entryEntityPath('Set.mem');
    const oldPath = legacy005EntryEntityPath('_unpackaged', 'Set.mem');
    const envelope = storage.values.get(newPath);
    storage.values.delete(newPath);
    storage.values.set(oldPath, envelope);
    storage.writes.length = 0;

    const report = await migrateStoredWorkspaceData(storage, (_file, raw) => raw);

    expect(report).toMatchObject({ from: '0.0.5', to: '0.0.6' });
    expect(storage.values.has(oldPath)).toBe(false);
    expect(storage.values.get(newPath)).toEqual(envelope);
    expect(storage.writes).toEqual([newPath, `delete:${oldPath}`, 'config.json']);
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
      'packages/_unpackaged-60979c6e210d0e2a20cb.json',
      'packages/Logic-277a664e3d2332d369d7.json',
      'entries/dc23c2ae0a0b9459393a.json',
      'macros/Logic-dd2136b29efc47b38142.json',
      'config.json',
      'delete:macros/Logic-dd2136b29efc47b38142.json',
      'delete:entries/dc23c2ae0a0b9459393a.json',
      'delete:packages/Logic-277a664e3d2332d369d7.json',
      'delete:packages/_unpackaged-60979c6e210d0e2a20cb.json',
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

  it('rejects external edits to unchanged legacy sources before the config commit', async () => {
    for (const target of ['entries', 'macro'] as const) {
      const storage = legacyStorage();
      (storage.values.get('config.json') as Record<string, unknown>).version = '0.0.4';
      (storage.values.get('term_macros/Logic.json') as Record<string, unknown>).version = '7';
      let injected = false;
      storage.afterWrite = (path) => {
        if (injected || !path.startsWith('macros/')) return;
        injected = true;
        if (target === 'entries') {
          storage.values.set('entries.json', [
            ...(storage.values.get('entries.json') as unknown[]),
            { id: 'external', kind: 'theorem', title: 'External' }
          ]);
        } else {
          const pkg = storage.values.get('term_macros/Logic.json') as Record<string, unknown>;
          storage.values.set('term_macros/Logic.json', { ...pkg, external: true });
        }
      };
      await expect(migrateStoredWorkspaceData(storage, (_file, raw) => raw))
        .rejects.toThrow(/legacy source.*changed/i);
      expect((storage.values.get('config.json') as Record<string, unknown>).version).toBe('0.0.4');
    }
  });

  it('re-reads and verifies the entity tree before committing config', async () => {
    const storage = legacyStorage();
    let corrupted = false;
    storage.afterWrite = (path) => {
      if (!corrupted && path.startsWith('macros/')) {
        corrupted = true;
        const entryPath = [...storage.values.keys()].find((candidate) => candidate.startsWith('entries/'))!;
        storage.values.set(entryPath, { corrupt: true });
      }
    };
    await expect(migrateStoredWorkspaceData(
      storage,
      (_file, raw) => ({ ...(raw as Record<string, unknown>), version: '7' })
    )).rejects.toThrow(/verif|changed/i);
    expect((storage.values.get('config.json') as Record<string, unknown>).version).toBe('0.0.3');
  });

  it('reports and then rejects a manually bumped 0.0.5 workspace with no entity topology', async () => {
    const storage = legacyStorage();
    (storage.values.get('config.json') as Record<string, unknown>).version = '0.0.5';
    const inspection = await inspectStoredWorkspaceData(storage);
    expect(inspection.status).toBe('needsMigration');
    await expect(migrateStoredWorkspaceData(storage, (_file, raw) => raw))
      .rejects.toThrow(/entity_storage|Entry path migration/i);
    expect((storage.values.get('config.json') as Record<string, unknown>).version).toBe('0.0.5');
  });

  it('validates the immutable migration receipt against frozen legacy backups', async () => {
    const storage = legacyStorage();
    await migrateStoredWorkspaceData(
      storage,
      (_file, raw) => ({ ...(raw as Record<string, unknown>), version: '7' })
    );
    const config = storage.values.get('config.json') as Record<string, unknown>;
    const entityStorage = config.entity_storage as Record<string, unknown>;
    const receipt = entityStorage.receipt;
    delete entityStorage.receipt;
    expect((await inspectStoredWorkspaceData(storage)).status).toBe('invalid');
    entityStorage.receipt = receipt;
    storage.values.set('entries.json', [
      ...(storage.values.get('entries.json') as unknown[]),
      { id: 'tampered', kind: 'theorem', title: 'Tampered' }
    ]);
    const inspection = await inspectStoredWorkspaceData(storage);
    expect(inspection.status).toBe('invalid');
    expect(inspection.message).toMatch(/receipt|backup/i);
  });

  it('rejects a current workspace with a missing entity directory', async () => {
    const storage = legacyStorage();
    await migrateStoredWorkspaceData(
      storage,
      (_file, raw) => ({ ...(raw as Record<string, unknown>), version: '7' })
    );
    const strictStorage = storage as MemoryStorage & {
      directoryExists(directory: string): Promise<boolean>;
    };
    strictStorage.directoryExists = async (directory) => directory !== 'entries';
    const inspection = await inspectStoredWorkspaceData(strictStorage);
    expect(inspection.status).toBe('invalid');
    expect(inspection.message).toMatch(/missing.*entries/i);
  });

  it('rejects malformed active package configuration in a current workspace', async () => {
    const storage = legacyStorage();
    await migrateStoredWorkspaceData(
      storage,
      (_file, raw) => ({ ...(raw as Record<string, unknown>), version: '7' })
    );
    (storage.values.get('config.json') as Record<string, unknown>).active_macro_packages = 'Logic';
    const inspection = await inspectStoredWorkspaceData(storage);
    expect(inspection.status).toBe('invalid');
    expect(inspection.message).toMatch(/active_macro_packages/i);
  });

  it('rejects non-canonical or missing active Package identities', async () => {
    for (const active of [[' Logic '], ['bad/name'], ['Missing'], ['Logic', 'Logic']]) {
      const storage = legacyStorage();
      await migrateStoredWorkspaceData(
        storage,
        (_file, raw) => ({ ...(raw as Record<string, unknown>), version: '7' })
      );
      (storage.values.get('config.json') as Record<string, unknown>).active_macro_packages = active;
      const inspection = await inspectStoredWorkspaceData(storage);
      expect(inspection.status).toBe('invalid');
      expect(inspection.message).toMatch(/Package|active_macro_packages/i);
    }
  });

  it('detects deletion of an empty frozen entries.json backup', async () => {
    const storage = legacyStorage();
    storage.values.set('entries.json', []);
    await migrateStoredWorkspaceData(
      storage,
      (_file, raw) => ({ ...(raw as Record<string, unknown>), version: '7' })
    );
    storage.values.delete('entries.json');
    const inspection = await inspectStoredWorkspaceData(storage);
    expect(inspection.status).toBe('invalid');
    expect(inspection.message).toMatch(/receipt|backup/i);
  });

  it('does not rewrite a current workspace', async () => {
    const storage = legacyStorage();
    await migrateStoredWorkspaceData(
      storage,
      (_file, raw) => ({ ...(raw as Record<string, unknown>), version: '7' })
    );
    storage.writes.length = 0;
    const report = await migrateStoredWorkspaceData(storage, (_file, raw) => raw);
    expect(report.applied).toEqual([]);
    expect(storage.writes).toEqual([]);
  });
});
