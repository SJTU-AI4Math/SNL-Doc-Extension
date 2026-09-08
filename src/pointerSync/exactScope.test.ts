import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isStructuralPointer, normalizeEntryPointer, type EntryPointer } from './schema';
import { compilePointerScope, scopeContains } from './scope';
import { resolvePointerText } from './text';
import { buildPointerIndex, findNearestEntries, queryNearestEntries, updatePointerIndexText } from './index';
import { isPointerIndex, readPointerIndex, writePointerIndex } from './persistence';
import * as resolver from './resolve';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const legacyFields = [{}, { beforeLines: 1e12, afterLines: 1e12 },
  { beforeLines: -1, afterLines: -99 }, { beforeLines: 'bad', afterLines: null }];
it.each(legacyFields)('ignores obsolete fields without widening or invalidating: %j', legacy => {
  const text = 'prefix\r\nalpha beta\r\nsuffix';
  for (const exact of [
    { file: 'x', mode: 'lines' as const, line: 2, column: 7, endColumn: 11, priority: .5 },
    { file: 'x', mode: 'regex' as const, pattern: 'beta', priority: .5 },
  ]) {
    const pointer = { ...exact, ...legacy };
    expect(isStructuralPointer(pointer)).toBe(true);
    expect(normalizeEntryPointer(pointer)).toEqual(exact);
    const raw = resolvePointerText(pointer, text);
    expect(raw.status).toBe('ok');
    if (raw.status !== 'ok') throw Error('unresolved');
    const scope = compilePointerScope(pointer, raw.range, text);
    expect(scope).toMatchObject({ ...raw.range, priority: .5, span: 4, endInclusive: false });
    for (const [line, column, inside] of [[1, 1, false], [2, 6, false], [2, 7, true], [2, 10, true], [2, 11, false], [3, 1, false]] as const) {
      expect(scopeContains(scope, line, column)).toBe(inside);
    }
  }
});

it.each(legacyFields)('rejects v2 cache reads, writes, queries and reuse with matching fingerprints/provenance: %j', legacy => {
  return checkObsoleteCache(legacy);
});

async function checkObsoleteCache(legacy: object) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pointer-exact-')); roots.push(root);
  const text = 'before\ntarget\nafter';
  await fs.writeFile(path.join(root, 'x'), text);
  const entries = [{ id: 'a', pointer: { file: 'x', mode: 'lines', line: 2, ...legacy } }];
  const current = await buildPointerIndex(root, entries);
  const stale = structuredClone(current);
  Object.assign(stale, { version: 2 });
  // A valid old expanded scope must never become a v3 resolution through hash reuse.
  stale.files.x.entries[0].resolution = { status: 'ok', scope: {
    startLine: 1, startColumn: 1, endLine: 3, endColumn: 6, coveredEndLine: 3,
    startOffset: 0, endOffset: text.length, span: text.length, priority: 0, endInclusive: true,
  } };
  expect(isPointerIndex(stale)).toBe(false);
  expect(findNearestEntries(stale, 'x', 1, 1)).toEqual({ candidates: [], complete: false, unresolved: [] });
  expect(await queryNearestEntries(stale, 'x', 1)).toEqual({ candidates: [], complete: false, unresolved: [] });
  expect(await queryNearestEntries(stale, 'x', 1, text, 1)).toEqual({ candidates: [], complete: false, unresolved: [] });
  await expect(updatePointerIndexText(stale, 'x', text)).rejects.toThrow(/Obsolete/);
  await expect(writePointerIndex(root, stale)).rejects.toThrow(/Invalid/);
  await fs.mkdir(path.join(root, '.SNL_Doc'), { recursive: true });
  await fs.writeFile(path.join(root, '.SNL_Doc/syncSNL.json'), JSON.stringify(stale));
  expect(await readPointerIndex(root)).toBeUndefined();
  const spy = vi.spyOn(resolver, 'resolvePointerTextAsync');
  const rebuilt = await buildPointerIndex(root, entries, stale);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(rebuilt.version).toBe(3);
  expect(findNearestEntries(rebuilt, 'x', 1, 1).candidates).toEqual([]);
  expect(findNearestEntries(rebuilt, 'x', 2, 7).candidates.map(e => e.entryId)).toEqual(['a']);
  expect(rebuilt.files.x.entries[0].pointer).toEqual(entries[0].pointer);
  await writePointerIndex(root, rebuilt);
  expect(await readPointerIndex(root)).toEqual(rebuilt);
}

it.each([
  { file: 'x', mode: 'lines', line: 2, column: 1, endColumn: 1 },
  { file: 'x', mode: 'regex', pattern: '(?![\\s\\S])' },
  { file: 'x', mode: 'lines', line: 2 },
] satisfies EntryPointer[])('keeps zero-width/empty EOF exact without a buffer: %j', pointer => {
  const text = 'a\r\n';
  const raw = resolvePointerText(pointer, text);
  if (raw.status !== 'ok') throw Error(JSON.stringify(raw));
  const scope = compilePointerScope(pointer, raw.range, text);
  expect(scope).toMatchObject({ startLine: 2, endLine: 2, startOffset: 3, endOffset: 3, span: 0, endInclusive: true });
  expect(scopeContains(scope, 1, 2)).toBe(false);
  expect(scopeContains(scope, 2, 1)).toBe(true);
  expect(scopeContains(scope, 2, 2)).toBe(false);
});
