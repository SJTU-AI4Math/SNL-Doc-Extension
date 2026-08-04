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

const canonicalEntry = (version: '7' | '8'): Record<string, unknown> => ({
  description: '',
  source: { entries: [], urls: [] },
  dynamic_arity: false,
  tags: [],
  ...(version === '8' ? { default_style: { en: 'default' } } : {}),
  styles: [{ style_name: 'default', mode: 'formula_inline', template: 'old', tags: [] }]
});

const canonicalize = (_file: string, raw: unknown, version: '7' | '8'): unknown => ({
  ...(raw as Record<string, unknown>),
  version,
  macros: { old: canonicalEntry(version) }
});

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
  relationships: undefined
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

  it('chains every historical migration and preserves unknown config fields', async () => {
    const data = snapshot('0.0.1');
    const canonicalizeMacroPackage = vi.fn(canonicalize);
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
      version: '8',
      custom: 'package',
      macros: { old: { default_style: { en: 'default' } } }
    });
    expect(canonicalizeMacroPackage).toHaveBeenCalledTimes(2);
    expect(canonicalizeMacroPackage.mock.calls.map((call) => call[2])).toEqual(['7', '8']);
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

  it('validates both v7 input and v8 canonical output before committing 0.0.5', async () => {
    const malformedV7 = snapshot('0.0.4');
    malformedV7.macroPackages.set('Logic.json', {
      version: '7', name: 'Logic', macros: {
        old: { ...canonicalEntry('7'), styles: [] }
      }
    });
    const inputCanonicalize = vi.fn(canonicalize);
    await expect(migrateWorkspaceSnapshot(malformedV7, inputCanonicalize))
      .rejects.toThrow(/styles must be non-empty/);
    expect(inputCanonicalize).not.toHaveBeenCalled();
    expect(malformedV7.config.version).toBe('0.0.4');

    const invalidOutput = snapshot('0.0.4');
    invalidOutput.macroPackages.set('Logic.json', {
      version: '7', name: 'Logic', macros: { old: canonicalEntry('7') }
    });
    await expect(migrateWorkspaceSnapshot(invalidOutput, (_file, raw) => ({
      ...(raw as Record<string, unknown>), version: '8',
      macros: { old: { ...canonicalEntry('7') } }
    }))).rejects.toThrow(/default_style must be an object/);
    expect(invalidOutput.config.version).toBe('0.0.4');
  });

  it('checks identities per record in mixed legacy/current Macro packages', async () => {
    const data = snapshot('0.0.3');
    data.macroPackages.set('Mixed.json', {
      version: '6', name: 'Mixed', macros: {
        'Legacy.infix': { name: 'Legacy.infix', katex_react: { mode: 'formula' } },
        WrongKey: { name: 'Different', styles: [] }
      }
    });
    const mixedCanonicalize = vi.fn((file: string, raw: unknown, version: '7' | '8') => {
      if (file === 'Logic.json') return canonicalize(file, raw, version);
      return {
        ...(raw as Record<string, unknown>),
        version,
        macros: version === '7'
          ? { Legacy: canonicalEntry('7'), Different: canonicalEntry('7') }
          : { Legacy: canonicalEntry('8'), Different: canonicalEntry('8') }
      };
    });
    await expect(migrateWorkspaceSnapshot(data, mixedCanonicalize))
      .rejects.toThrow(/WrongKey.*disagrees with internal name.*Different/);
    expect(data.config.version).toBe('0.0.3');
  });

  it('starts from the declared version and never reruns older transforms', async () => {
    const data = snapshot('0.0.3');
    const canonicalizeMacroPackage = vi.fn(canonicalize);
    const report = await migrateWorkspaceSnapshot(data, canonicalizeMacroPackage);
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
