import { describe, expect, it } from 'vitest';
import {
  entryEntityPath,
  macroEntityPath,
  makeEntryEnvelope,
  makeMacroEnvelope,
  makePackageManifest,
  packageManifestPath
} from './entityStorage';
import {
  assertCurrentEntityFile,
  readEntryEntityRecord,
  readMacroEntityRecords,
  readPackageManifestRecord,
  entityFileRewriteChanges,
  rewriteEntryEntityRecord,
  rewriteMacroEntityRecord,
  rewritePackageManifestRecord,
  type EntityReadStorage
} from './entityStorageIo';

function withoutSchemaVersion<T extends { schema_version: number }>(value: T): Omit<T, 'schema_version'> {
  const { schema_version: _schemaVersion, ...legacy } = value;
  return legacy;
}

function mapStorage(values: ReadonlyMap<string, unknown>): EntityReadStorage {
  return {
    listJsonFiles: async (directory) => [...values.keys()]
      .filter((path) => path.startsWith(`${directory}/`))
      .map((path) => path.slice(directory.length + 1)),
    readJson: async (path) => values.get(path) ?? null
  };
}

const macro = {
  name: 'Eq',
  description: '',
  source: { entries: [], urls: [] },
  kind: 'const',
  dynamic_arity: false,
  styles: [{
    style_name: 'default',
    template: { mode: 'formula_inline', body: 'Eq' },
    tags: []
  }],
  tags: []
};

