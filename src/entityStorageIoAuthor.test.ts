import { describe, expect, it } from 'vitest';
import {
  readEntryEntityRecord,
  readEntryEntityRecords,
  readMacroEntityRecord,
  readMacroEntityRecords,
  readPackageManifestRecord,
  readPackageManifestRecords,
  type EntityReadStorage
} from './entityStorageIo';
import {
  entryEntityPath,
  macroEntityPath,
  makeEntryEnvelope,
  makeMacroEnvelope,
  makePackageManifest,
  packageManifestPath
} from './entityStorage';

class MemoryReader implements EntityReadStorage {
  readonly reads: string[] = [];
  readonly listings: string[] = [];
  constructor(readonly values: Map<string, unknown>) {}
  async listJsonFiles(directory: string): Promise<string[]> {
    this.listings.push(directory);
    const prefix = `${directory}/`;
    return [...this.values.keys()]
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map((path) => path.slice(prefix.length))
      .sort();
  }
  async readJson(path: string): Promise<unknown | null> {
    this.reads.push(path);
    return this.values.has(path) ? structuredClone(this.values.get(path)) : null;
  }
}

function canonicalMacro(name: string): Record<string, unknown> {
  return {
    name,
    description: '',
    kind: 'const',
    dynamic_arity: false,
    source: { entries: [], urls: [] },
    tags: [],
    styles: [{ style_name: 'default', template: { mode: 'formula_inline', body: 'x' }, tags: [] }]
  };
}

function canonicalEntry(id: string, packageId: string, title = id): Record<string, unknown> {
  return { id, package: packageId, kind: 'theorem', title, content: {}, pointer: null };
}

async function checkedMacroPointRead(path: string, value: unknown) {
  const storage = new MemoryReader(new Map([[path, value]]));
  const before = structuredClone([...storage.values]);
  try { return await readMacroEntityRecord(storage, 'Logic', 'a'); }
  finally {
    expect(storage.listings).toEqual([]);
    expect(storage.reads).toEqual([path]);
    expect([...storage.values]).toEqual(before);
  }
}

