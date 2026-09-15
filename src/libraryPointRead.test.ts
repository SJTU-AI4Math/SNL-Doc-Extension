import { expect, it } from 'vitest';
import { EntryIdentityIndex } from './entryIdentityIndex';
import { createLibraryPointReadSession } from './libraryPointRead';
import { readLibraryRenderClosure } from './libraryDependencyClosure';
import { fixture, entry, macro } from './libraryPointRead.testSupport';
import { entryEntityPath, macroEntityPath, packageManifestPath, makeEntryEnvelope, makeMacroEnvelope } from './entityStorage';
import { strictPointReadStorage, type PointReadReceipt } from './libraryPointReadStorage';

it.each(['EACCES', 'EIO', 'Unavailable', 'ENOENT'])('propagates %s rather than misclassifying as missing', async code => {
  const error = Object.assign(new Error(code), { code });
  const receipts: PointReadReceipt[] = [];
  const storage = strictPointReadStorage({ async readFile() { throw error; }, async readDirectory() { throw error; } }, 'remote://root', 0, 'identity-metadata', receipts);
  await expect(storage.readJson('config.json')).rejects.toBe(error);
  await expect(storage.listJsonFiles('packages')).rejects.toBe(error);
  expect(receipts.map(r => r.outcome)).toEqual(['error', 'error']);
});
it.each(['FileNotFound', 'ENOENT'])('only explicit %s is a missing file; no stat call', async code => {
  const storage = strictPointReadStorage({ async readFile() { throw Object.assign(new Error('missing'), { code }); }, async readDirectory() { return []; } }, 'root', 0, 'body-point-read', [], { allowEnoent: true });
  expect(await storage.readJson('entries/missing.json')).toBeNull();
});
it('JSON null and malformed UTF8/JSON are corruption, not absence', async () => {
  for (const bytes of [Buffer.from('null'), Buffer.from('{'), new Uint8Array([255])]) {
    const storage = strictPointReadStorage({ async readFile() { return bytes; }, async readDirectory() { return []; } }, 'root', 0, 'body-point-read', []);
    await expect(storage.readJson('entries/bad.json')).rejects.toThrow();
  }
});
it.each(['missing-owner', 'membership-drift', 'body-owner', 'body-id', 'missing-body'])('diagnoses %s at exact Entry boundaries', async mode => {
  const f = await fixture([]); await f.pkg('alpha', ['A']); await f.ent('A');
  const index = new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true }); const s = await createLibraryPointReadSession(index);
  if (mode === 'missing-owner') await f.remove(packageManifestPath('alpha'));
  if (mode === 'membership-drift') await f.pkg('alpha', []);
  if (mode === 'body-owner') await f.put(entryEntityPath('alpha', 'A'), makeEntryEnvelope('beta', entry('A', '', 'beta')));
  if (mode === 'body-id') await f.put(entryEntityPath('alpha', 'A'), makeEntryEnvelope('alpha', entry('B')));
  if (mode === 'missing-body') {
    await f.remove(entryEntityPath('alpha', 'A'));
    expect(await s.readEntry('A')).toMatchObject({ missing: 'missing-entity', path: entryEntityPath('alpha', 'A') });
  } else await expect(s.readEntry('A')).rejects.toThrow(/owner|changed|match|package/i);
});
it.each(['envelope', 'package', 'name', 'source', 'template'])('rejects a relevant malformed Macro %s including shadowed candidates', async mode => {
  const f = await fixture(['alpha', 'zeta']); await f.pkg('alpha'); await f.pkg('zeta'); await f.mac('M', [], 'zeta');
  const m = macro('M');
  let raw: unknown = makeMacroEnvelope('alpha', m);
  if (mode === 'envelope') raw = {};
  if (mode === 'package') raw = makeMacroEnvelope('zeta', m);
  if (mode === 'name') raw = makeMacroEnvelope('alpha', macro('Other'));
  if (mode === 'source') raw = makeMacroEnvelope('alpha', { ...m, source: { entries: [42], urls: [] } });
  if (mode === 'template') raw = makeMacroEnvelope('alpha', { ...m, styles: [{ style_name: 'default', template: { mode: 'broken' }, tags: [] }] });
  await f.put(macroEntityPath('alpha', 'M'), raw);
  const s = await createLibraryPointReadSession(new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true }));
  await expect(s.readMacro('M')).rejects.toThrow();
});
it('preserves localized v11 templates and own-key names, tracks missing candidates, and reloads fresh bodies', async () => {
  const f = await fixture(['alpha', 'zeta']); await f.pkg('alpha', ['constructor', '__proto__', '中文']); await f.pkg('zeta');
  for (const id of ['constructor', '__proto__', '中文']) await f.ent(id);
  await f.put(macroEntityPath('alpha', '__proto__'), makeMacroEnvelope('alpha', { ...macro('__proto__'),
    styles: [{ style_name: 'default', template: { type: 'i18n', default_language: 'en', values: { en: { mode: 'formula_inline', body: 'hello' } } }, tags: [] }] }));
  const index = new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true });
  const s = await createLibraryPointReadSession(index);
  for (const id of ['constructor', '__proto__', '中文']) expect((await s.readEntry(id)).record?.entry.id).toBe(id);
  const m = await s.readMacro('__proto__'); expect(m.record?.macro.styles).toMatchObject([{ template: { type: 'i18n' } }]);
  expect(m.candidates.map(c => Boolean(c.record))).toEqual([true, false]);
  expect((await s.readMacro('Missing')).record).toBeNull();
  await f.mac('Missing', ['constructor'], 'zeta'); await f.ent('constructor', 'Changed()');
  const next = await createLibraryPointReadSession(index);
  expect((await next.readMacro('Missing')).record?.envelope.package).toBe('zeta');
  expect((await next.readEntry('constructor')).record?.entry.content).toEqual({ snl: 'Changed()' });
  expect(f.calls.filter(c => c.op === 'readDirectory')).toHaveLength(1);
});
it('new higher priority candidate and winner deletion fall back deterministically', async () => {
  const f = await fixture(['zeta', 'alpha']); await f.pkg('alpha'); await f.pkg('zeta'); await f.mac('M');
  const index = new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true });
  const read = async () => (await (await createLibraryPointReadSession(index)).readMacro('M')).record?.envelope.package;
  expect(await read()).toBe('alpha'); await f.mac('M', [], 'zeta'); expect(await read()).toBe('zeta');
  await f.remove(macroEntityPath('zeta', 'M')); expect(await read()).toBe('alpha');
});