describe('legacy split-file schema compatibility', () => {
  it('normalizes files without schema_version in memory while preserving the exact disk snapshots', async () => {
    const entry = {
      id: 'entry-1', package: 'logic', kind: 'definition', title: 'One', content: { snl: '' }, pointer: null
    };
    const entryPath = entryEntityPath('logic', entry.id);
    const macroPath = macroEntityPath('logic', macro.name);
    const packagePath = packageManifestPath('logic');
    const legacyEntry = withoutSchemaVersion(makeEntryEnvelope('logic', entry));
    const legacyMacro = withoutSchemaVersion(makeMacroEnvelope('logic', macro));
    const legacyPackage = withoutSchemaVersion(makePackageManifest('logic', 'Logic', ''));
    const values = new Map<string, unknown>([
      [entryPath, legacyEntry],
      [macroPath, legacyMacro],
      [packagePath, legacyPackage]
    ]);
    const storage = mapStorage(values);

    const entryRecord = await readEntryEntityRecord(storage, 'logic', entry.id);
    const macroRecords = await readMacroEntityRecords(storage);
    const packageRecord = await readPackageManifestRecord(storage, 'logic');

    expect(entryRecord?.envelope.schema_version).toBe(1);
    expect(macroRecords[0].envelope.schema_version).toBe(1);
    expect(packageRecord?.manifest.schema_version).toBe(1);
    expect(entryRecord?.rawEnvelope).toBe(legacyEntry);
    expect(macroRecords[0].rawEnvelope).toBe(legacyMacro);
    expect(packageRecord?.rawManifest).toBe(legacyPackage);
    ((entryRecord!.envelope.entry.content as Record<string, unknown>)).snl = 'mutated projection';
    expect((
      ((legacyEntry.entry as Record<string, unknown>).content as Record<string, unknown>).snl
    )).toBe('');
    expect(Object.hasOwn(legacyEntry, 'schema_version')).toBe(false);
    expect(Object.hasOwn(legacyMacro, 'schema_version')).toBe(false);
    expect(Object.hasOwn(legacyPackage, 'schema_version')).toBe(false);
  });

  it('rejects a future per-file schema version at the ordinary read boundary', async () => {
    const entry = {
      id: 'entry-1', package: 'logic', kind: 'definition', title: 'One', content: { snl: '' }, pointer: null
    };
    const path = entryEntityPath('logic', entry.id);
    const storage = mapStorage(new Map<string, unknown>([[path, {
      ...makeEntryEnvelope('logic', entry),
      schema_version: 2
    }]]));

    await expect(readEntryEntityRecord(storage, 'logic', entry.id))
      .rejects.toThrow(/schema version 2 is newer/i);
  });

  it('requires complete current envelopes at the ordinary entity write barrier', () => {
    const entry = {
      id: 'entry-1', package: 'logic', kind: 'definition', title: 'One', content: { snl: '' }, pointer: null
    };
    const path = entryEntityPath('logic', entry.id);
    const current = makeEntryEnvelope('logic', entry);
    expect(() => assertCurrentEntityFile(path, current)).not.toThrow();
    expect(() => assertCurrentEntityFile(path, withoutSchemaVersion(current)))
      .toThrow(/current schema_version/i);
    expect(() => assertCurrentEntityFile(path, {
      ...current,
      entry: { ...entry, content: { snl: 1 } }
    })).toThrow(/content\.snl/i);
  });

  it('treats an explicit file schema marker as authoritative over a legacy workspace hint', async () => {
    const path = macroEntityPath('logic', macro.name);
    const current = makeMacroEnvelope('logic', macro);
    await expect(readMacroEntityRecords(mapStorage(new Map([[path, current]])), '8'))
      .resolves.toHaveLength(1);
    await expect(readMacroEntityRecords(
      mapStorage(new Map([[path, withoutSchemaVersion(current)]])),
      '8'
    )).rejects.toThrow(/styles\[0\]\.mode|canonical v8/i);
  });

  it('rewrites the complete modified file at the current schema while comparing against exact legacy bytes', async () => {
    const entry = {
      id: 'entry-1', package: 'logic', kind: 'definition', title: 'One', content: { snl: '' }, pointer: null
    };
    const legacyEntry = withoutSchemaVersion({
      ...makeEntryEnvelope('logic', entry),
      vendor_extension: { keep: 'entry' }
    });
    const legacyMacro = withoutSchemaVersion({
      ...makeMacroEnvelope('logic', macro),
      vendor_extension: { keep: 'macro' }
    });
    const legacyPackage = withoutSchemaVersion({
      ...makePackageManifest('logic', 'Logic', ''),
      vendor_extension: { keep: 'package' }
    });
    const storage = mapStorage(new Map<string, unknown>([
      [entryEntityPath('logic', entry.id), legacyEntry],
      [macroEntityPath('logic', macro.name), legacyMacro],
      [packageManifestPath('logic'), legacyPackage]
    ]));
    const entryRecord = (await readEntryEntityRecord(storage, 'logic', entry.id))!;
    const macroRecord = (await readMacroEntityRecords(storage))[0];
    const packageRecord = (await readPackageManifestRecord(storage, 'logic'))!;

    expect(entityFileRewriteChanges(
      rewriteEntryEntityRecord(entryRecord, 'logic', entry), entryRecord.envelope
    )).toBe(false);
    expect(entityFileRewriteChanges(
      rewriteMacroEntityRecord(macroRecord, 'logic', macro), macroRecord.envelope
    )).toBe(false);
    expect(entityFileRewriteChanges(
      rewritePackageManifestRecord(packageRecord, 'Logic', ''), packageRecord.manifest
    )).toBe(false);

    const entryRewrite = rewriteEntryEntityRecord(entryRecord, 'logic', { ...entry, title: 'Changed' });
    const macroRewrite = rewriteMacroEntityRecord(macroRecord, 'logic', { ...macro, description: 'Changed' });
    const packageRewrite = rewritePackageManifestRecord(packageRecord, 'Changed', 'Changed');

    expect(entityFileRewriteChanges(entryRewrite, entryRecord.envelope)).toBe(true);
    expect(entityFileRewriteChanges(macroRewrite, macroRecord.envelope)).toBe(true);
    expect(entityFileRewriteChanges(packageRewrite, packageRecord.manifest)).toBe(true);

    expect(entryRewrite.expected).toBe(legacyEntry);
    expect(macroRewrite.expected).toBe(legacyMacro);
    expect(packageRewrite.expected).toBe(legacyPackage);
    expect(entryRewrite.value).toMatchObject({ schema_version: 1, vendor_extension: { keep: 'entry' } });
    expect(macroRewrite.value).toMatchObject({ schema_version: 1, vendor_extension: { keep: 'macro' } });
    expect(packageRewrite.value).toMatchObject({
      schema_version: 1,
      name: 'Changed',
      description: 'Changed',
      vendor_extension: { keep: 'package' }
    });
  });
});
