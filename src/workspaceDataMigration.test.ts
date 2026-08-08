import { describe, expect, it } from 'vitest';
import {
  inspectStoredWorkspaceData,
  migrateStoredWorkspaceData,
  type DataMigrationStorage
} from './workspaceDataMigration';

const canonicalize = (_file: string, raw: unknown, version: '7' | '8'): unknown => ({
  ...(raw as Record<string, unknown>),
  version,
  macros: {
    x: {
      description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
      ...(version === '8' ? { default_style: { en: 'default' } } : {}),
      styles: [{ style_name: 'default', mode: 'formula_inline', template: 'x', tags: [] }]
    }
  }
});

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

function macroV8Storage(): MemoryStorage {
  const storage = legacyStorage();
  (storage.values.get('config.json') as Record<string, unknown>).version = '0.0.5';
  storage.values.set(
    'term_macros/Logic.json',
    canonicalize('Logic.json', storage.values.get('term_macros/Logic.json'), '8')
  );
  return storage;
}

describe('stored workspace data migration', () => {
  it('inspects without writing and reports the exact pending chain', async () => {
    const storage = legacyStorage();
    const inspection = await inspectStoredWorkspaceData(storage);
    expect(inspection.status).toBe('needsMigration');
    expect(inspection.currentVersion).toBe('0.0.3');
    expect(inspection.pending?.map((step) => step.to)).toEqual(['0.0.4', '0.0.5', '0.0.6', '0.0.7']);
    expect(storage.writes).toEqual([]);
  });

  it('persists canonical package files first and commits config version last', async () => {
    const storage = legacyStorage();
    const report = await migrateStoredWorkspaceData(
      storage,
      canonicalize
    );
    expect(report.from).toBe('0.0.3');
    expect(report.to).toBe('0.0.7');
    expect(storage.writes).toEqual([
      'term_macros/Logic.json',
      'packages/_unpackaged-60979c6e210d0e2a20cb.json',
      'packages/Logic-277a664e3d2332d369d7.json',
      'entries/_unpackaged-a45ab8852b86c1868f0f.json',
      'macros/Logic-dd2136b29efc47b38142.json',
      'config.json'
    ]);
    expect((storage.values.get('config.json') as Record<string, unknown>).version).toBe('0.0.7');
    expect((storage.values.get('term_macros/Logic.json') as Record<string, unknown>).version).toBe('8');
  });

  it('writes active entity upgrades before config and leaves frozen legacy backups byte-for-byte semantic unchanged', async () => {
    const storage = legacyStorage();
    await migrateStoredWorkspaceData(storage, canonicalize);
    const config = storage.values.get('config.json') as Record<string, unknown>;
    config.version = '0.0.6';
    config.macro_kinds = [{ id: 'partial', vendor: true }];
    const macroPath = [...storage.values.keys()].find((path) => path.startsWith('macros/'))!;
    const macroEnvelope = storage.values.get(macroPath) as Record<string, unknown>;
    macroEnvelope.envelope_extension = 'keep';
    (macroEnvelope.macro as Record<string, unknown>).kind = 'partial';
    const entryPath = [...storage.values.keys()].find((path) => path.startsWith('entries/'))!;
    const entryEnvelope = storage.values.get(entryPath) as Record<string, unknown>;
    (entryEnvelope.entry as Record<string, unknown>).canvasForest = [{
      macro_name: 'x', kind: 'partial', children: [], mdata: { bindRef: 'stale', src: 'ctx' }
    }];
    const frozenEntries = structuredClone(storage.values.get('entries.json'));
    const frozenMacros = structuredClone(storage.values.get('term_macros/Logic.json'));
    storage.writes.length = 0;

    await migrateStoredWorkspaceData(storage, canonicalize);

    expect(storage.writes).toEqual([entryPath, macroPath, 'config.json']);
    expect(storage.values.get('entries.json')).toEqual(frozenEntries);
    expect(storage.values.get('term_macros/Logic.json')).toEqual(frozenMacros);
    expect(storage.values.get(macroPath)).toMatchObject({
      envelope_extension: 'keep', macro: { kind: 'sub' }
    });
    expect(JSON.stringify(storage.values.get(entryPath))).not.toContain('bindRef');
    expect(storage.values.get(entryPath)).toMatchObject({
      entry: { canvasForest: [{ kind: 'sub', mdata: { src: 'ctx' } }] }
    });
    expect((storage.values.get('config.json') as Record<string, unknown>).version).toBe('0.0.7');
  });

  it('rolls every already-written file back if the final config commit fails', async () => {
    const storage = legacyStorage();
    const before = structuredClone([...storage.values]);
    storage.failOnceAt = 'config.json';
    await expect(migrateStoredWorkspaceData(
      storage,
      canonicalize
    )).rejects.toThrow(/rolled back/);
    expect([...storage.values]).toEqual(before);
    expect(storage.writes).toEqual([
      'term_macros/Logic.json',
      'packages/_unpackaged-60979c6e210d0e2a20cb.json',
      'packages/Logic-277a664e3d2332d369d7.json',
      'entries/_unpackaged-a45ab8852b86c1868f0f.json',
      'macros/Logic-dd2136b29efc47b38142.json',
      'config.json',
      'delete:macros/Logic-dd2136b29efc47b38142.json',
      'delete:entries/_unpackaged-a45ab8852b86c1868f0f.json',
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
      canonicalize
    )).rejects.toThrow(/changed during migration/);
    expect(storage.values.get('config.json')).toMatchObject({
      version: '0.0.3', collaborator_edit: true
    });
    expect(storage.values.get('term_macros/Logic.json')).toEqual(originalPackage);
  });

  it('rejects external edits to unchanged legacy sources before the config commit', async () => {
    for (const target of ['entries', 'macro'] as const) {
      const storage = macroV8Storage();
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
      await expect(migrateStoredWorkspaceData(storage, canonicalize))
        .rejects.toThrow(/legacy source.*changed/i);
      expect((storage.values.get('config.json') as Record<string, unknown>).version).toBe('0.0.5');
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
      canonicalize
    )).rejects.toThrow(/verif|changed/i);
    expect((storage.values.get('config.json') as Record<string, unknown>).version).toBe('0.0.3');
  });

  it('rejects a manually bumped 0.0.6 workspace with no entity topology', async () => {
    const storage = legacyStorage();
    (storage.values.get('config.json') as Record<string, unknown>).version = '0.0.6';
    const inspection = await inspectStoredWorkspaceData(storage);
    expect(inspection.status).toBe('invalid');
    expect(inspection.message).toMatch(/entity|package|topology/i);
  });

  it('validates the immutable migration receipt against frozen legacy backups', async () => {
    const storage = legacyStorage();
    await migrateStoredWorkspaceData(
      storage,
      canonicalize
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
      canonicalize
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
      canonicalize
    );
    (storage.values.get('config.json') as Record<string, unknown>).active_macro_packages = 'Logic';
    const inspection = await inspectStoredWorkspaceData(storage);
    expect(inspection.status).toBe('invalid');
    expect(inspection.message).toMatch(/active_macro_packages/i);
  });

  it('rejects non-canonical or missing active Package identities', async () => {
    for (const active of [[' Logic '], ['bad/name'], ['Missing']]) {
      const storage = legacyStorage();
      await migrateStoredWorkspaceData(
        storage,
        canonicalize
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
      canonicalize
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
      canonicalize
    );
    storage.writes.length = 0;
    const report = await migrateStoredWorkspaceData(storage, (_file, raw) => raw);
    expect(report.applied).toEqual([]);
    expect(storage.writes).toEqual([]);
  });
});
