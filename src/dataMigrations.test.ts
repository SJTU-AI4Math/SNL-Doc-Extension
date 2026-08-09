import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_DATA_MIGRATIONS,
  assertWorkspaceDataWritable,
  assertWorkspaceDataVersionNotRegressed,
  assertCanonicalMacroPackage,
  assertJsonSnapshotUnchanged,
  cloneWorkspaceDataSnapshot,
  inspectWorkspaceData,
  migrateWorkspaceSnapshot,
  type WorkspaceDataSnapshot
} from './dataMigrations';

const canonicalEntry = (version: '7' | '8' | '9' | '10'): Record<string, unknown> => ({
  description: '',
  source: { entries: [], urls: [] },
  dynamic_arity: false,
  tags: [],
  ...(version === '8' ? { default_style: { en: 'default' } } : {}),
  ...(version === '10' ? { kind: 'const' } : {}),
  styles: [{ style_name: 'default', mode: 'formula_inline', template: 'old', tags: [] }]
});

const setStyleField = (
  macro: Record<string, unknown>,
  field: string,
  value: unknown
): void => {
  const styles = macro.styles as Array<Record<string, unknown>>;
  styles[0] = { ...styles[0], [field]: value };
};

const canonicalize = (_file: string, raw: unknown, version: '7' | '8' | '9' | '10'): unknown => {
  const wrapper = raw as Record<string, unknown>;
  if ((version === '9' || version === '10') && wrapper.macros && typeof wrapper.macros === 'object') {
    return {
      ...wrapper,
      version,
      macros: Object.fromEntries(Object.entries(wrapper.macros as Record<string, any>).map(([name, macro]) => {
        const { default_style: _legacy, ...current } = macro;
        return [name, version === '10'
          ? { ...current, kind: current.kind === 'partial' ? 'sub' : current.kind || 'const' }
          : current];
      }))
    };
  }
  return {
    ...wrapper,
    version,
    macros: { old: canonicalEntry(version) }
  };
};

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
  it('deep-clones every workspace snapshot field and map value', () => {
    const source = snapshot('0.0.1');
    source.packageManifests.set('packages/p.json', { nested: ['package'] } as never);
    source.entryEntities.set('entries/e.json', { nested: ['entry'] } as never);
    source.macroEntities.set('macros/m.json', { nested: ['macro'] } as never);

    const cloned = cloneWorkspaceDataSnapshot(source);
    expect(cloned).toEqual(source);
    expect(cloned).not.toBe(source);
    expect(cloned.config).not.toBe(source.config);
    expect(cloned.macroPackages).not.toBe(source.macroPackages);
    expect(cloned.macroPackages.get('Logic.json')).not.toBe(source.macroPackages.get('Logic.json'));
    expect(cloned.packageManifests.get('packages/p.json')).not.toBe(source.packageManifests.get('packages/p.json'));
    expect(cloned.entryEntities.get('entries/e.json')).not.toBe(source.entryEntities.get('entries/e.json'));
    expect(cloned.macroEntities.get('macros/m.json')).not.toBe(source.macroEntities.get('macros/m.json'));
  });

  it('reports missing, invalid, future, current and migratable workspace states', () => {
    expect(inspectWorkspaceData(null).status).toBe('missing');
    expect(inspectWorkspaceData({}).status).toBe('needsMigration');
    expect(inspectWorkspaceData({ version: 'wat' }).status).toBe('invalid');
    expect(inspectWorkspaceData([]).status).toBe('invalid');
    expect(inspectWorkspaceData('bad').status).toBe('invalid');
    expect(inspectWorkspaceData({ version: '9.0.0' }).status).toBe('future');
    expect(inspectWorkspaceData({ version: '0.0.4' }).status).toBe('needsMigration');
    expect(inspectWorkspaceData({ version: '0.0.5' }).status).toBe('needsMigration');
    expect(inspectWorkspaceData({ version: '0.0.6' }).status).toBe('needsMigration');
    expect(inspectWorkspaceData({ version: '0.0.7' }).status).toBe('needsMigration');
    expect(inspectWorkspaceData({ version: '0.0.8' }).status).toBe('current');
    const old = inspectWorkspaceData({ version: '0.0.1' });
    expect(old.status).toBe('needsMigration');
    expect(old.pending?.map((step) => `${step.from}->${step.to}`)).toEqual([
      '0.0.1->0.0.2',
      '0.0.2->0.0.3',
      '0.0.3->0.0.4',
      '0.0.4->0.0.5',
      '0.0.5->0.0.6',
      '0.0.6->0.0.7',
      '0.0.7->0.0.8'
    ]);
  });

  it('blocks ordinary writes to future, invalid, or missing workspace schemas', () => {
    expect(() => assertWorkspaceDataWritable({ version: '9.0.0' })).toThrow(/newer/);
    expect(() => assertWorkspaceDataWritable({ version: 'wat' })).toThrow(/SemVer/);
    expect(() => assertWorkspaceDataWritable(null)).toThrow(/does not exist/);
    expect(() => assertWorkspaceDataWritable([])).toThrow(/object/);
    expect(() => assertWorkspaceDataWritable('bad')).toThrow(/object/);
    expect(() => assertWorkspaceDataWritable({ version: '0.0.3' })).toThrow(/migration/i);
    expect(() => assertWorkspaceDataWritable({ version: '0.0.4' })).toThrow(/migration/i);
    expect(() => assertWorkspaceDataWritable({ version: '0.0.6' })).toThrow(/migration/i);
    expect(() => assertWorkspaceDataWritable({ version: '0.0.7' })).toThrow(/migration/i);
    expect(() => assertWorkspaceDataWritable({ version: '0.0.8' })).not.toThrow();
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

  it('migrates entity Macros from package schema v8 through v10', async () => {
    const data = snapshot('0.0.6');
    data.macroPackages.clear();
    data.macroEntities.set('macros/logic-x.json', {
      format: 'snl-macro', version: 1, package: 'Logic',
      macro: {
        name: 'X', description: '', source: { entries: [], urls: [] },
        dynamic_arity: false, tags: [], default_style: { en: 'english', 'zh-CN': 'chinese' },
        styles: [
          { style_name: 'english', mode: 'text', template: 'English', tags: [] },
          { style_name: 'chinese', mode: 'text', template: '中文', tags: [] }
        ]
      }
    });
    const canonicalizeV10 = vi.fn((_file: string, raw: unknown, target: '7' | '8' | '9' | '10') => {
      const wrapper = raw as any;
      const macro = wrapper.macros.X;
      if (target === '10') {
        return {
          ...wrapper, version: '10',
          macros: { X: { ...macro, kind: macro.kind || 'const' } }
        };
      }
      expect(target).toBe('9');
      const { default_style: _legacy, ...current } = macro;
      return {
        ...wrapper, version: '9',
        macros: {
          X: {
            ...current,
            styles: [{
              ...macro.styles[0], style_name: 'english_localized_default',
              template: {
                type: 'i18n', default_language: 'en',
                values: { en: 'English', 'zh-CN': '中文' }
              }
            }, ...macro.styles]
          }
        }
      };
    });

    const report = await migrateWorkspaceSnapshot(data, canonicalizeV10);

    expect(report.applied.map((step) => `${step.from}->${step.to}`)).toEqual([
      '0.0.6->0.0.7',
      '0.0.7->0.0.8'
    ]);
    expect(data.config.version).toBe('0.0.8');
    expect(canonicalizeV10).toHaveBeenCalledTimes(2);
    const migrated = data.macroEntities.get('macros/logic-x.json')!.macro as any;
    expect(migrated).not.toHaveProperty('default_style');
    expect(migrated.kind).toBe('const');
    expect(migrated.styles[0].template.values).toEqual({ en: 'English', 'zh-CN': '中文' });
  });

  it('rejects malformed v8 entity Macro fields before canonicalization', async () => {
    const data = snapshot('0.0.6');
    data.macroPackages.clear();
    data.macroEntities.set('macros/logic-x.json', {
      format: 'snl-macro', version: 1, package: 'Logic',
      macro: { name: 'X', ...canonicalEntry('8'), source: { entries: 'bad', urls: [] } }
    });
    const sanitizingCanonicalizer = vi.fn((_file: string, _raw: unknown, target: '7' | '8' | '9' | '10') => ({
      version: target,
      name: 'Logic',
      macros: { X: canonicalEntry(target === '9' ? '9' : '10') }
    }));

    await expect(migrateWorkspaceSnapshot(data, sanitizingCanonicalizer))
      .rejects.toThrow(/source\.entries.*array of strings/i);
    expect(sanitizingCanonicalizer).not.toHaveBeenCalled();
    expect(data.config.version).toBe('0.0.6');
  });

  it('rejects v8 localized text Templates before canonicalization', async () => {
    const data = snapshot('0.0.6');
    data.macroPackages.clear();
    const macro = { name: 'X', ...canonicalEntry('8') } as any;
    macro.styles[0] = {
      ...macro.styles[0],
      mode: 'text',
      template: { type: 'i18n', default_language: 'en', values: { en: 'X' } }
    };
    data.macroEntities.set('macros/logic-x.json', {
      format: 'snl-macro', version: 1, package: 'Logic', macro
    });
    const canonicalizer = vi.fn();

    await expect(migrateWorkspaceSnapshot(data, canonicalizer)).rejects.toThrow(/template must be a string/i);
    expect(canonicalizer).not.toHaveBeenCalled();
    expect(data.config.version).toBe('0.0.6');
  });

  it('rejects retired managed fields in current v10 payloads', () => {
    for (const field of ['tag', 'variadic_left', 'variadic_join', 'variadic_right', 'react_renderer_key', 'display']) {
      const macro = canonicalEntry('10');
      const styles = macro.styles as Array<Record<string, unknown>>;
      styles[0] = { ...styles[0], [field]: 'retired' };
      expect(() => assertCanonicalMacroPackage('Logic.json', {
        version: '10', name: 'Logic', macros: { X: macro }
      }, '10'), field).toThrow(/not valid|retired|managed/i);
    }
  });

  it('rejects managed fields at the wrong Macro/Style layer but preserves unknown extensions', () => {
    for (const field of [
      'style_name', 'mode', 'template', 'separator', 'block_template_name',
      'typst', 'latex', 'markdown', 'text',
      'tag', 'variadic_left', 'variadic_join', 'variadic_right',
      'react_renderer_key', 'display', 'arity', 'katex_react', 'defaultStyle'
    ]) {
      const macro = { ...canonicalEntry('10'), [field]: 'wrong-layer' };
      expect(() => assertCanonicalMacroPackage('Logic.json', {
        version: '10', name: 'Logic', macros: { X: macro }
      }, '10'), `Macro.${field}`).toThrow(/recognized managed field.*Macro level/i);
    }
    for (const field of [
      'kind', 'description', 'source', 'dynamic_arity', 'styles', 'default_style',
      'arity', 'katex_react', 'defaultStyle'
    ]) {
      const macro = canonicalEntry('10');
      setStyleField(macro, field, 'wrong-layer');
      expect(() => assertCanonicalMacroPackage('Logic.json', {
        version: '10', name: 'Logic', macros: { X: macro }
      }, '10'), `Style.${field}`).toThrow(/Macro-only managed field/i);
    }
    const extensible = { ...canonicalEntry('10'), vendor_macro: { keep: true } };
    setStyleField(extensible, 'vendor_style', { keep: true });
    expect(() => assertCanonicalMacroPackage('Logic.json', {
      version: '10', name: 'Logic', macros: { X: extensible }
    }, '10')).not.toThrow();
  });

  it.each([
    ['non-string kind', (macro: Record<string, unknown>) => { macro.kind = 17; }],
    ['retired Macro arity field', (macro: Record<string, unknown>) => { macro.arity = 2; }],
    ['retired Macro katex_react field', (macro: Record<string, unknown>) => { macro.katex_react = {}; }],
    ['retired Macro defaultStyle field', (macro: Record<string, unknown>) => { macro.defaultStyle = 'default'; }],
    ['retired tag field', (macro: Record<string, unknown>) => setStyleField(macro, 'tag', 'old')],
    ['retired variadic_left field', (macro: Record<string, unknown>) => setStyleField(macro, 'variadic_left', '[')],
    ['retired variadic_join field', (macro: Record<string, unknown>) => setStyleField(macro, 'variadic_join', ',')],
    ['retired variadic_right field', (macro: Record<string, unknown>) => setStyleField(macro, 'variadic_right', ']')],
    ['retired react_renderer_key field', (macro: Record<string, unknown>) => setStyleField(macro, 'react_renderer_key', 'x')],
    ['retired display field', (macro: Record<string, unknown>) => setStyleField(macro, 'display', true)],
    ['malformed backend', (macro: Record<string, unknown>) => {
      const styles = macro.styles as Array<Record<string, unknown>>;
      styles[0] = { ...styles[0], typst: 17 };
    }],
    ['dynamic template without #*', (macro: Record<string, unknown>) => {
      macro.dynamic_arity = true;
    }]
  ])('rejects v9 %s before canonicalization', async (_case, mutate) => {
    const data = snapshot('0.0.7');
    data.macroPackages.clear();
    const macro = { name: 'X', ...canonicalEntry('9') };
    mutate(macro);
    data.macroEntities.set('macros/logic-x.json', {
      format: 'snl-macro', version: 1, package: 'Logic', macro
    });
    const sanitizingCanonicalizer = vi.fn((_file: string, _raw: unknown, target: string) => ({
      version: target, name: 'Logic', macros: { X: canonicalEntry('10') }
    }));

    await expect(migrateWorkspaceSnapshot(data, sanitizingCanonicalizer)).rejects.toThrow();
    expect(sanitizingCanonicalizer).not.toHaveBeenCalled();
    expect(data.config.version).toBe('0.0.7');
  });

  it('rejects malformed v9 entity Macro fields before canonicalization', async () => {
    const data = snapshot('0.0.7');
    data.macroPackages.clear();
    data.macroEntities.set('macros/logic-x.json', {
      format: 'snl-macro', version: 1, package: 'Logic',
      macro: { name: 'X', ...canonicalEntry('9'), description: 42 }
    });
    const sanitizingCanonicalizer = vi.fn((_file: string, _raw: unknown, target: '7' | '8' | '9' | '10') => ({
      version: target,
      name: 'Logic',
      macros: { X: canonicalEntry('10') }
    }));

    await expect(migrateWorkspaceSnapshot(data, sanitizingCanonicalizer))
      .rejects.toThrow(/invalid required fields/i);
    expect(sanitizingCanonicalizer).not.toHaveBeenCalled();
    expect(data.config.version).toBe('0.0.7');
  });

  it('rejects a v9 canonicalizer result whose Macro default projection is not own', async () => {
    const data = snapshot('0.0.6');
    data.macroPackages.clear();
    data.macroEntities.set('macros/logic-x.json', {
      format: 'snl-macro', version: 1, package: 'Logic',
      macro: {
        name: 'X', description: '', source: { entries: [], urls: [] },
        dynamic_arity: false, tags: [], default_style: { en: 'default' },
        styles: [{ style_name: 'default', mode: 'text', template: 'English', tags: [] }]
      }
    });
    const malformedCanonicalizer = (_file: string, raw: unknown): unknown => {
      const wrapper = raw as any;
      const { default_style: _legacy, ...macro } = wrapper.macros.X;
      return {
        ...wrapper, version: '9',
        macros: { X: {
          ...macro,
          styles: [{
            style_name: 'default', mode: 'text', tags: [],
            template: { type: 'i18n', default_language: 'en', values: { 'zh-CN': '中文' } }
          }]
        } }
      };
    };
    await expect(migrateWorkspaceSnapshot(data, malformedCanonicalizer)).rejects.toThrow(/valid I18n/);
    expect(data.config.version).toBe('0.0.6');
  });

  it('migrates aggregate Entries and Macros into stable per-entity package storage', async () => {
    const data = snapshot('0.0.5');
    data.macroPackages.set('Logic.json', {
      version: '8', name: 'Logic', description: 'Logic macros', custom: 'package',
      macros: { old: { ...canonicalEntry('8'), custom: true } }
    });
    const canonicalizeSpy = vi.fn(canonicalize);

    const report = await migrateWorkspaceSnapshot(data, canonicalizeSpy);

    expect(report.applied.map((step) => `${step.from}->${step.to}`)).toEqual([
      '0.0.5->0.0.6',
      '0.0.6->0.0.7',
      '0.0.7->0.0.8'
    ]);
    expect(data.config).toMatchObject({
      version: '0.0.8',
      entity_storage: {
        version: 1,
        legacy_backup_version: '0.0.5',
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
        entry: {
          id: 'Set.mem', kind: 'theorem', title: 'Membership',
          pointer: null, package: '_unpackaged'
        }
      }]
    ]);
    expect([...data.macroEntities]).toEqual([
      ['macros/Logic-315ab0b5e1a20cdc1802.json', {
        format: 'snl-macro', version: 1, package: 'Logic',
        macro: { name: 'old', ...canonicalEntry('10'), custom: true }
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
          version: '8', name: 'Logic', format: 'extension-value', macros: { old: canonicalEntry('8') }
        });
      },
      (data) => {
        data.macroPackages.set('Logic.json', {
          version: '8', name: 'Logic', macros: { ' old ': canonicalEntry('8') }
        });
      }
    ];
    for (const mutate of cases) {
      const data = snapshot('0.0.5');
      data.macroPackages.set('Logic.json', {
        version: '8', name: 'Logic', macros: { old: canonicalEntry('8') }
      });
      mutate(data);
      await expect(migrateWorkspaceSnapshot(data, (_file, raw) => raw))
        .rejects.toThrow(/reserved|whitespace|valid SNL identifier/i);
      expect(data.config.version).toBe('0.0.5');
    }
  });

  it('canonicalizes and validates the active Package set before entity migration', async () => {
    const data = snapshot('0.0.5');
    data.config.active_macro_packages = ['Logic.json', 'Logic'];
    data.macroPackages.set('Logic.json', {
      version: '8', name: 'Logic', macros: { old: canonicalEntry('8') }
    });
    await migrateWorkspaceSnapshot(data, canonicalize);
    expect(data.config.active_macro_packages).toEqual(['Logic']);

    for (const invalid of [['Missing'], [' bad/name '], 'Logic']) {
      const bad = snapshot('0.0.5');
      bad.config.active_macro_packages = invalid;
      bad.macroPackages.set('Logic.json', {
        version: '8', name: 'Logic', macros: { old: canonicalEntry('8') }
      });
      await expect(migrateWorkspaceSnapshot(bad, (_file, raw) => raw))
        .rejects.toThrow(/active_macro_packages|Package manifest|Package id/i);
      expect(bad.packageManifests.size).toBe(0);
    }

    const reserved = snapshot('0.0.5');
    reserved.config.entity_storage = { vendor: true };
    await expect(migrateWorkspaceSnapshot(reserved, (_file, raw) => raw))
      .rejects.toThrow(/entity_storage.*reserved/i);
    expect(reserved.packageManifests.size).toBe(0);
  });

  it('resumes matching partial entity output but rejects conflicting crash residue', async () => {
    const data = snapshot('0.0.5');
    data.macroPackages.set('Logic.json', {
      version: '8', name: 'Logic', macros: { old: canonicalEntry('8') }
    });
    data.packageManifests.set('packages/_unpackaged-60979c6e210d0e2a20cb.json', {
      format: 'snl-package', version: 1, id: '_unpackaged', name: 'Unpackaged',
      description: 'Legacy Entries without an assigned package.'
    });
    await expect(migrateWorkspaceSnapshot(data, canonicalize)).resolves.toMatchObject({
      to: '0.0.8'
    });

    const conflict = snapshot('0.0.5');
    conflict.macroPackages.set('Logic.json', {
      version: '8', name: 'Logic', macros: { old: canonicalEntry('8') }
    });
    conflict.packageManifests.set('packages/_unpackaged-60979c6e210d0e2a20cb.json', {
      format: 'snl-package', version: 1, id: '_unpackaged', name: 'Tampered', description: ''
    });
    await expect(migrateWorkspaceSnapshot(conflict, (_file, raw) => raw))
      .rejects.toThrow(/partial|conflict|residue/i);
    expect(conflict.config.version).toBe('0.0.5');
  });

  it('chains every historical migration and preserves unknown config fields', async () => {
    const data = snapshot('0.0.1');
    const canonicalizeMacroPackage = vi.fn(canonicalize);
    const report = await migrateWorkspaceSnapshot(data, canonicalizeMacroPackage);

    expect(report.applied).toEqual(WORKSPACE_DATA_MIGRATIONS);
    expect(data.config.version).toBe('0.0.8');
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
    expect(canonicalizeMacroPackage).toHaveBeenCalledTimes(4);
    expect(canonicalizeMacroPackage.mock.calls.map((call) => call[2])).toEqual(['7', '8', '9', '10']);
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

  it('accepts Unicode identifiers and rejects stray ASCII punctuation in canonical packages', async () => {
    const unicode = snapshot('0.0.4');
    unicode.macroPackages.clear();
    const unicodeEntry7 = {
      ...canonicalEntry('7'),
      styles: [{ style_name: '默认🐈', mode: 'formula_inline', template: 'old', tags: [] }]
    };
    unicode.macroPackages.set('Unicode.json', {
      version: '7', name: 'Unicode', macros: { '群.是群🐈': unicodeEntry7 }
    });
    const unicodeCanonicalize = vi.fn((file: string, raw: unknown, version: '7' | '8' | '9' | '10') => {
      if (file === 'Logic.json') return canonicalize(file, raw, version);
      return {
        ...(raw as Record<string, unknown>), version,
        macros: {
          '群.是群🐈': {
            ...unicodeEntry7,
            ...(version === '8' ? { default_style: { en: '默认🐈' } } : {}),
            ...(version === '10' ? { kind: 'const' } : {})
          }
        }
      };
    });
    await migrateWorkspaceSnapshot(unicode, unicodeCanonicalize);
    expect((unicode.macroPackages.get('Unicode.json') as any).macros['群.是群🐈']
      .styles[0].style_name).toBe('默认🐈');

    const invalid = snapshot('0.0.4');
    invalid.macroPackages.clear();
    invalid.macroPackages.set('Invalid.json', {
      version: '7', name: 'Invalid', macros: { 'bad!name': canonicalEntry('7') }
    });
    await expect(migrateWorkspaceSnapshot(invalid, canonicalize))
      .rejects.toThrow(/bad!name.*not a valid SNL identifier/);
  });

  it('checks identities per record in mixed legacy/current Macro packages', async () => {
    const data = snapshot('0.0.3');
    data.macroPackages.set('Mixed.json', {
      version: '6', name: 'Mixed', macros: {
        'Legacy.infix': { name: 'Legacy.infix', katex_react: { mode: 'formula' } },
        WrongKey: { name: 'Different', styles: [] }
      }
    });
    const mixedCanonicalize = vi.fn((file: string, raw: unknown, version: '7' | '8' | '9') => {
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
    expect(report.applied.map((step) => step.from)).toEqual(['0.0.3', '0.0.4', '0.0.5', '0.0.6', '0.0.7']);
    expect(data.config.version).toBe('0.0.8');
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