describe('retained per-entity author reader oracles', () => {
  it('point-reads one Entry by current Package-qualified identity without enumerating the directory', async () => {
    const wanted = makeEntryEnvelope('Logic', {
      id: 'Set.mem', package: 'Logic', kind: 'theorem', title: 'Membership', content: {}, pointer: null
    });
    const unrelated = makeEntryEnvelope('_unpackaged', {
      id: 'Other', package: '_unpackaged', kind: 'theorem', title: 'Other', content: {}, pointer: null
    });
    const storage = new MemoryReader(new Map([
      [entryEntityPath('Logic', 'Set.mem'), wanted],
      [entryEntityPath('_unpackaged', 'Other'), unrelated]
    ]));

    const record = await readEntryEntityRecord(storage, 'Logic', 'Set.mem');

    expect(record?.entry.title).toBe('Membership');
    expect(storage.listings).toEqual([]);
    expect(storage.reads).toEqual([entryEntityPath('Logic', 'Set.mem')]);
  });

  it('validates paths and returns Entries in identity order', async () => {
    const a = makeEntryEnvelope('_unpackaged', canonicalEntry('A', '_unpackaged'));
    const b = makeEntryEnvelope('_unpackaged', canonicalEntry('B', '_unpackaged'));
    const z = makeEntryEnvelope('Alpha', canonicalEntry('Z', 'Alpha'));
    const storage = new MemoryReader(new Map([
      [entryEntityPath('_unpackaged', 'B'), b],
      [entryEntityPath('Alpha', 'Z'), z],
      [entryEntityPath('_unpackaged', 'A'), a]
    ]));
    const records = await readEntryEntityRecords(storage);
    expect(records.map(({ envelope, entry }) => [envelope.package, entry.id])).toEqual([
      ['_unpackaged', 'A'],
      ['_unpackaged', 'B'],
      ['Alpha', 'Z']
    ]);

    storage.values.set('entries/_unpackaged-00000000000000000000.json', a);
    await expect(readEntryEntityRecords(storage)).rejects.toThrow(/path.*identity/i);
  });

  it('point-reads one Package manifest without enumerating the directory', async () => {
    const manifest = makePackageManifest('Logic', 'Logic', 'desc');
    const storage = new MemoryReader(new Map([[packageManifestPath('Logic'), manifest]]));

    const record = await readPackageManifestRecord(storage, 'Logic');

    expect(record?.manifest).toEqual(manifest);
    expect(storage.listings).toEqual([]);
    expect(storage.reads).toEqual([packageManifestPath('Logic')]);
  });

  it('loads common Package manifests and Macro entities without filename-order semantics', async () => {
    const manifest = { ...makePackageManifest('Logic', 'Logic display', 'desc'), custom: 7 };
    const storage = new MemoryReader(new Map<string, unknown>([
      [packageManifestPath('Logic'), manifest],
      [macroEntityPath('Logic', 'z'), makeMacroEnvelope('Logic', canonicalMacro('z'))],
      [macroEntityPath('Logic', 'a'), makeMacroEnvelope('Logic', canonicalMacro('a'))]
    ]));

    const packages = await readPackageManifestRecords(storage);
    const macros = await readMacroEntityRecords(storage);
    expect(packages).toEqual([{ path: packageManifestPath('Logic'), manifest, rawManifest: manifest }]);
    expect(macros.map(({ macro }) => macro.name)).toEqual(['a', 'z']);
  });

  it('rejects leading or trailing whitespace in persisted semantic identities', async () => {
    const entry = makeEntryEnvelope('_unpackaged', canonicalEntry(' A ', '_unpackaged', 'A'));
    await expect(readEntryEntityRecords(new MemoryReader(new Map([
      [entryEntityPath('_unpackaged', ' A '), entry]
    ])))).rejects.toThrow(/valid SNL Entry envelope/i);

    await expect(readEntryEntityRecords(new MemoryReader(new Map([
      [entryEntityPath('_unpackaged', 'A'), {
        format: 'snl-entry', version: 1, schema_version: 1, package: ' bad/name ',
        entry: canonicalEntry('A', ' bad/name ')
      }]
    ])))).rejects.toThrow(/Package id/i);

    const macro = makeMacroEnvelope('Logic', canonicalMacro(' a '));
    await expect(readMacroEntityRecords(new MemoryReader(new Map([
      [macroEntityPath('Logic', ' a '), macro]
    ])))).rejects.toThrow(/valid SNL Macro envelope/i);
  });

  it('rejects duplicate logical identities and envelope/package disagreement', async () => {
    const duplicate = makeEntryEnvelope('_unpackaged', canonicalEntry('A', '_unpackaged'));
    const values = new Map<string, unknown>([
      [entryEntityPath('_unpackaged', 'A'), duplicate],
      ['entries/other-11111111111111111111.json', duplicate]
    ]);
    await expect(readEntryEntityRecords(new MemoryReader(values))).rejects.toThrow(/path|duplicate/i);

    const wrongPackage = makeMacroEnvelope('Logic', canonicalMacro('a'));
    values.clear();
    values.set(macroEntityPath('Other', 'a'), wrongPackage);
    await expect(readMacroEntityRecords(new MemoryReader(values))).rejects.toThrow(/path.*identity/i);
  });

  it('rejects malformed canonical Macro v11 payloads on point reads', async () => {
    const path = macroEntityPath('Logic', 'a');
    const malformed = makeMacroEnvelope('Logic', {
      ...canonicalMacro('a'),
      styles: [{ style_name: 'default', template: {
        type: 'i18n', default_language: 'en', values: { 'zh-CN': { mode: 'text', body: '坏' } }
      }, tags: [] }]
    });
    await expect(checkedMacroPointRead(path, malformed))
      .rejects.toThrow(/template/i);
  });

  it('rejects malformed typed Macro v11 fields on point reads', async () => {
    const path = macroEntityPath('Logic', 'a');
    const invalidMacros = [
      { ...canonicalMacro('a'), kind: 42 },
      {
        ...canonicalMacro('a'),
        styles: [{ style_name: 'default', tags: [], template: { mode: 'formula_inline', body: 'x',
          typst: { built_in: 7, synthesis: { mode: 'formula', macro: '' } } } }]
      },
      {
        ...canonicalMacro('a'),
        styles: [{ style_name: 'default', tags: [], template: { mode: 'formula_inline', body: 'x', markdown: 7 } }]
      }
    ];
    for (const macro of invalidMacros) {
      const malformed = makeMacroEnvelope('Logic', macro);
      await expect(checkedMacroPointRead(path, malformed))
        .rejects.toThrow(/kind|typst|markdown/i);
    }
  });

  it('rejects malformed required Entry payload fields on point reads', async () => {
    const path = entryEntityPath('_unpackaged', 'A');
    const malformed = makeEntryEnvelope('_unpackaged', {
      id: 'A', package: '_unpackaged', title: 'Missing kind and content', pointer: null
    });
    await expect(readEntryEntityRecord(new MemoryReader(new Map([[path, malformed]])), '_unpackaged', 'A'))
      .rejects.toThrow(/canonical Entry payload/i);
  });
});
