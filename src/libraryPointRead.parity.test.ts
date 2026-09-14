import { expect, it, vi } from 'vitest';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';

// Existing Host native-file transport seam (as in dependencyCacheHost.test).
// No Host reader, normalizer, validator or frozen closure is substituted.
vi.mock('vscode', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const uri = (p: string): any => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` });
  return {
    FileType: { File: 1, Directory: 2 },
    Uri: { file: uri, joinPath: (base: any, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
    workspace: { fs: {
      stat: async (u: any) => { const s = await fs.stat(u.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; },
      readFile: (u: any) => fs.readFile(u.fsPath),
      readDirectory: async (u: any) => (await fs.readdir(u.fsPath, { withFileTypes: true })).map(d => [d.name, d.isDirectory() ? 2 : 1])
    } },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) }
  };
});
import { readAllMacros, readEntries } from './snlDoc';
import { readerDependencyClosure } from './sharedReaderSnapshot';
import { fixture, macro } from './libraryPointRead.testSupport';
import { makeMacroEnvelope, macroEntityPath, entryEntityPath, makePackageManifest, packageManifestPath } from './entityStorage';
import { EntryIdentityIndex } from './entryIdentityIndex';
import { createLibraryPointReadSession } from './libraryPointRead';
import { readLibraryRenderClosure, collectLibraryRenderDependencies, collectLibraryRenderTreeDependencies } from './libraryDependencyClosure';
import { parseSnlSyntaxTree } from './snlBasicsHostCompat';
import { resolveSnlSemantics } from '@sjtu-ai4math/snl-basics';

// Move the same canonical files under the Host's real .SNL_Doc root. Both
// transports resolve to the identical paths, not parallel in-memory fixtures.
async function hostFixture() {
  const f = await fixture();
  await f.put('config.json', { ...f.config, entry_kinds: [], macro_kinds: [] });
  await f.pkg('alpha', ['Seed', 'A']); await f.ent('Seed', 'M()'); await f.ent('A', 'Never()'); await f.mac('M');
  await mkdir(join(f.root, '.SNL_Doc'));
  for (const p of ['config.json', 'packages', 'entries', 'macros']) await rename(join(f.root, p), join(f.root, '.SNL_Doc', p));
  return { ...f, uri: vscode.Uri.file(f.root),
    putMacro: (value: unknown) => f.put('.SNL_Doc/' + macroEntityPath('alpha', 'M'), value),
    async session() {
      return createLibraryPointReadSession(new EntryIdentityIndex(join(f.root, '.SNL_Doc'), {
        readFile: p => f.provider.readFile('.SNL_Doc/' + p),
        readDirectory: async p => {
          // Preserve the strict point transport's prohibition on body enumeration.
          if (p !== 'packages') throw new Error('Full body enumeration forbidden');
          const fs = await import('node:fs/promises');
          f.calls.push({ op: 'readDirectory', path: '.SNL_Doc/' + p });
          return (await fs.readdir(join(f.root, '.SNL_Doc', p), { withFileTypes: true })).map(d => [d.name, d.isFile() ? 1 : 2]);
        }
      }, { allowEnoent: true }));
    }
  };
}
it.each(['absent', 'explicit-unpackaged'])('actual Host activation parity: %s', async variant => {
  const f = await hostFixture();
  await f.put('.SNL_Doc/' + packageManifestPath('_unpackaged'), makePackageManifest('_unpackaged', 'Unpackaged', '', []));
  await f.put('.SNL_Doc/' + macroEntityPath('_unpackaged', 'Hidden'), makeMacroEnvelope('_unpackaged', macro('Hidden')));
  const { active_macro_packages: _active, ...config } = f.config;
  await f.put('.SNL_Doc/config.json', { ...config, entry_kinds: [], macro_kinds: [],
    ...(variant === 'explicit-unpackaged' ? { active_macro_packages: ['alpha', '_unpackaged'] } : {}) });
  expect(Object.keys(await readAllMacros(f.uri))).toEqual(['M']);
  const session = await f.session();
  expect(session.identity.activePackages).toEqual(['alpha']);
  expect((await session.readMacro('Hidden')).record).toBeNull();
  expect(f.calls.some(c => c.path === '.SNL_Doc/' + macroEntityPath('_unpackaged', 'Hidden'))).toBe(false);
});
it.each(['future-version', 'missing-receipt', 'null-config'])('empty seeds cannot bypass %s metadata validation', async variant => {
  const f = await hostFixture();
  const config = { ...f.config, entry_kinds: [], macro_kinds: [] };
  await f.put('.SNL_Doc/config.json', variant === 'null-config' ? null : variant === 'future-version'
    ? { ...config, version: '999.0.0' } : { ...config, entity_storage: {} });
  // The whole Macro reader does not gate the receipt; the point session does.
  if (variant === 'missing-receipt') expect((await readAllMacros(f.uri)).M).toBeDefined();
  else await expect(readAllMacros(f.uri)).rejects.toThrow();
  const closure = async () => readLibraryRenderClosure([], await f.session());
  await expect(closure()).rejects.toThrow();
  expect(f.calls.some(c => /\/(entries|macros)\//.test(c.path))).toBe(false);
});
it.each(['x@#0', 'x@#bound', 'x[en]'])('native non-Entry postfix/style %s does not read Entry contexts', async snl => {
  const f = await hostFixture();
  await f.put('.SNL_Doc/' + entryEntityPath('alpha', 'Seed'), { format: 'snl-entry', version: 1, schema_version: 1, package: 'alpha',
    entry: { id: 'Seed', package: 'alpha', kind: 'definition', title: 'Seed', content: { snl }, pointer: null } });
  expect([...collectLibraryRenderDependencies(snl).entryIds]).toEqual([]);
  const all = await readEntries(f.uri);
  const frozen = readerDependencyClosure([{ nodeId: 's', entry: all.find(e => e.id === 'Seed')!, kind: null, counterLabel: null, children: [] }], all, await readAllMacros(f.uri), []);
  const result = await readLibraryRenderClosure(['Seed'], await f.session());
  expect([...result.entries.keys()]).toEqual(frozen.entries.map(e => e.id));
  expect(f.calls.filter(c => c.path.includes('/entries/'))).toHaveLength(1);
});
it('native language-looking suffix is a name, not a nonexistent language postfix variant', () => {
  expect(parseSnlSyntaxTree('x@en').postfix).toEqual({ type: 'name', name: 'en' });
  expect([...collectLibraryRenderDependencies('x@en').entryIds]).toEqual(['en']);
  expect(parseSnlSyntaxTree('x[en]').style_name).toBe('en');
});
it('collects real resolved source AST independently of the parser postfix', () => {
  const parsed = parseSnlSyntaxTree('x@A');
  expect(parsed.source).toBeUndefined();
  const resolved = resolveSnlSemantics(parsed, {}).tree;
  expect(resolved.source).toEqual({ type: 'entry', entry_id: 'A' });
  // Strip only redundant syntax to make the canonical resolved-source branch
  // load-bearing; the source itself is produced by the actual resolver.
  const { postfix: _postfix, ...sourceOnly } = resolved;
  expect([...collectLibraryRenderTreeDependencies(sourceOnly).entryIds]).toEqual(['A']);
});
const modes = ['formula_inline', 'formula_display', 'text', 'block'];
const variants = ['flat', 'localized-default', 'localized-secondary'];
function template(mode: unknown, variant: string) {
  const projection = { mode, body: 'M' };
  if (variant === 'flat') return projection;
  return { type: 'i18n', default_language: 'en', values: {
    en: variant === 'localized-default' ? projection : { mode: 'formula_inline', body: 'M' },
    zh: variant === 'localized-secondary' ? projection : { mode: 'text', body: 'M' }
  } };
}
for (const mode of modes) for (const variant of variants) {
  it(`R1 actual whole Host and single reader reject array mode ${mode}/${variant}`, async () => {
    const f = await hostFixture();
    const m = macro('M');
    const raw = (value: unknown) => makeMacroEnvelope('alpha', { ...m, styles: [
      ...m.styles.map(s => ({ ...s, style_name: 'first' })),
      { style_name: 'target', tags: [], template: template(value, variant) }
    ] });
    // Positive control first: fixture must reach and pass the real Host validator.
    await f.putMacro(raw(mode));
    expect((await readAllMacros(f.uri)).M.styles).toHaveLength(2);
    expect((await (await f.session()).readMacro('M')).record).not.toBeNull();
    await f.putMacro(raw([mode]));
    await expect(readAllMacros(f.uri)).rejects.toThrow(/invalid mode/);
    await expect((await f.session()).readMacro('M')).rejects.toThrow(/mode/);
  });
}
it.each(['', ' ', ' \t\n ', ' A ', '\0'])('R2 validated raw source %j is an exact miss, with no extra body I/O', async rawId => {
  const f = await hostFixture();
  await f.putMacro(makeMacroEnvelope('alpha', macro('M', [rawId, rawId])));
  const allEntries = await readEntries(f.uri);
  const allMacros = await readAllMacros(f.uri);
  expect(allMacros.M.source.entries).toEqual([rawId, rawId]);
  const seed = allEntries.find(e => e.id === 'Seed')!;
  const frozen = readerDependencyClosure([{ nodeId: 'seed', entry: seed, kind: null, counterLabel: null, children: [] }], allEntries, allMacros, []);
  expect(frozen.entries.map(e => e.id)).toEqual(['Seed']);
  f.calls.length = 0;
  const session = await f.session();
  const point = await readLibraryRenderClosure(['Seed'], session);
  expect([...point.entries.values()].map(r => r.entry)).toEqual(frozen.entries);
  expect(Object.fromEntries([...point.macros].map(([k, r]) => [k, r.macro]))).toEqual(frozen.macros);
  expect([...point.requestedEntryIds]).toEqual(['Seed', rawId]);
  expect([...point.missingEntryIds]).toEqual([rawId]);
  expect(point.entryResults.get(rawId)).toEqual({ id: rawId, packageId: null, path: null, record: null, missing: 'unindexed' });
  expect(f.calls.filter(c => c.path.includes('/entries/')).map(c => c.path)).toEqual(['.SNL_Doc/' + entryEntityPath('alpha', 'Seed')]);
  expect(f.calls.filter(c => c.path.includes('/macros/')).map(c => c.path)).toEqual(['.SNL_Doc/' + macroEntityPath('alpha', 'M')]);
  const before = [...f.calls];
  await expect(session.readEntry(rawId)).rejects.toThrow(/canonical/);
  expect(f.calls).toEqual(before);
});
it.each(['envelope', 'numeric-source'])('actual Host and point closure both reject %s corruption', async variant => {
  const f = await hostFixture();
  await f.putMacro(variant === 'envelope' ? {} : makeMacroEnvelope('alpha', { ...macro('M'), source: { entries: [42], urls: [] } }));
  await expect(readAllMacros(f.uri)).rejects.toThrow();
  await expect(readLibraryRenderClosure(['Seed'], await f.session())).rejects.toThrow();
});
