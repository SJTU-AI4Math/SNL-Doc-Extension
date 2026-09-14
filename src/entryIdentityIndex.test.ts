import { expect, it } from 'vitest';
import { EntryIdentityIndex } from './entryIdentityIndex';
import { fixture } from './libraryPointRead.testSupport';
import { makePackageManifest, packageManifestPath } from './entityStorage';

it.each(['duplicate', 'missing-membership', 'bad-membership', 'old-schema', 'missing-active-owner', 'bad-config', 'old-version'])('rejects metadata %s without body fallback', async mode => {
  const f = await fixture(['alpha']); await f.pkg('alpha', ['A']);
  if (mode === 'duplicate') await f.pkg('beta', ['A']);
  if (mode === 'missing-membership') { const m: Record<string, unknown> = makePackageManifest('alpha', '', ''); delete m.entry_ids; await f.put(packageManifestPath('alpha'), m); }
  if (mode === 'bad-membership') await f.put(packageManifestPath('alpha'), { ...makePackageManifest('alpha', '', ''), entry_ids: ['B', 'A'] });
  if (mode === 'old-schema') await f.put(packageManifestPath('alpha'), { ...makePackageManifest('alpha', '', ''), schema_version: 1 });
  if (mode === 'missing-active-owner') await f.remove(packageManifestPath('alpha'));
  if (mode === 'bad-config') await f.put('config.json', { ...f.config, entity_storage: {} });
  if (mode === 'old-version') await f.put('config.json', { ...f.config, version: '0.0.5' });
  await expect(new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true }).snapshot()).rejects.toThrow();
  expect(f.calls.some(c => /^(entries|macros)\//.test(c.path))).toBe(false);
});

it('rebuilds after add/delete/move/missing-created and isolates roots', async () => {
  const f = await fixture([]); await f.pkg('alpha', ['A']);
  const index = new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true });
  const old = await index.snapshot(); expect(old.owners.has('New')).toBe(false);
  await f.pkg('beta', ['A', 'New']); await f.remove(packageManifestPath('alpha')); index.invalidate();
  const moved = await index.snapshot(); expect(moved.owners.get('A')).toBe('beta'); expect(moved.owners.get('New')).toBe('beta');
  expect(() => index.assertCurrent(old)).toThrow(/invalidated/);
  await f.pkg('beta', []); index.invalidate(); expect((await index.snapshot()).owners.has('A')).toBe(false);
  const g = await fixture([]); await g.pkg('other', ['A']);
  expect((await new EntryIdentityIndex('provider://other/same-path', g.provider, { allowEnoent: true }).snapshot()).owners.get('A')).toBe('other');
  expect((await index.snapshot()).owners.has('A')).toBe(false);
});

it('single-flights cold metadata and rejects publication invalidated while a manifest is in flight', async () => {
  const f = await fixture([]); await f.pkg('alpha', ['A']);
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
  let block = true;
  const index = new EntryIdentityIndex(f.root, { ...f.provider, async readFile(path) {
    const bytes = await f.provider.readFile(path);
    if (block && path.startsWith('packages/')) { block = false; entered(); await gate; }
    return bytes;
  } }, { allowEnoent: true });
  const first = index.snapshot(); expect(index.snapshot()).toBe(first);
  const rejected = expect(first).rejects.toThrow(/invalidated/);
  await started; await f.pkg('alpha', ['B']); index.invalidate();
  const fresh = await index.snapshot(); release(); await rejected;
  expect(fresh.owners.has('A')).toBe(false); expect(fresh.owners.get('B')).toBe('alpha');
  expect(await index.snapshot()).toBe(fresh);
});

it('cold ID-only index reads metadata but no unrelated or inactive-owner Entry bodies', async () => {
  const f = await fixture([]);
  await f.pkg('inactive', ['__proto__', '中文']); await f.ent('__proto__', '', 'inactive');
  const index = new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true });
  const snapshot = await index.snapshot();
  expect(snapshot.owners.get('__proto__')).toBe('inactive');
  expect(snapshot.owners.get('中文')).toBe('inactive');
  expect(f.calls.filter(c => c.path.startsWith('entries/'))).toEqual([]);
  expect(f.calls.filter(c => c.op === 'readDirectory')).toEqual([{ op: 'readDirectory', path: 'packages' }]);
});
