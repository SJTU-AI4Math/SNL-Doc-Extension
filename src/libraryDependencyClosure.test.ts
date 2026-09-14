import { expect, it } from 'vitest';
import { EntryIdentityIndex } from './entryIdentityIndex';
import { createLibraryPointReadSession } from './libraryPointRead';
import { readLibraryRenderClosure } from './libraryDependencyClosure';
import { fixture, entry, macro } from './libraryPointRead.testSupport';
import { collectLibraryRenderDependencies } from './libraryDependencyClosure';
import { readerDependencyClosure } from './sharedReaderSnapshot';
import { parseSnlSyntaxTree } from './snlBasicsHostCompat';
import type { FrozenOutlineNode } from './sharedReaderSnapshot';

it('uses canonical postfix rather than legacy mdata, exact IDs, binder/env and literal boundaries', () => {
  const snl = 'VisibleMacro(%Secret%, $Secret$, x@A.long, @bound)';
  const deps = collectLibraryRenderDependencies(snl);
  expect([...deps.entryIds]).toEqual(['A.long']);
  expect(deps.macroNames.has('VisibleMacro')).toBe(true);
  expect(deps.macroNames.has('Secret')).toBe(false);
  // Current frozen-reader semantics conservatively look up binder macro names too.
  // Preserve that source context rather than silently changing shared semantics.
  expect(deps.macroNames.has('bound')).toBe(true);
  const binder = entry('Binder', '@bound');
  const reference = readerDependencyClosure([{ nodeId: 'b', entry: binder, kind: null, counterLabel: null, children: [] }],
    [binder, entry('BinderSource')], { bound: macro('bound', ['BinderSource']) }, []);
  expect(reference.entries.map(e => e.id)).toContain('BinderSource');
  expect([...collectLibraryRenderDependencies('%Secret%').macroNames]).toEqual([]);
  const node = parseSnlSyntaxTree('x@A.long');
  expect(node.postfix).toMatchObject({ type: 'name', name: 'A.long' });
  expect(node.mdata ?? {}).not.toHaveProperty('src');
});
it('empty seeds read no bodies; parse errors are terminal', async () => {
  const f = await fixture(); await f.pkg('alpha', ['A']); await f.ent('A', 'Broken(');
  const s = await createLibraryPointReadSession(new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true }));
  expect((await readLibraryRenderClosure([], s)).entries.size).toBe(0);
  expect(f.calls.some(c => /^(entries|macros)\//.test(c.path))).toBe(false);
  await expect(readLibraryRenderClosure(['A'], s)).rejects.toThrow();
});
it('matches full native render closure but does not claim the final relation-navigation closure', async () => {
  const f = await fixture(); await f.pkg('alpha', ['A', 'B', 'Neighbor', 'Context', 'Source']);
  const all = [entry('A', 'M(x@B)'), entry('B'), entry('Neighbor', 'x@Context'), entry('Context'), entry('Source')];
  for (const e of all) await f.ent(e.id, e.content.snl);
  await f.mac('M', ['Source']);
  const outline: FrozenOutlineNode[] = [{ nodeId: 'root', entry: all[0], kind: null, counterLabel: null, children: [] }];
  const macros = { M: macro('M', ['Source']) };
  const full = readerDependencyClosure(outline, all, macros, []);
  const s = await createLibraryPointReadSession(new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true }));
  const partial = await readLibraryRenderClosure(['A'], s);
  expect([...partial.entries.keys()].sort()).toEqual(full.entries.map(e => e.id).sort());
  const navigable = readerDependencyClosure(outline, all, macros, [{ id: 'r', from: 'Neighbor', to: 'B', label: 'related', metadata: null }]);
  expect(navigable.entries.map(e => e.id)).toContain('Context');
  expect(partial.entries.has('Neighbor')).toBe(false);
});
it('invalidating metadata during a body read rejects stale closure publication', async () => {
  const f = await fixture(); await f.pkg('alpha', ['A']); await f.ent('A');
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }); const start = new Promise<void>(r => { entered = r; });
  const index = new EntryIdentityIndex(f.root, { ...f.provider, async readFile(path) {
    const bytes = await f.provider.readFile(path); if (path.startsWith('entries/')) { entered(); await gate; } return bytes;
  } }, { allowEnoent: true });
  const s = await createLibraryPointReadSession(index); const pending = readLibraryRenderClosure(['A'], s);
  const rejected = expect(pending).rejects.toThrow(/invalidated/);
  await start; index.invalidate(); release(); await rejected;
});

it('walks current postfix contexts, cycles and transitive cross-Package Macro sources once', async () => {
  const f = await fixture(['alpha']);
  await f.pkg('alpha', ['A', 'B', 'C']); await f.pkg('inactive', ['D']);
  await f.ent('A', 'M(x@B,x@MissingContext)'); await f.ent('B', 'x@C'); await f.ent('C', 'x@A'); await f.ent('D', 'Next()', 'inactive');
  await f.mac('M', ['D', 'Absent']); await f.mac('Next', ['A']);
  const session = await createLibraryPointReadSession(new EntryIdentityIndex(f.root, f.provider, { allowEnoent: true }));
  const result = await readLibraryRenderClosure(['A', 'A', 'MissingSeed'], session);
  expect([...result.entries.keys()].sort()).toEqual(['A', 'B', 'C', 'D']);
  expect([...result.missingEntryIds].sort()).toEqual(['Absent', 'MissingContext', 'MissingSeed']);
  expect(result.missingMacroNames.has('x')).toBe(true);
  expect(result.macroResults.get('x')?.candidates).toHaveLength(1);
  expect([...result.macros.keys()].sort()).toEqual(['M', 'Next']);
  expect(f.calls.filter(c => c.path.startsWith('entries/'))).toHaveLength(4);
  expect(result.kind).toBe('render-context');
  expect(result.receipts.every((r: {root: string}) => r.root === f.root)).toBe(true);
});
