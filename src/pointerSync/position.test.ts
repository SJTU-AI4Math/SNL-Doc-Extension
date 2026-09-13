import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPointerIndex, findNearestEntries, updatePointerIndexText } from './index';
import { readPointerIndex, writePointerIndex, isPointerIndex } from './persistence';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => fs.rm(r, { recursive: true, force: true }))); });
it('uses the exact UTF16 cursor and lets priority in a containing scope beat a smaller hit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pointer-position-')); roots.push(root);
  await fs.writeFile(path.join(root, 'x'), 'alpha beta\nother');
  const index = await buildPointerIndex(root, [
    { id: 'alpha', pointer: { file: 'x', mode: 'regex', pattern: 'alpha', beforeLines: 0, afterLines: 0 } },
    { id: 'beta', pointer: { file: 'x', mode: 'regex', pattern: 'beta', beforeLines: 0, afterLines: 0 } },
  ]);
  expect(findNearestEntries(index, 'x', 1, 7).candidates.map(x => x.entryId)).toEqual(['beta']);
  expect(findNearestEntries(index, 'x', 1, 6).candidates).toEqual([]);
  const prioritized = await buildPointerIndex(root, [
    { id: 'raw', pointer: { file: 'x', mode: 'regex', pattern: 'alpha', beforeLines: 0, afterLines: 0 } },
    { id: 'wide', pointer: { file: 'x', mode: 'lines', line: 1, endLine: 2, priority: 0.5 } },
  ]);
  expect(findNearestEntries(prioritized, 'x', 1, 2).candidates.map(x => x.entryId)).toEqual(['wide']);
  await writePointerIndex(root, prioritized);
  const restored = (await readPointerIndex(root))!;
  expect(findNearestEntries(restored, 'x', 1, 2).candidates.map(x => x.entryId)).toEqual(['wide']);
  expect(restored.files.x.entries.every(e => !('range' in e.resolution))).toBe(true);
  const stale = { ...restored, version: 2 } as unknown as typeof restored;
  expect(isPointerIndex(stale)).toBe(false);
  expect(findNearestEntries(stale, 'x', 1, 2).complete).toBe(false);
  const rebuilt = await buildPointerIndex(root, [{ id:'new', pointer:{file:'x',mode:'lines',line:1,column:7,endColumn:11,beforeLines:0,afterLines:0} }], stale);
  expect(findNearestEntries(rebuilt,'x',1,7).candidates.map(x=>x.entryId)).toEqual(['new']);
  const dirty = await updatePointerIndexText(rebuilt,'x','alpha beta\nchanged');
  const reused = await updatePointerIndexText(dirty,'x','alpha beta\nchanged');
  expect(reused.files.x.entries[0].resolution).toBe(dirty.files.x.entries[0].resolution);
  // Query must not consult provenance at all.
  Object.defineProperty(reused.files.x.entries[0], 'pointer', { get() { throw Error('raw pointer queried'); } });
  expect(findNearestEntries(reused,'x',1,7).candidates.map(x=>x.entryId)).toEqual(['new']);
});
