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
import {
  entryEntityPath,
  macroEntityPath,
  makeEntryEnvelope,
  makeMacroEnvelope,
  makePackageManifest,
  packageManifestPath
} from './entityStorage';

const canonicalEntry = (
  version: '7' | '8' | '9' | '10' | '11'
): Record<string, unknown> => ({
  description: '',
  source: { entries: [], urls: [] },
  dynamic_arity: false,
  tags: [],
  ...(version === '8' ? { default_style: { en: 'default' } } : {}),
  ...(version === '10' || version === '11' ? { kind: 'const' } : {}),
  styles: [version === '11'
    ? {
        style_name: 'default',
        template: { mode: 'formula_inline', body: 'old' },
        tags: []
      }
    : { style_name: 'default', mode: 'formula_inline', template: 'old', tags: [] }]
});

const setStyleField = (
  macro: Record<string, unknown>,
  field: string,
  value: unknown
): void => {
  const styles = macro.styles as Array<Record<string, unknown>>;
  styles[0] = { ...styles[0], [field]: value };
};

const canonicalize = (
  _file: string,
  raw: unknown,
  version: '7' | '8' | '9' | '10' | '11'
): unknown => {
  const wrapper = raw as Record<string, unknown>;
  if (version === '11' && wrapper.macros && typeof wrapper.macros === 'object') {
    const macros = Object.fromEntries(Object.entries(
      wrapper.macros as Record<string, Record<string, any>>
    ).map(([name, macro]) => {
      const oldStyles = Array.isArray(macro.styles) ? macro.styles as Record<string, any>[] : [];
      const projection = (style: Record<string, any>, language: string): Record<string, unknown> => {
        const localized = style.template && typeof style.template === 'object' && style.template.type === 'i18n'
          ? style.template.values[language] ?? style.template.values[style.template.default_language]
          : style.template;
        return {
          mode: style.mode,
          body: typeof localized === 'string' ? localized : '',
          ...(style.separator !== undefined ? { separator: style.separator } : {}),
          ...(style.mode === 'block' && style.block_template_name !== undefined
            ? { block_template_name: style.block_template_name }
            : {}),
          ...(style.typst !== undefined ? { typst: style.typst } : {}),
          ...(style.latex !== undefined ? { latex: style.latex } : {}),
          ...(style.markdown !== undefined ? { markdown: style.markdown } : {}),
          ...(style.text !== undefined ? { text: style.text } : {})
        };
      };
      const migrated = oldStyles.map((style) => ({
        style_name: style.style_name,
        tags: style.tags,
        template: style.template && typeof style.template === 'object' && style.template.type === 'i18n'
          ? {
              ...style.template,
              values: Object.fromEntries(Object.keys(style.template.values).map((language) => [
                language,
                projection(style, language)
              ]))
            }
          : projection(style, 'en')
      }));
      const defaultMap = macro.default_style as Record<string, string> | undefined;
      if (defaultMap && new Set(Object.values(defaultMap)).size > 1) {
        const byName = new Map(oldStyles.map((style) => [style.style_name, style]));
        const fallback = byName.get(defaultMap.en) ?? oldStyles[0];
        migrated.unshift({
          style_name: 'localized-default',
          tags: [],
          template: {
            type: 'i18n',
            default_language: 'en',
            values: {
              en: projection(fallback, 'en'),
              ...Object.fromEntries(Object.entries(defaultMap).map(([language, styleName]) => [
                language,
                projection(byName.get(styleName)!, language)
              ]))
            }
          }
        });
      }
      const { default_style: _legacy, ...current } = macro;
      return [name, {
        ...current,
        kind: current.kind === 'partial' ? 'sub' : current.kind || 'const',
        styles: migrated
      }];
    }));
    return { ...wrapper, version, macros };
  }
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

const snapshot = (version: string): WorkspaceDataSnapshot => {
  const patch = Number(version.split('.')[2] ?? 0);
  const entryKind = patch >= 3
    ? {
        id: 'theorem', name: 'Theorem',
        coloring: { stroke: '#123456', background: '#123456' },
        defaultCounterName: '', style: 'box', custom: 'preserve'
      }
    : {
        id: 'theorem', name: 'Theorem', color: '#123456',
        numbering: { pattern: '.1' }, style: 'box', custom: 'preserve'
      };
  const macroKind = patch >= 3
    ? {
        id: 'rule', name: 'Rule', description: '',
        coloring: { stroke: '#abcdef', background: '#abcdef' }, custom: 7
      }
    : { id: 'rule', name: 'Rule', color: '#abcdef', custom: 7 };
  return {
  config: {
    version,
    vendor_extension: { keep: true },
    entry_kinds: [entryKind],
    macro_kinds: [macroKind]
  },
  macroPackages: new Map([
    ['Logic.json', { version: '6', name: 'Logic', macros: { old: {} }, custom: 'package' }]
  ]),
  relationships: undefined,
  entries: [{ id: 'Set.mem', kind: 'theorem', title: 'Membership' }],
  packageManifests: new Map(),
  entryEntities: new Map(),
  macroEntities: new Map()
};
};

describe('workspace data migrations', () => {
  it('builds exact sorted Package membership in the explicit 0.0.10 to 0.0.11 edge', async () => {
    const data = snapshot('0.0.10');
    data.packageManifests.set(packageManifestPath('logic'), {
      ...makePackageManifest('logic', 'Logic', '', []),
      schema_version: 1,
      vendor_extension: { keep: true }
    } as never);
    data.packageManifests.set(packageManifestPath('other'), {
      ...makePackageManifest('other', 'Other', '', ['stale.missing']),
      schema_version: 1
    } as never);
    for (const [packageId, entryId] of [
      ['logic', 'logic.zed'],
      ['logic', 'logic.alpha'],
      ['other', 'other.only']
    ] as const) {
      data.entryEntities.set(
        entryEntityPath(packageId, entryId),
        makeEntryEnvelope(packageId, { id: entryId, package: packageId })
      );
    }

    const report = await migrateWorkspaceSnapshot(data, (_file, raw) => raw);

    expect(report.applied.map((step) => `${step.from}->${step.to}`)).toEqual(['0.0.10->0.0.11']);
    expect(data.config.version).toBe('0.0.11');
    expect(data.packageManifests.get(packageManifestPath('logic'))).toMatchObject({
      schema_version: 2,
      entry_ids: ['logic.alpha', 'logic.zed'],
      vendor_extension: { keep: true }
    });
    expect(data.packageManifests.get(packageManifestPath('other'))).toMatchObject({
      schema_version: 2,
      entry_ids: ['other.only']
    });
  });

  it('rejects an Entry whose owner Package is absent before publishing membership', async () => {
    const data = snapshot('0.0.10');
    data.packageManifests.set(packageManifestPath('logic'), {
      ...makePackageManifest('logic', 'Logic', ''), schema_version: 1
    } as never);
    data.entryEntities.set(
      entryEntityPath('missing', 'orphan'),
      makeEntryEnvelope('missing', { id: 'orphan', package: 'missing' })
    );
    const before = cloneWorkspaceDataSnapshot(data);

    await expect(migrateWorkspaceSnapshot(data, (_file, raw) => raw))
      .rejects.toThrow(/missing Package/i);
    expect(data).toEqual(before);
  });

  it('chains lazy file capability into authoritative Package membership', async () => {
    const data = snapshot('0.0.9');
    data.packageManifests.set(packageManifestPath('logic'), {
      format: 'snl-package', version: 1, id: 'logic', name: 'Logic', description: '', vendor: 'keep'
    } as never);
    data.entryEntities.set(entryEntityPath('logic', 'entry-1'), {
      format: 'snl-entry', version: 1, package: 'logic', vendor: 'keep',
      entry: { id: 'entry-1', package: 'logic' }
    } as never);
    data.macroEntities.set(macroEntityPath('logic', 'Eq'), {
      format: 'snl-macro', version: 1, package: 'logic', vendor: 'keep',
      macro: { name: 'Eq' }
    } as never);
    const beforeFiles = {
      packages: structuredClone([...data.packageManifests]),
      entries: structuredClone([...data.entryEntities]),
      macros: structuredClone([...data.macroEntities])
    };

    const report = await migrateWorkspaceSnapshot(data, (_file, raw) => raw);

    expect(report.applied.map((step) => `${step.from}->${step.to}`)).toEqual([
      '0.0.9->0.0.10', '0.0.10->0.0.11'
    ]);
    expect(data.config.version).toBe('0.0.11');
    expect([...data.packageManifests]).toEqual([[packageManifestPath('logic'), expect.objectContaining({
      schema_version: 2, entry_ids: ['entry-1'], vendor: 'keep'
    })]]);
    expect([...data.entryEntities]).toEqual(beforeFiles.entries);
    expect([...data.macroEntities]).toEqual(beforeFiles.macros);
  });

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
    expect(inspectWorkspaceData({ version: '0.0.8' }).status).toBe('needsMigration');
    expect(inspectWorkspaceData({ version: '0.0.9' }).status).toBe('needsMigration');
    expect(inspectWorkspaceData({ version: '0.0.10' }).status).toBe('needsMigration');
    expect(inspectWorkspaceData({ version: '0.0.11' }).status).toBe('current');
    const old = inspectWorkspaceData({ version: '0.0.1' });
    expect(old.status).toBe('needsMigration');
    expect(old.pending?.map((step) => `${step.from}->${step.to}`)).toEqual([
      '0.0.1->0.0.2',
      '0.0.2->0.0.3',
      '0.0.3->0.0.4',
      '0.0.4->0.0.5',
      '0.0.5->0.0.6',
      '0.0.6->0.0.9',
      '0.0.9->0.0.10', '0.0.10->0.0.11'
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
    expect(() => assertWorkspaceDataWritable({ version: '0.0.8' })).toThrow(/migration/i);
    expect(() => assertWorkspaceDataWritable({ version: '0.0.9' })).toThrow(/migration/i);
    expect(() => assertWorkspaceDataWritable({ version: '0.0.10' })).toThrow(/migration/i);
    expect(() => assertWorkspaceDataWritable({ version: '0.0.11' })).not.toThrow();
  });

  it('migrates legacy Kind color pairs into lossless light and dark variants', async () => {
    const data = snapshot('0.0.8');
    data.config.entry_kinds = [{
      id: 'theorem', name: 'Theorem',
      coloring: { stroke: '#123456', background: '#abcdef', vendor: { keep: 'entry-coloring' } },
      defaultCounterName: 'theorem', style: '', custom: { keep: true }
    }];
    data.config.macro_kinds = [{
      id: 'rule', name: 'Rule', description: 'Rule nodes',
      coloring: { stroke: '#654321', background: '#fedcba' }, custom: 7
    }];

    const report = await migrateWorkspaceSnapshot(data, (_file, raw) => raw);

    expect(report.applied.map((step) => `${step.from}->${step.to}`)).toEqual([
      '0.0.8->0.0.9',
      '0.0.9->0.0.10', '0.0.10->0.0.11'
    ]);
    expect(data.config.version).toBe('0.0.11');
    expect(data.config.entry_kinds).toEqual([{
      id: 'theorem', name: 'Theorem',
      coloring: {
        vendor: { keep: 'entry-coloring' },
        light: { stroke: '#123456', background: '#abcdef' },
        dark: { stroke: '#123456', background: '#abcdef' }
      },
      defaultCounterName: 'theorem', style: '', custom: { keep: true }
    }]);
    expect(data.config.macro_kinds).toEqual([{
      id: 'rule', name: 'Rule', description: 'Rule nodes',
      coloring: {
        light: { stroke: '#654321', background: '#fedcba' },
        dark: { stroke: '#654321', background: '#fedcba' }
      },
      custom: 7
    }]);
  });

  it('repairs blank and incomplete legacy pairs before committing current themed catalogs', async () => {
    const data = snapshot('0.0.8');
    data.config.entry_kinds = [
      { id: 'blank', name: 'Blank', defaultCounterName: '', style: '', coloring: { stroke: '', background: '#abcdef' } },
      { id: 'missing', name: 'Missing', defaultCounterName: '', style: '', coloring: { stroke: '#123456' } },
      { id: 'flat-color', name: 'Flat', defaultCounterName: '', style: '', color: '#654321' }
    ];

    await migrateWorkspaceSnapshot(data, (_file, raw) => raw);
    expect(data.config.entry_kinds).toEqual([
      { id: 'blank', name: 'Blank', defaultCounterName: '', style: '', coloring: {
        light: { stroke: '#abcdef', background: '#abcdef' },
        dark: { stroke: '#abcdef', background: '#abcdef' }
      } },
      { id: 'missing', name: 'Missing', defaultCounterName: '', style: '', coloring: {
        light: { stroke: '#123456', background: '#123456' },
        dark: { stroke: '#123456', background: '#123456' }
      } },
      { id: 'flat-color', name: 'Flat', defaultCounterName: '', style: '', coloring: {
        light: { stroke: '#654321', background: '#654321' },
        dark: { stroke: '#654321', background: '#654321' }
      } }
    ]);
  });

  it('canonicalizes a one-sided themed compatibility record before committing 0.0.9', async () => {
    const data = snapshot('0.0.8');
    data.config.entry_kinds = [{
      id: 'theorem', name: 'Theorem', defaultCounterName: '', style: '',
      coloring: {
        vendor: { keep: true },
        light: { stroke: '#111111', background: '#eeeeee', token: 'light-token' }
      }
    }];

    await migrateWorkspaceSnapshot(data, (_file, raw) => raw);
    expect(data.config.entry_kinds).toEqual([{
      id: 'theorem', name: 'Theorem', defaultCounterName: '', style: '',
      coloring: {
        vendor: { keep: true },
        light: { stroke: '#111111', background: '#eeeeee', token: 'light-token' },
        dark: { stroke: '#111111', background: '#eeeeee', token: 'light-token' }
      }
    }]);
  });

  it('rejects mixed flat and themed Kind coloring before committing 0.0.9', async () => {
    const data = snapshot('0.0.8');
    data.config.entry_kinds = [{ id: 'theorem', name: 'Theorem', coloring: {
      stroke: '#legacy', background: '#legacy-bg',
      light: { stroke: '#111111', background: '#eeeeee' },
      dark: { stroke: '#dddddd', background: '#222222' }
    } }];
    const original = structuredClone(data.config);

    await expect(migrateWorkspaceSnapshot(data, (_file, raw) => raw))
      .rejects.toThrow(/coloring|light|dark|mix/i);
    expect(data.config).toEqual(original);
  });

  it('rejects malformed non-object Kind coloring without committing 0.0.9', async () => {
    const data = snapshot('0.0.8');
    data.config.entry_kinds = [{ id: 'theorem', coloring: 'red' }];
    const original = structuredClone(data.config);

    await expect(migrateWorkspaceSnapshot(data, (_file, raw) => raw))
      .rejects.toThrow(/coloring|object/i);
    expect(data.config).toEqual(original);
  });

  it('rejects a projected 0.0.9 catalog missing required Kind fields atomically', async () => {
    const data = snapshot('0.0.8');
    data.config.entry_kinds = [{
      id: 'theorem', name: 'Theorem', defaultCounterName: '',
      coloring: { stroke: '#123456', background: '#abcdef' }
    }];
    const original = structuredClone(data.config);

    await expect(migrateWorkspaceSnapshot(data, (_file, raw) => raw))
      .rejects.toThrow(/entry_kinds.*style/i);
    expect(data.config).toEqual(original);  });

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

  it('migrates v8 language-selected Styles directly to atomic v11 TemplateSpecs', async () => {
    const data = snapshot('0.0.6');
    data.macroPackages.clear();
    data.macroEntities.set('macros/logic-x.json', {
      format: 'snl-macro', version: 1, package: 'Logic',
      macro: {
        name: 'X', description: '', source: { entries: [], urls: [] },
        dynamic_arity: true, tags: [], default_style: { en: 'english', 'zh-CN': 'chinese' },
        styles: [
          { style_name: 'english', mode: 'text', template: '#*', separator: ', ', tags: [] },
          { style_name: 'chinese', mode: 'text', template: '#*', separator: '、', tags: [] }
        ]
      }
    });
    const canonicalizeV11 = vi.fn(canonicalize);

    const report = await migrateWorkspaceSnapshot(data, canonicalizeV11);

    expect(report.applied.map((step) => `${step.from}->${step.to}`)).toEqual([
      '0.0.6->0.0.9',
      '0.0.9->0.0.10', '0.0.10->0.0.11'
    ]);
    expect(data.config.version).toBe('0.0.11');
    expect(data.macroEntities.get('macros/logic-x.json')!.schema_version).toBe(1);
    expect(canonicalizeV11).toHaveBeenCalledTimes(1);    const migrated = data.macroEntities.get('macros/logic-x.json')!.macro as any;
    expect(migrated).not.toHaveProperty('default_style');
    expect(migrated.kind).toBe('const');
    expect(migrated.styles[0].template.values).toEqual({
      en: { mode: 'text', body: '#*', separator: ', ' },
      'zh-CN': { mode: 'text', body: '#*', separator: '、' }
    });
    expect(migrated.styles.slice(1).map((style: any) => style.style_name))
      .toEqual(['english', 'chinese']);
  });

  it('rejects malformed v8 entity Macro fields before canonicalization', async () => {
    const data = snapshot('0.0.6');
    data.macroPackages.clear();
    data.macroEntities.set('macros/logic-x.json', {
      format: 'snl-macro', version: 1, package: 'Logic',
      macro: { name: 'X', ...canonicalEntry('8'), source: { entries: 'bad', urls: [] } }
    });
    const sanitizingCanonicalizer = vi.fn((_file: string, _raw: unknown, target: '7' | '8' | '9' | '10' | '11') => ({
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

  it('rejects v11 localized template projections with different arity', () => {
    const macro = canonicalEntry('11') as any;
    macro.styles[0].template = {
      type: 'i18n', default_language: 'en',
      values: {
        en: { mode: 'text', body: '#0' },
        'zh-CN': { mode: 'text', body: '#0 #1' }
      }
    };
    expect(() => assertCanonicalMacroPackage('Logic.json', {
      version: '11', macros: { X: macro }
    }, '11')).toThrow(/identical arity/i);

    const crossStyle = canonicalEntry('11') as any;
    crossStyle.styles = [
      { style_name: 'one', tags: [], template: { mode: 'text', body: '#0' } },
      { style_name: 'two', tags: [], template: { mode: 'text', body: '#0 #1' } }
    ];
    expect(() => assertCanonicalMacroPackage('Logic.json', {
      version: '11', macros: { X: crossStyle }
    }, '11')).not.toThrow();

    const misplaced = canonicalEntry('11') as any;
    misplaced.styles[0].vendor_style = { ignored: true };
    expect(() => assertCanonicalMacroPackage('Logic.json', {
      version: '11', macros: { X: misplaced }
    }, '11')).toThrow(/outside the Macro v11 Style boundary/i);
  });

  it('uses the renderer placeholder grammar for v11 variadic contracts', () => {
    const escaped = canonicalEntry('11') as any;
    escaped.dynamic_arity = true;
    escaped.styles[0].template = { mode: 'text', body: '\\#*' };
    expect(() => assertCanonicalMacroPackage('Logic.json', {
      version: '11', macros: { X: escaped }
    }, '11')).toThrow(/variadic marker/i);

    const fixed = canonicalEntry('11') as any;
    fixed.dynamic_arity = false;
    fixed.styles[0].template = { mode: 'text', body: '#*' };
    expect(() => assertCanonicalMacroPackage('Logic.json', {
      version: '11', macros: { X: fixed }
    }, '11')).toThrow(/variadic marker/i);

    const hybrid = canonicalEntry('11') as any;
    hybrid.styles[0].template = {
      type: 'i18n', default_language: 'en',
      values: { en: { mode: 'text', body: '#0' } },
      mode: 'block', body: 'IGNORED'
    };
    expect(() => assertCanonicalMacroPackage('Logic.json', {
      version: '11', macros: { X: hybrid }
    }, '11')).toThrow(/localized whole-template|invalid localized template/i);

    const outOfRange = canonicalEntry('11') as any;
    outOfRange.styles[0].template = { mode: 'text', body: '#100' };
    expect(() => assertCanonicalMacroPackage('Logic.json', {
      version: '11', macros: { X: outOfRange }
    }, '11')).toThrow(/out-of-range/i);
  });

  it('rejects managed fields at the wrong Macro/Style layer but preserves unknown extensions', async () => {
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
    const sanitizingCanonicalizer = vi.fn((_file: string, _raw: unknown, target: '7' | '8' | '9' | '10' | '11') => ({
      version: target,
      name: 'Logic',
      macros: { X: canonicalEntry('10') }
    }));

    await expect(migrateWorkspaceSnapshot(data, sanitizingCanonicalizer))
      .rejects.toThrow(/invalid required fields/i);
    expect(sanitizingCanonicalizer).not.toHaveBeenCalled();
    expect(data.config.version).toBe('0.0.7');
  });

  it('rejects a v11 canonicalizer result whose default projection is not own', async () => {
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
        ...wrapper, version: '11',
        macros: { X: {
          ...macro, kind: 'const',
          styles: [{
            style_name: 'default', tags: [],
            template: {
              type: 'i18n', default_language: 'en',
              values: { 'zh-CN': { mode: 'text', body: '中文' } }
            }
          }]
        } }
      };
    };
    await expect(migrateWorkspaceSnapshot(data, malformedCanonicalizer))
      .rejects.toThrow(/localized whole-template|default language/i);
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
      '0.0.6->0.0.9',
      '0.0.9->0.0.10', '0.0.10->0.0.11'
    ]);
    expect(data.config).toMatchObject({
      version: '0.0.11',
      entity_storage: {
        version: 1,
        legacy_backup_version: '0.0.5',
        entry_default_package: '_unpackaged'
      }
    });
    expect([...data.packageManifests]).toEqual([
      ['packages/Logic-277a664e3d2332d369d7.json', {
        format: 'snl-package', version: 1, schema_version: 2,
        id: 'Logic', name: 'Logic', description: 'Logic macros', entry_ids: [],
        custom: 'package'
      }],
      ['packages/_unpackaged-60979c6e210d0e2a20cb.json', {
        format: 'snl-package', version: 1, schema_version: 2,
        id: '_unpackaged', name: 'Unpackaged',
        description: 'Legacy Entries without an assigned package.', entry_ids: ['Set.mem']
      }]
    ]);
    expect([...data.entryEntities]).toEqual([
      ['entries/_unpackaged-a45ab8852b86c1868f0f.json', {
        format: 'snl-entry', version: 1, schema_version: 1, package: '_unpackaged',
        entry: {
          id: 'Set.mem', kind: 'theorem', title: 'Membership',
          pointer: null, package: '_unpackaged'
        }
      }]
    ]);
    expect([...data.macroEntities]).toEqual([
      ['macros/Logic-315ab0b5e1a20cdc1802.json', {
        format: 'snl-macro', version: 1, schema_version: 1, package: 'Logic',
        macro: { name: 'old', ...canonicalEntry('11'), custom: true }
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
        (data.macroPackages.get('Logic.json') as Record<string, unknown>).schema_version = 'vendor-value';
      },
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
      to: '0.0.11'
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

    const falselyMarked = snapshot('0.0.5');
    falselyMarked.macroPackages.set('Logic.json', {
      version: '8', name: 'Logic', macros: { old: canonicalEntry('8') }
    });
    falselyMarked.macroEntities.set(
      macroEntityPath('Logic', 'old'),
      makeMacroEnvelope('Logic', { ...canonicalEntry('8'), name: 'old' })
    );
    await expect(migrateWorkspaceSnapshot(falselyMarked, canonicalize))
      .rejects.toThrow(/v11|schema|residue/i);
    expect(falselyMarked.config.version).toBe('0.0.5');

    const reference = snapshot('0.0.5');
    reference.macroPackages.set('Logic.json', {
      version: '8', name: 'Logic', macros: { old: canonicalEntry('8') }
    });
    await migrateWorkspaceSnapshot(reference, canonicalize);
    const alreadyMigrated = snapshot('0.0.5');
    alreadyMigrated.macroPackages.set('Logic.json', {
      version: '8', name: 'Logic', macros: { old: canonicalEntry('8') }
    });
    alreadyMigrated.macroEntities.set(
      macroEntityPath('Logic', 'old'),
      structuredClone(reference.macroEntities.get(macroEntityPath('Logic', 'old'))!)
    );
    await expect(migrateWorkspaceSnapshot(alreadyMigrated, canonicalize))
      .resolves.toMatchObject({ to: '0.0.11' });
  });

  it('chains every historical migration and preserves unknown config fields', async () => {
    const data = snapshot('0.0.1');
    const canonicalizeMacroPackage = vi.fn(canonicalize);
    const report = await migrateWorkspaceSnapshot(data, canonicalizeMacroPackage);

    expect(report.applied).toEqual(
      WORKSPACE_DATA_MIGRATIONS.filter((step) => step.from !== '0.0.7' && step.from !== '0.0.8')
    );    expect(data.config.version).toBe('0.0.11');
    expect(data.config.vendor_extension).toEqual({ keep: true });
    const kind = (data.config.entry_kinds as Array<Record<string, unknown>>)[0];
    expect(kind).toMatchObject({
      id: 'theorem',
      name: 'Theorem',
      coloring: {
        light: { stroke: '#123456', background: '#123456' },
        dark: { stroke: '#123456', background: '#123456' }
      },
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
      coloring: {
        light: { stroke: '#abcdef', background: '#abcdef' },
        dark: { stroke: '#abcdef', background: '#abcdef' }
      },
      custom: 7
    });
    expect(data.macroPackages.get('Logic.json')).toMatchObject({
      version: '8',
      custom: 'package',
      macros: { old: { default_style: { en: 'default' } } }
    });
    expect(canonicalizeMacroPackage).toHaveBeenCalledTimes(3);
    expect(canonicalizeMacroPackage.mock.calls.map((call) => call[2])).toEqual(['7', '8', '11']);
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
    const unicodeCanonicalize = vi.fn((file: string, raw: unknown, version: '7' | '8' | '9' | '10' | '11') => {
      if (file === 'Logic.json') return canonicalize(file, raw, version);
      return {
        ...(raw as Record<string, unknown>), version,
        macros: {
          '群.是群🐈': version === '11'
            ? {
                ...unicodeEntry7,
                kind: 'const',
                styles: [{
                  style_name: '默认🐈',
                  template: { mode: 'formula_inline', body: 'old' },
                  tags: []
                }]
              }
            : {
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
    expect(report.applied.map((step) => step.from)).toEqual([
      '0.0.3', '0.0.4', '0.0.5', '0.0.6', '0.0.9', '0.0.10'
    ]);    expect(data.config.version).toBe('0.0.11');
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
