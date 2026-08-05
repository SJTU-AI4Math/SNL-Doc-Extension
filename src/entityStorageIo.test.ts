import { describe, expect, it } from 'vitest';
import {
  readEntryEntityRecord,
  readEntryEntityRecords,
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

describe('per-entity storage readers', () => {
  it('point-reads one Entry by stable ID without enumerating the directory', async () => {
    const wanted = makeEntryEnvelope('Logic', {
      id: 'Set.mem', package: 'Logic', title: 'Membership'
    });
    const unrelated = makeEntryEnvelope('_unpackaged', {
      id: 'Other', package: '_unpackaged', title: 'Other'
    });
    const storage = new MemoryReader(new Map([
      [entryEntityPath('Set.mem'), wanted],
      [entryEntityPath('Other'), unrelated]
    ]));

    const record = await readEntryEntityRecord(storage, 'Set.mem');

    expect(record?.entry.title).toBe('Membership');
    expect(storage.listings).toEqual([]);
    expect(storage.reads).toEqual([entryEntityPath('Set.mem')]);
  });

  it('validates paths and returns Entries in identity order', async () => {
    const a = makeEntryEnvelope('_unpackaged', { id: 'A', package: '_unpackaged', title: 'A' });
    const b = makeEntryEnvelope('_unpackaged', { id: 'B', package: '_unpackaged', title: 'B' });
    const z = makeEntryEnvelope('Alpha', { id: 'Z', package: 'Alpha', title: 'Z' });
    const storage = new MemoryReader(new Map([
      [entryEntityPath('B'), b],
      [entryEntityPath('Z'), z],
      [entryEntityPath('A'), a]
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
    const storage = new MemoryReader(new Map([
      [packageManifestPath('Logic'), manifest],
      [macroEntityPath('Logic', 'z'), makeMacroEnvelope('Logic', { name: 'z', styles: [] })],
      [macroEntityPath('Logic', 'a'), makeMacroEnvelope('Logic', { name: 'a', styles: [] })]
    ]));

    const packages = await readPackageManifestRecords(storage);
    const macros = await readMacroEntityRecords(storage);
    expect(packages).toEqual([{ path: packageManifestPath('Logic'), manifest }]);
    expect(macros.map(({ macro }) => macro.name)).toEqual(['a', 'z']);
  });

  it('rejects leading or trailing whitespace in persisted semantic identities', async () => {
    const entry = makeEntryEnvelope('_unpackaged', {
      id: ' A ', package: '_unpackaged', title: 'A'
    });
    await expect(readEntryEntityRecords(new MemoryReader(new Map([
      [entryEntityPath(' A '), entry]
    ])))).rejects.toThrow(/valid SNL Entry envelope/i);

    await expect(readEntryEntityRecords(new MemoryReader(new Map([
      [entryEntityPath('A'), {
        format: 'snl-entry', version: 1, package: ' bad/name ',
        entry: { id: 'A', package: ' bad/name ' }
      }]
    ])))).rejects.toThrow(/Package id/i);

    const macro = makeMacroEnvelope('Logic', { name: ' a ', styles: [] });
    await expect(readMacroEntityRecords(new MemoryReader(new Map([
      [macroEntityPath('Logic', ' a '), macro]
    ])))).rejects.toThrow(/valid SNL Macro envelope/i);
  });

  it('rejects duplicate logical identities and envelope/package disagreement', async () => {
    const duplicate = makeEntryEnvelope('_unpackaged', {
      id: 'A', package: '_unpackaged', title: 'A'
    });
    const values = new Map<string, unknown>([
      [entryEntityPath('A'), duplicate],
      ['entries/other-11111111111111111111.json', duplicate]
    ]);
    await expect(readEntryEntityRecords(new MemoryReader(values))).rejects.toThrow(/path|duplicate/i);

    const wrongPackage = makeMacroEnvelope('Logic', { name: 'a', styles: [] });
    values.clear();
    values.set(macroEntityPath('Other', 'a'), wrongPackage);
    await expect(readMacroEntityRecords(new MemoryReader(values))).rejects.toThrow(/path.*identity/i);
  });
});
