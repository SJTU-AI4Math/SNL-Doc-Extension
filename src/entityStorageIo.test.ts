import { describe, expect, it } from 'vitest';
import {
  entryEntityPath,
  makeEntryEnvelope,
  makePackageManifest,
  packageManifestPath
} from './entityStorage';
import {
  readEntryEntityRecord,
  readPackageManifestRecords,
  type EntityReadStorage
} from './entityStorageIo';

const fileFor = (id: string): string => packageManifestPath(id).slice('packages/'.length);

describe('entity storage reads', () => {
  it('point-reads one Entry from its identity path without listing the directory', async () => {
    const entry = { id: 'entry-1', package: 'logic', kind: 'definition', title: 'One' };
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