it('does not increase body I/O when unrelated Entry/Macro bodies grow, including corruption', async () => {
  const counts: unknown[] = [];
  for (const unrelated of [0, 24, 100]) {
    const f = await fixture();
    const ids = Array.from({ length: unrelated }, (_, i) => `Unrelated${i}`);
    await f.pkg('alpha', ['A', ...ids]); await f.ent('A'); await f.mac('M');
    for (const id of ids) { await f.put(entryEntityPath('alpha', id), { corrupt: true }); await f.put(macroEntityPath('alpha', id), { corrupt: true }); }
    const s = await createLibraryPointReadSession(new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true }));
    await s.readEntry('A'); await s.readMacro('M');
    const count = { unrelated, metadataFileReads: s.identity.receipts.filter(r => r.op === 'readFile').length,
      metadataDirectories: s.identity.receipts.filter(r => r.op === 'readDirectory').length,
      bodyEntryReads: s.receipts.filter(r => r.path.startsWith('entries/')).length,
      bodyMacroReads: s.receipts.filter(r => r.path.startsWith('macros/')).length,
      bodyOwnerReads: s.receipts.filter(r => r.path.startsWith('packages/')).length,
      bodyDirectories: s.receipts.filter(r => r.op === 'readDirectory').length };
    expect(count).toEqual({ unrelated, metadataFileReads: 2, metadataDirectories: 1, bodyEntryReads: 1, bodyMacroReads: 1, bodyOwnerReads: 1, bodyDirectories: 0 });
    expect(s.receipts.every(r => r.revision?.length === 64)).toBe(true);
    counts.push(count);
  }
  console.info('FOUNDATION_IO', JSON.stringify(counts));
});
it('concurrent names completed in opposite order still use active file-order winners', async () => {
  const f = await fixture(['zeta', 'alpha']); await f.pkg('alpha'); await f.pkg('zeta');
  for (const name of ['M', 'N']) { await f.mac(name); await f.mac(name, [], 'zeta'); }
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }); const start = new Promise<void>(r => { entered = r; });
  const index = new EntryIdentityIndex(f.root, { ...f.provider, async readFile(path) {
    const bytes = await f.provider.readFile(path); if (path === macroEntityPath('alpha', 'M')) { entered(); await gate; } return bytes;
  } }, { allowEnoent: true });
  const s = await createLibraryPointReadSession(index);
  const m = s.readMacro('M'); await start;
  expect((await s.readMacro('N')).record?.envelope.package).toBe('zeta');
  release(); expect((await m).record?.envelope.package).toBe('zeta');
});
it('an unindexed requested miss recovers after manifest creation and epoch invalidation', async () => {
  const f = await fixture([]); await f.pkg('alpha');
  const index = new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true });
  const before = await createLibraryPointReadSession(index);
  expect(await before.readEntry('New')).toMatchObject({ id: 'New', missing: 'unindexed', path: null });
  await f.pkg('alpha', ['New']); await f.ent('New'); index.invalidate();
  await expect(before.readEntry('New')).rejects.toThrow(/invalidated/);
  expect((await (await createLibraryPointReadSession(index)).readEntry('New')).record?.entry.id).toBe('New');
});
it('point reads unique inactive-owner seeds and active-name candidates only', async () => {
  const f = await fixture(['zeta', 'alpha']);
  await f.pkg('inactive', ['A']); await f.pkg('alpha'); await f.pkg('zeta');
  await f.ent('A', '', 'inactive'); await f.mac('M'); await f.mac('M', ['A'], 'zeta');
  await f.put(macroEntityPath('inactive', 'M'), { corrupt: true });
  await f.put('entries/unrelated.json', { corrupt: true }); await f.put('macros/unrelated.json', { corrupt: true });
  const session = await createLibraryPointReadSession(new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true }));
  expect((await session.readEntry('A')).record?.entry.id).toBe('A');
  await session.readEntry('A');
  const m = await session.readMacro('M');
  expect(m.record?.envelope.package).toBe('zeta');
  expect(m.candidates.map((c: { packageId: string }) => c.packageId)).toEqual(['alpha', 'zeta']);
  expect(f.calls.filter(c => c.path.startsWith('entries/'))).toHaveLength(1);
  expect(f.calls.filter(c => c.path.startsWith('macros/'))).toHaveLength(2);
});

