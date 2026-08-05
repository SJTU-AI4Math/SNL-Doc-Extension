import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_DATA_MIGRATIONS,
  assertWorkspaceDataWritable,
  assertWorkspaceDataVersionNotRegressed,
  assertJsonSnapshotUnchanged,
  inspectWorkspaceData,
  migrateWorkspaceSnapshot,
  type WorkspaceDataSnapshot
} from './dataMigrations';

const snapshot = (version: string): WorkspaceDataSnapshot => ({
  config: {
    version,
    vendor_extension: { keep: true },
    entry_kinds: [{
      id: 'theorem',
      name: 'Theorem',
      color: '#123456',
      numbering: { pattern: '.1' },
      style: 'box',
      custom: 'preserve'
    }],
    macro_kinds: [{ id: 'rule', name: 'Rule', color: '#abcdef', custom: 7 }]
  },
  macroPackages: new Map([
    ['Logic.json', { version: '6', name: 'Logic', macros: { old: {} }, custom: 'package' }]
  ]),
  relationships: undefined,
  entries: [{ id: 'Set.mem', kind: 'theorem', title: 'Membership' }],
  packageManifests: new Map(),
  entryEntities: new Map(),
  macroEntities: new Map()
});

describe('workspace data migrations', () => {
  it('reports missing, invalid, future, current and migratable workspace states', () => {
    expect(inspectWorkspaceData(null).status).toBe('missing');
    expect(inspectWorkspaceData({}).status).toBe('needsMigration');
    expect(inspectWorkspaceData({ version: 'wat' }).status).toBe('invalid');
    expect(inspectWorkspaceData([]).status).toBe('invalid');
    expect(inspectWorkspaceData('bad').status).toBe('invalid');
    expect(inspectWorkspaceData({ version: '9.0.0' }).status).toBe('future');
    expect(inspectWorkspaceData({ version: '0.0.4' }).status).toBe('needsMigration');
    expect(inspectWorkspaceData({ version: '0.0.5' }).status).toBe('current');
    const old = inspectWorkspaceData({ version: '0.0.1' });
    expect(old.status).toBe('needsMigration');
    expect(old.pending?.map((step) => `${step.from}->${step.to}`)).toEqual([
      '0.0.1->0.0.2',
      '0.0.2->0.0.3',
      '0.0.3->0.0.4',
      '0.0.4->0.0.5'
    ]);
  });

  it('blocks ordinary writes to future, invalid, or missing workspace schemas', () => {
    expect(() => assertWorkspaceDataWritable({ version: '9.0.0' })).toThrow(/newer/);
    expect(() => assertWorkspaceDataWritable({ version: 'wat' })).toThrow(/SemVer/);
    expect(() => assertWorkspaceDataWritable(null)).toThrow(/does not exist/);
    expect(() => assertWorkspaceDataWritable([])).toThrow(/object/);
    expect(() => assertWorkspaceDataWritable('bad')).toThrow(/object/);
    expect(() => assertWorkspaceDataWritable({ version: '0.0.3' })).not.toThrow();
    expect(() => assertWorkspaceDataWritable({ version: '0.0.4' })).not.toThrow();
  });

  it('rejects a stale config write that would undo a completed migration', () => {
    expect(() => assertWorkspaceDataVersionNotRegressed(
      { version: '0.0.4' },
      { version: '0.0.3' }
    )).toThrow(/regress.*0\.0\.4.*0\.0\.3/i);
    expect(() => assertWorkspaceDataVersionNotRegressed(
      { version: '0.0.4' },
      { version: '0.0.4' }
    )).not.toThrow();
  });

  it('rejects same-version stale snapshots before a read-modify-write commit', () => {
    expect(() => assertJsonSnapshotUnchanged(
      { version: '0.0.4', active_macro_packages: ['A'] },
      { version: '0.0.4', active_macro_packages: ['A', 'B'] },
      'config.json'
    )).toThrow(/stale.*config\.json/i);
    expect(() => assertJsonSnapshotUnchanged(
      { version: '0.0.4', active_macro_packages: ['A'] },
      { version: '0.0.4', active_macro_packages: ['A'] },
      'config.json'
    )).not.toThrow();
  });

  it('migrates aggregate Entries and Macros into stable per-entity package storage', async () => {
    const data = snapshot('0.0.4');
    data.macroPackages.set('Logic.json', {
      version: '7', name: 'Logic', description: 'Logic macros', custom: 'package',
      macros: { old: { styles: [], custom: true } }
    });
    const canonicalize = vi.fn((_file: string, raw: unknown) => raw);

    const report = await migrateWorkspaceSnapshot(data, canonicalize);

    expect(report.applied.map((step) => `${step.from}->${step.to}`)).toEqual([
      '0.0.4->0.0.5'
    ]);
    expect(data.config).toMatchObject({
      version: '0.0.5',
      entity_storage: {
        version: 1,
        legacy_backup_version: '0.0.4',
        entry_default_package: '_unpackaged'
      }
    });
    expect([...data.packageManifests]).toEqual([
      ['packages/Logic-277a664e3d2332d369d7.json', {
        format: 'snl-package', version: 1, id: 'Logic', name: 'Logic', description: 'Logic macros',
        custom: 'package'
      }],
      ['packages/_unpackaged-60979c6e210d0e2a20cb.json', {
        format: 'snl-package', version: 1, id: '_unpackaged', name: 'Unpackaged',
        description: 'Legacy Entries without an assigned package.'
      }]
    ]);
    expect([...data.entryEntities]).toEqual([
      ['entries/_unpackaged-a45ab8852b86c1868f0f.json', {
        format: 'snl-entry', version: 1, package: '_unpackaged',
        entry: { id: 'Set.mem', kind: 'theorem', title: 'Membership', package: '_unpackaged' }
      }]
    ]);
    expect([...data.macroEntities]).toEqual([
      ['macros/Logic-315ab0b5e1a20cdc1802.json', {
        format: 'snl-macro', version: 1, package: 'Logic',
        macro: { name: 'old', styles: [], custom: true }
      }]
    ]);
    expect(data.entries).toEqual([{ id: 'Set.mem', kind: 'theorem', title: 'Membership' }]);
    expect(data.macroPackages.has('Logic.json')).toBe(true);
  });

  it('rejects reserved extension fields and non-canonical identities before entity migration', async () => {
    const cases: Array<(data: WorkspaceDataSnapshot) => void> = [
      (data) => { ((data.entries as unknown[])[0] as Record<string, unknown>).package = 'legacy-extension'; },
      (data) => { ((data.entries as unknown[])[0] as Record<string, unknown>).id = ' Set.mem '; },
      (data) => {
        data.macroPackages.set('Logic.json', {
          version: '7', name: 'Logic', format: 'extension-value', macros: { old: { styles: [] } }
        });
      },
      (data) => {
        data.macroPackages.set('Logic.json', {
          version: '7', name: 'Logic', macros: { ' old ': { styles: [] } }
        });
      }
    ];
    for (const mutate of cases) {
      const data = snapshot('0.0.4');
      data.macroPackages.set('Logic.json', {
        version: '7', name: 'Logic', macros: { old: { styles: [] } }
      });
      mutate(data);
      await expect(migrateWorkspaceSnapshot(data, (_file, raw) => raw))
        .rejects.toThrow(/reserved|whitespace/i);
      expect(data.config.version).toBe('0.0.4');
    }
  });

  it('canonicalizes and validates the active Package set before entity migration', async () => {
    const data = snapshot('0.0.4');
    data.config.active_macro_packages = ['Logic.json', 'Logic'];
    data.macroPackages.set('Logic.json', {
      version: '7', name: 'Logic', macros: { old: { styles: [] } }
    });
    await migrateWorkspaceSnapshot(data, (_file, raw) => raw);
    expect(data.config.active_macro_packages).toEqual(['Logic']);

    for (const invalid of [['Missing'], [' bad/name '], 'Logic']) {
      const bad = snapshot('0.0.4');
      bad.config.active_macro_packages = invalid;
      bad.macroPackages.set('Logic.json', {
        version: '7', name: 'Logic', macros: { old: { styles: [] } }
      });
      await expect(migrateWorkspaceSnapshot(bad, (_file, raw) => raw))
        .rejects.toThrow(/active_macro_packages|Package manifest|Package id/i);
      expect(bad.packageManifests.size).toBe(0);
    }

    const reserved = snapshot('0.0.4');
    reserved.config.entity_storage = { vendor: true };
    await expect(migrateWorkspaceSnapshot(reserved, (_file, raw) => raw))
      .rejects.toThrow(/entity_storage.*reserved/i);
    expect(reserved.packageManifests.size).toBe(0);
  });

  it('resumes matching partial entity output but rejects conflicting crash residue', async () => {
    const data = snapshot('0.0.4');
    data.macroPackages.set('Logic.json', {
      version: '7', name: 'Logic', macros: { old: { styles: [] } }
    });
    data.packageManifests.set('packages/_unpackaged-60979c6e210d0e2a20cb.json', {
      format: 'snl-package', version: 1, id: '_unpackaged', name: 'Unpackaged',
      description: 'Legacy Entries without an assigned package.'
    });
    await expect(migrateWorkspaceSnapshot(data, (_file, raw) => raw)).resolves.toMatchObject({
      to: '0.0.5'
    });

    const conflict = snapshot('0.0.4');
    conflict.macroPackages.set('Logic.json', {
      version: '7', name: 'Logic', macros: { old: { styles: [] } }
    });
    conflict.packageManifests.set('packages/_unpackaged-60979c6e210d0e2a20cb.json', {
      format: 'snl-package', version: 1, id: '_unpackaged', name: 'Tampered', description: ''
    });
    await expect(migrateWorkspaceSnapshot(conflict, (_file, raw) => raw))
      .rejects.toThrow(/partial|conflict|residue/i);
    expect(conflict.config.version).toBe('0.0.4');
  });

  it('chains every historical migration and preserves unknown config fields', async () => {
    const data = snapshot('0.0.1');
    const canonicalizeMacroPackage = vi.fn((_file: string, raw: unknown) => ({
      ...(raw as Record<string, unknown>),
      version: '7',
      macros: { old: { styles: [] } }
    }));
    const report = await migrateWorkspaceSnapshot(data, canonicalizeMacroPackage);

    expect(report.applied).toEqual(WORKSPACE_DATA_MIGRATIONS);
    expect(data.config.version).toBe('0.0.5');
    expect(data.config.vendor_extension).toEqual({ keep: true });
    const kind = (data.config.entry_kinds as Array<Record<string, unknown>>)[0];
    expect(kind).toMatchObject({
      id: 'theorem',
      name: 'Theorem',
      coloring: { stroke: '#123456', background: '#123456' },
      defaultCounterName: '',
      style: 'box',
      custom: 'preserve'
    });
    expect(kind).not.toHaveProperty('color');
    expect(kind).not.toHaveProperty('numbering');
    const macroKind = (data.config.macro_kinds as Array<Record<string, unknown>>)[0];
    expect(macroKind).toMatchObject({
      id: 'rule',
      name: 'Rule',
      description: '',
      coloring: { stroke: '#abcdef', background: '#abcdef' },
      custom: 7
    });
    expect(data.macroPackages.get('Logic.json')).toMatchObject({
      version: '7',
      custom: 'package',
      macros: { old: { styles: [] } }
    });
    expect(canonicalizeMacroPackage).toHaveBeenCalledOnce();
  });

  it('rejects malformed catalogs and Macro packages instead of normalizing them to empty', async () => {
    const badCatalog = snapshot('0.0.3');
    badCatalog.config.entry_kinds = 'not-an-array';
    await expect(migrateWorkspaceSnapshot(badCatalog, (_file, raw) => raw))
      .rejects.toThrow(/entry_kinds.*array/);
    expect(badCatalog.config.version).toBe('0.0.3');

    const badPackage = snapshot('0.0.3');
    badPackage.macroPackages.set('Broken.json', {
      version: '6', name: 'Broken', macros: 'not-a-map'
    });
    const canonicalize = vi.fn((_file: string, raw: unknown) => raw);
    await expect(migrateWorkspaceSnapshot(badPackage, canonicalize))
      .rejects.toThrow(/Broken\.json.*macros/);
    expect(badPackage.config.version).toBe('0.0.3');
    expect(canonicalize).not.toHaveBeenCalled();

    const duplicateArray = snapshot('0.0.3');
    duplicateArray.macroPackages.clear();
    duplicateArray.macroPackages.set('Duplicate.json', [
      { name: 'dup', template: 'first' },
      { name: 'dup', template: 'second' }
    ]);
    const duplicateCanonicalize = vi.fn((_file: string, raw: unknown) => raw);
    await expect(migrateWorkspaceSnapshot(duplicateArray, duplicateCanonicalize))
      .rejects.toThrow(/Duplicate\.json.*duplicate.*dup/i);
    expect(duplicateCanonicalize).not.toHaveBeenCalled();
  });

  it('starts from the declared version and never reruns older transforms', async () => {
    const data = snapshot('0.0.3');
    const canonicalize = vi.fn((_file: string, raw: unknown) => ({
      ...(raw as Record<string, unknown>), version: '7'
    }));
    const report = await migrateWorkspaceSnapshot(data, canonicalize);
    expect(report.applied.map((step) => step.from)).toEqual(['0.0.3', '0.0.4']);
    expect(data.config.version).toBe('0.0.5');
  });

  it('keeps the source snapshot untouched when any migration fails', async () => {
    const data = snapshot('0.0.3');
    const original = structuredClone({
      config: data.config,
      macroPackages: [...data.macroPackages]
    });
    await expect(migrateWorkspaceSnapshot(data, () => {
      throw new Error('bad macro');
    })).rejects.toThrow(/bad macro/);
    expect(data.config).toEqual(original.config);
    expect([...data.macroPackages]).toEqual(original.macroPackages);
  });
});
