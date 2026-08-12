import { describe, expect, it } from 'vitest';
import {
  entryEntityPath,
  makeEntryEnvelope,
  makePackageManifest,
  packageManifestPath
} from './entityStorage';
import {
  assertCurrentEntityStorageMetadata,
  readEntryEntityRecord,
  readEntryEntityRecordWithOwner,
  readPackageManifestRecords,
  type EntityReadStorage
} from './entityStorageIo';

const fileFor = (id: string): string => packageManifestPath(id).slice('packages/'.length);

describe('entity storage reads', () => {
  it('rejects current config with missing entity-storage metadata or receipt fields', () => {
    const receipt = {
      legacy_backup_present: false,
      legacy_entries_present: false,
      entry_count: 0,
      macro_package_count: 0,
      macro_count: 0,
      entries_digest: 'entries',
      macro_packages_digest: 'macros'
    };
    const valid = {
      version: '0.0.8',
      entity_storage: {
        version: 1,
        legacy_backup_version: '0.0.5',
        entry_default_package: '_unpackaged',
        receipt
      }
    };

    expect(() => assertCurrentEntityStorageMetadata(valid)).not.toThrow();
    expect(() => assertCurrentEntityStorageMetadata({ version: '0.0.8' }))
      .toThrow(/missing.*entity_storage/i);
    expect(() => assertCurrentEntityStorageMetadata({
      ...valid,
      entity_storage: { ...valid.entity_storage, receipt: { ...receipt, entries_digest: undefined } }
    })).toThrow(/metadata and receipt/i);
  });

  it('point-reads one Entry from its identity path without listing the directory', async () => {
    const entry = {
      id: 'entry-1', package: 'logic', kind: 'definition', title: 'One', content: { snl: '' }, pointer: null
    };
    const expectedPath = entryEntityPath(entry.package, entry.id);
    const reads: string[] = [];
    const storage: EntityReadStorage = {
      listJsonFiles: async () => {
        throw new Error('point reads must not list the entity directory');
      },
      readJson: async (path) => {
        reads.push(path);
        return makeEntryEnvelope(entry.package, entry);
      }
    };

    const record = await readEntryEntityRecord(storage, entry.package, entry.id);

    expect(reads).toEqual([expectedPath]);
    expect(record?.entry).toEqual(entry);
    expect(record?.path).toBe(expectedPath);
  });

  it('returns null only when the exact Entry entity file is absent', async () => {
    const storage: EntityReadStorage = {
      listJsonFiles: async () => [],
      readJson: async () => null
    };

    await expect(readEntryEntityRecord(storage, 'logic', 'missing')).resolves.toBeNull();
  });

  it('point-reads an Entry with a partial localized content map', async () => {
    const entry = {
      id: 'entry-1', package: 'logic', kind: 'definition', title: 'One',
      content: {
        text: { type: 'i18n', default_language: 'en', values: { 'zh-CN': '条目' } }
      },
      pointer: null
    };
    const path = entryEntityPath(entry.package, entry.id);
    const storage: EntityReadStorage = {
      listJsonFiles: async () => [],
      readJson: async (requested) => requested === path ? makeEntryEnvelope('logic', entry) : null
    };

    await expect(readEntryEntityRecord(storage, 'logic', 'entry-1'))
      .resolves.toMatchObject({ entry });
  });

  it('point-reads an Entry with a partial localized title map', async () => {
    const entry = {
      id: 'entry-title-i18n', package: 'logic', kind: 'definition',
      title: { type: 'i18n', default_language: 'en', values: { 'zh-CN': '局部标题' } },
      content: { snl: '' }, pointer: null
    };
    const path = entryEntityPath(entry.package, entry.id);
    const storage: EntityReadStorage = {
      listJsonFiles: async () => [],
      readJson: async (requested) => requested === path ? makeEntryEnvelope('logic', entry) : null
    };

    await expect(readEntryEntityRecord(storage, 'logic', entry.id))
      .resolves.toMatchObject({ entry });
  });

  it('point-rejects a current Entry whose canonical pointer field is missing', async () => {
    const entry = {
      id: 'entry-1', package: 'logic', kind: 'definition', title: 'One', content: { snl: '' }
    };
    const path = entryEntityPath(entry.package, entry.id);
    const storage: EntityReadStorage = {
      listJsonFiles: async () => [],
      readJson: async (requested) => requested === path ? makeEntryEnvelope('logic', entry) : null
    };

    await expect(readEntryEntityRecord(storage, 'logic', 'entry-1'))
      .rejects.toThrow(/canonical Entry payload/i);
  });

  it('point-validates the requested owner manifest without directory scans', async () => {
    const entry = {
      id: 'entry-1', package: 'logic', kind: 'definition', title: 'One', content: { snl: '' }, pointer: null
    };
    const entryPath = entryEntityPath(entry.package, entry.id);
    const manifestPath = packageManifestPath(entry.package);
    const reads: string[] = [];
    const storage: EntityReadStorage = {
      listJsonFiles: async () => {
        throw new Error('point reads must not list entity directories');
      },
      readJson: async (path) => {
        reads.push(path);
        if (path === entryPath) return makeEntryEnvelope(entry.package, entry);
        if (path === manifestPath) return makePackageManifest('logic', 'Logic', '', [entry.id]);
        return null;
      }
    };

    await expect(readEntryEntityRecordWithOwner(storage, 'logic', 'entry-1'))
      .resolves.toMatchObject({ entry });
    expect(reads).toEqual([entryPath, manifestPath]);
  });

  it('rejects an owner-matching Entry omitted from authoritative Package membership without scans', async () => {
    const entry = {
      id: 'hidden', package: 'logic', kind: 'definition', title: 'Hidden', content: { snl: '' }, pointer: null
    };
    const entryPath = entryEntityPath(entry.package, entry.id);
    const manifestPath = packageManifestPath(entry.package);
    const storage: EntityReadStorage = {
      listJsonFiles: async () => {
        throw new Error('membership authorization must not list entity directories');
      },
      readJson: async (path) => {
        if (path === entryPath) return makeEntryEnvelope(entry.package, entry);
        if (path === manifestPath) return makePackageManifest('logic', 'Logic', '', []);
        return null;
      }
    };

    await expect(readEntryEntityRecordWithOwner(storage, 'logic', entry.id))
      .rejects.toThrow(/membership|index|entry_ids/i);
  });

  it('rejects an orphan Entry whose requested owner manifest is missing', async () => {
    const entry = {
      id: 'entry-1', package: 'logic', kind: 'definition', title: 'One', content: { snl: '' }, pointer: null
    };
    const storage: EntityReadStorage = {
      listJsonFiles: async () => {
        throw new Error('point reads must not list entity directories');
      },
      readJson: async (path) => path.startsWith('entries/')
        ? makeEntryEnvelope('logic', entry)
        : null
    };

    await expect(readEntryEntityRecordWithOwner(storage, 'logic', 'entry-1'))
      .rejects.toThrow(/missing Package manifest.*logic/i);
  });

  it.each([
    ['format', { format: 'other', version: 1, package: 'logic', entry: { id: 'entry-1', package: 'logic' } }],
    ['version', { format: 'snl-entry', version: 2, package: 'logic', entry: { id: 'entry-1', package: 'logic' } }],
    ['envelope package', makeEntryEnvelope('other', { id: 'entry-1', package: 'other' })],
    ['entry package', makeEntryEnvelope('logic', { id: 'entry-1', package: 'other' })],
    ['entry id', makeEntryEnvelope('logic', { id: 'other', package: 'logic' })]
  ])('rejects a malformed point-read envelope with the wrong %s', async (_case, envelope) => {
    const storage: EntityReadStorage = {
      listJsonFiles: async () => [],
      readJson: async () => envelope
    };

    await expect(readEntryEntityRecord(storage, 'logic', 'entry-1')).rejects.toThrow();
  });

  it('reads entity JSON with bounded concurrency while preserving result order', async () => {
    const ids = Array.from({ length: 24 }, (_, i) => `pkg-${String(23 - i).padStart(2, '0')}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const storage: EntityReadStorage = {
      listJsonFiles: async () => ids.map(fileFor),
      readJson: async (path) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, path.length % 3 + 1));
        inFlight -= 1;
        const file = path.slice('packages/'.length);
        const id = ids.find((candidate) => fileFor(candidate) === file)!;
        return makePackageManifest(id, id, '');
      }
    };

    const records = await readPackageManifestRecords(storage);

    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(records.map(({ manifest }) => manifest.id)).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it('reports validation errors in directory-list order despite concurrent completion', async () => {
    const first = 'first';
    const second = 'second';
    const storage: EntityReadStorage = {
      listJsonFiles: async () => [fileFor(first), fileFor(second)],
      readJson: async (path) => {
        const isFirst = path.endsWith(fileFor(first));
        await new Promise((resolve) => setTimeout(resolve, isFirst ? 15 : 1));
        return { invalid: isFirst ? first : second };
      }
    };

    await expect(readPackageManifestRecords(storage)).rejects.toThrow(
      `packages/${fileFor(first)} is not a valid SNL Package manifest.`
    );
  });

  it('keeps disappearance errors strict under concurrent reads', async () => {
    const id = 'gone';
    const storage: EntityReadStorage = {
      listJsonFiles: async () => [fileFor(id)],
      readJson: async () => null
    };

    await expect(readPackageManifestRecords(storage)).rejects.toThrow(
      `Entity file disappeared while reading: packages/${fileFor(id)}.`
    );
  });
});