// Preserve the original config-only negative admission order under Package2.
it('preserves B,A,B,missing order, FILE winners and seeded cycles with 100 unrelated bodies', async () => {
  const f = await fixture(['core', 'core-extra']);
  const unrelated = Array.from({ length: 100 }, (_, i) => `Unrelated${i}`);
  await f.pkg('inactive', ['A', ...unrelated]); await f.pkg('_unpackaged', ['B', 'C']);
  await f.pkg('core'); await f.pkg('core-extra');
  await f.ent('A', 'x@B', 'inactive'); await f.ent('B', 'y@C', '_unpackaged'); await f.ent('C', 'z@A', '_unpackaged');
  await f.mac('Eq', ['A'], 'core'); await f.mac('Eq', ['B'], 'core-extra');
  for (const id of unrelated) {
    await f.put(entryEntityPath('inactive', id), { corrupt: true });
    await f.put(macroEntityPath('core', id), { corrupt: true });
  }
  const s = await createLibraryPointReadSession(new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true }));
  expect(s.identity.receipts.filter(r => r.op === 'readDirectory').map(r => r.path)).toEqual(['packages']);
  expect(s.identity.receipts.filter(r => r.op === 'readFile')).toHaveLength(5);
  const requested = [];
  for (const id of ['B', 'A', 'B', 'missing']) requested.push(await s.readEntry(id));
  expect(requested.map(r => r.record?.entry.id ?? null)).toEqual(['B', 'A', 'B', null]);
  expect([...new Map(requested.filter(r => r.record).map(r => [r.id, r.record!.entry])).keys()]).toEqual(['B', 'A']);
  expect(requested[2]).toBe(requested[0]);
  expect(requested[3]).toEqual({ id: 'missing', packageId: null, path: null, record: null, missing: 'unindexed' });
  expect(f.calls.filter(c => c.path.startsWith('entries/')).map(c => c.path)).toEqual([
    entryEntityPath('_unpackaged', 'B'), entryEntityPath('inactive', 'A')
  ]);
  const offset = f.calls.length;
  const closure = await readLibraryRenderClosure(['A'], s);
  expect([...closure.entries.keys()]).toEqual(['A', 'B', 'C']);
  expect([...closure.requestedEntryIds].sort()).toEqual(['A', 'B', 'C']);
  expect([...closure.requestedMacroNames].sort()).toEqual(['x', 'y', 'z']);
  expect(f.calls.slice(offset).filter(c => c.path.startsWith('entries/')).map(c => c.path)).toEqual([entryEntityPath('_unpackaged', 'C')]);
  const macros = await Promise.all(['Eq', 'missing', 'Eq'].map(name => s.readMacro(name)));
  expect(macros[0].candidates.map(c => c.packageId)).toEqual(['core-extra', 'core']);
  expect(macros[0].record?.macro).toMatchObject({ source: { entries: ['A'] } });
  expect(macros[0].record?.envelope.package).toBe('core');
  expect(macros[2]).toBe(macros[0]);
  expect(macros[1].record).toBeNull();
  expect(macros[1].candidates.map(c => c.record)).toEqual([null, null]);
  expect(f.calls.filter(c => c.op === 'readDirectory')).toEqual([{ op: 'readDirectory', path: 'packages' }]);
  expect(f.calls.filter(c => c.path.startsWith('entries/'))).toHaveLength(3);
  for (const name of ['Eq', 'missing', 'x', 'y', 'z']) {
    for (const owner of ['core-extra', 'core']) {
      expect(f.calls.filter(c => c.path === macroEntityPath(owner, name))).toHaveLength(1);
    }
  }
  expect(f.calls.filter(c => c.path.startsWith('macros/'))).toHaveLength(10);
});

it.each(['wrong-type', 'whitespace', 'unsafe-id', 'case-fold'] as const)('rejects %s active config before any Package listing', async defect => {
  const f = await fixture([]);
  const active = defect === 'wrong-type' ? 'Logic' : defect === 'whitespace' ? [' Logic '] : defect === 'unsafe-id' ? ['bad/name'] : ['Logic', 'logic'];
  await f.put('config.json', { ...f.config, active_macro_packages: active });
  await expect(new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true }).snapshot()).rejects.toThrow(/active_macro_packages|Package|case-fold/);
  expect(f.calls).toEqual([{ op: 'readFile', path: 'config.json' }]);
});
