import { describe, expect, it } from 'vitest';
import { makePackageManifest, packageManifestPath } from './entityStorage';
import { readPackageManifestRecords, type EntityReadStorage } from './entityStorageIo';

const fileFor = (id: string): string => packageManifestPath(id).slice('packages/'.length);

describe('entity storage reads', () => {
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
