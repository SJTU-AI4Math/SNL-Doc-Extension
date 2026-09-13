import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPointerIndex, findNearestEntries, updatePointerIndexText, queryNearestEntries } from './index';
import * as resolver from './resolve';

it('compiles exact scopes without legacy or default expansion and returns all smallest-span ties', async () => {
  await fs.writeFile(path.join(root, 'x'), Array(60).fill('line').join('\n'));
  const index = await buildPointerIndex(root, [
    { id: 'wide', pointer: { file: 'x', mode: 'lines', line: 20, endLine: 25, beforeLines: 0, afterLines: 2 } },
    { id: 'narrow-b', pointer: { file: 'x', mode: 'lines', line: 22, beforeLines: 0, afterLines: 0 } },
    { id: 'narrow-a', pointer: { file: 'x', mode: 'lines', line: 22, beforeLines: 0, afterLines: 0 } },
    { id: 'default', pointer: { file: 'x', mode: 'lines', line: 50 } }
  ]);
  expect(findNearestEntries(index, 'x', 19).candidates).toEqual([]);
  expect(findNearestEntries(index, 'x', 22).candidates.map(c => c.entryId)).toEqual(['narrow-a', 'narrow-b']);
  expect(findNearestEntries(index, 'x', 25).candidates).toMatchObject([{ entryId: 'wide', distance: 0 }]);
  expect(findNearestEntries(index, 'x', 26).candidates).toEqual([]);
  expect(findNearestEntries(index, 'x', 27).candidates).toEqual([]);
  expect(findNearestEntries(index, 'x', 28).candidates).toEqual([]);
  expect(findNearestEntries(index, 'x', 35).candidates).toEqual([]);
  expect(findNearestEntries(index, 'x', 49).candidates).toEqual([]);
  expect(findNearestEntries(index, 'x', 50).candidates).toMatchObject([{ entryId: 'default', distance: 0 }]);
  expect(findNearestEntries(index, 'x', 51).candidates).toEqual([]);
  expect(findNearestEntries(index, 'x', 34).candidates).toEqual([]);
  expect(findNearestEntries(index, 'x', 60).candidates).toEqual([]);
  expect(findNearestEntries(index, 'x', 65).candidates).toEqual([]);
  expect(findNearestEntries(index, 'x', 66).candidates).toEqual([]);
});

it('never defaults an omitted legacy threshold for regex pointers', async () => {
  await fs.writeFile(path.join(root, 'x'), Array(40).fill('line').join('\n'));
  for (const thresholds of [{ beforeLines: 0 }, { afterLines: 0 }]) {
    const index = await buildPointerIndex(root, [{ id: 'a', pointer: {
      file: 'x', mode: 'regex', pattern: 'line', occurrence: 20, ...thresholds
    } }]);
    expect(findNearestEntries(index, 'x', 5).candidates).toEqual([]);
    expect(findNearestEntries(index, 'x', 35).candidates).toEqual([]);
    expect(findNearestEntries(index, 'x', 19).candidates).toEqual([]);
    expect(findNearestEntries(index, 'x', 21).candidates).toEqual([]);
    expect(findNearestEntries(index, 'x', 20).candidates).toMatchObject([{ entryId: 'a', distance: 0 }]);
  }
});

it('marks unknown same-file ranges incomplete, but does not search unrelated entries', async () => {
  await fs.writeFile(path.join(root, 'x'), 'line');
  const index = await buildPointerIndex(root, [
    { id: 'ok', pointer: { file: 'x', mode: 'lines', line: 1 } },
    { id: 'invalid', pointer: { file: 'x', mode: 'regex', pattern: '[' } },
    { id: 'missing', pointer: { file: 'y', mode: 'lines', line: 1 } }
  ]);
  Object.defineProperty(index.files, 'y', { get: () => { throw new Error('unrelated bucket accessed'); } });
  expect(findNearestEntries(index, 'x', 1)).toMatchObject({ complete: false,
    candidates: [{ entryId: 'ok' }], unresolved: [{ entryId: 'invalid', resolution: { status: 'invalid-regex' } }] });
});

let root: string;
it.each([true, false])('sorts every winning tie from shuffled buckets and preserves complete=%s', async complete => {
  await fs.writeFile(path.join(root, 'x'), 'line');
  const identities = [{ id: 'ä' }, { id: 'Z', package: 'ä' }, { id: 'Z', package: 'Z' }, { id: 'Z' }];
  const index = await buildPointerIndex(root, [
    ...identities.map(identity => ({ ...identity, pointer: { file: 'x', mode: 'lines', line: 1 } })),
    ...(!complete ? [{ id: 'unknown', pointer: { file: 'x', mode: 'regex', pattern: '[' } }] : []),
  ]);
  const entries = index.files.x.entries;
  index.files.x.entries = identities.map(identity => entries.find(entry => entry.entryId === identity.id && entry.package === identity.package)!);
  if (!complete) index.files.x.entries.push(entries.find(entry => entry.entryId === 'unknown')!);
  for (const result of [findNearestEntries(index, 'x', 1, 1), await queryNearestEntries(index, 'x', 1, 'line', 1)]) {
    expect(result.complete).toBe(complete);
    expect(result.candidates.map(c => [c.entryId, c.package ?? ''])).toEqual([
      ['Z', ''], ['Z', 'Z'], ['Z', 'ä'], ['ä', ''],
    ]);
    expect(result.unresolved).toHaveLength(complete ? 0 : 1);
  }
});
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'snl-index-'));
  await fs.mkdir(path.join(root, '.SNL_Doc'));
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it('reuses hash+pointer identity without rerunning unrelated regex, including after metadata changes', async () => {
  await fs.writeFile(path.join(root, 'x'), 'α\nβ');
  await fs.writeFile(path.join(root, 'y'), 'unrelated');
  const entries = [
    { id: 'a', title: 'old', pointer: { file: 'x', mode: 'regex', pattern: 'α' } },
    { id: 'b', pointer: { file: 'x', mode: 'regex', pattern: 'β' } },
    { id: 'c', pointer: { file: 'y', mode: 'regex', pattern: 'unrelated' } }
  ];
  const spy = vi.spyOn(resolver, 'resolvePointerTextAsync');
  const first = await buildPointerIndex(root, entries);
  expect(spy).toHaveBeenCalledTimes(3);
  spy.mockClear();
  const second = await buildPointerIndex(root, [{ ...entries[0], title: 'new' }, ...entries.slice(1)], first);
  expect(spy).not.toHaveBeenCalled();
  expect(second.files.x.entries[0].title).toBe('new');
  spy.mockClear();
  const changedPointer = { ...entries[0], pointer: { ...entries[0].pointer, pattern: 'β' } };
  const third = await buildPointerIndex(root, [changedPointer, ...entries.slice(1)], second);
  // The same authored pointer already belongs to b: reuse its resolution too.
  expect(spy).not.toHaveBeenCalled();
  await fs.writeFile(path.join(root, 'x'), '\nα\nβ');
  const fourth = await buildPointerIndex(root, entries, third);
  expect(spy).toHaveBeenCalledTimes(2);
  expect(spy.mock.calls.every(([pointer]) => pointer.file === 'x')).toBe(true);
  expect(fourth.files.x.entries[0].resolution).toMatchObject({ scope: { startLine: 2, endLine: 2 } });
  const moved = await buildPointerIndex(root, [{ ...entries[0], pointer: { ...entries[0].pointer, file: 'y' } }], fourth);
  expect(Object.keys(moved.files)).toEqual(['y']);
  expect(moved.files.y.entries).toHaveLength(1);
});

it('queries/reuses dirty text in memory, preserving disk snapshot and half-open coverage', async () => {
  await fs.writeFile(path.join(root, 'x'), '目标\nnext');
  const index = await buildPointerIndex(root, [{ id: 'a', pointer: {
    file: 'x', mode: 'regex', pattern: '目标\\n', beforeLines: 0, afterLines: 0
  } }]);
  expect(findNearestEntries(index, 'x', 2).candidates).toEqual([]);
  const spy = vi.spyOn(resolver, 'resolvePointerTextAsync');
  const dirty = await updatePointerIndexText(index, 'x', '😀\n目标\nnext');
  expect(findNearestEntries(dirty, 'x', 2)).toMatchObject({ complete: true, candidates: [{ entryId: 'a', distance: 0 }] });
  expect(findNearestEntries(index, 'x', 2).candidates).toEqual([]);
  expect(await fs.readFile(path.join(root, 'x'), 'utf8')).toBe('目标\nnext');
  spy.mockClear();
  expect(await queryNearestEntries(dirty, 'x', 2, '😀\n目标\nnext')).toEqual(findNearestEntries(dirty, 'x', 2));
  expect(spy).not.toHaveBeenCalled();
  expect(await queryNearestEntries(index, 'x', 1, '')).toMatchObject({ complete: false, candidates: [],
    unresolved: [{ resolution: { status: 'regex-no-match' } }] });
});

it('tracks malformed/no-match/missing states and rebuilds a newly materialized dependency', async () => {
  await fs.writeFile(path.join(root, 'x'), 'a');
  const entries = [
    { id: 'bad', pointer: { file: 'x', mode: 'regex', pattern: '[' } },
    { id: 'none', pointer: { file: 'x', mode: 'regex', pattern: 'nope' } },
    { id: 'shape', pointer: { file: 'x', mode: 'future' } },
    { id: 'missing', pointer: { file: 'dep', mode: 'lines', line: 1 } },
    { id: 'unsafe', pointer: { file: '../x', mode: 'lines', line: 1 } },
    { id: 'empty', pointer: null }
  ];
  const index = await buildPointerIndex(root, entries);
  expect(index.files.x.entries.map(e => e.resolution.status)).toEqual(['invalid-regex', 'regex-no-match', 'invalid-shape']);
  expect(index.files.dep).toMatchObject({ fingerprint: null, entries: [{ resolution: { status: 'file-missing' } }] });
  expect(index.unfiled).toMatchObject([{ entryId: 'unsafe', resolution: { status: 'invalid-shape' } }]);
  expect(findNearestEntries(index, 'x', 1).complete).toBe(false);
  await fs.writeFile(path.join(root, 'dep'), 'ready');
  const rebuilt = await buildPointerIndex(root, entries, index);
  expect(findNearestEntries(rebuilt, 'dep', 1)).toMatchObject({ complete: true, candidates: [{ entryId: 'missing' }] });
});

it('follows legitimate .lake external symlinks and rejects dangling links', async () => {
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'snl-dependency-'));
  try {
    await fs.writeFile(path.join(external, 'source.lean'), 'lemma');
    await fs.mkdir(path.join(root, '.lake'));
    await fs.symlink(external, path.join(root, '.lake', 'packages'));
    await fs.symlink(path.join(external, 'absent'), path.join(root, 'dangling'));
    const index = await buildPointerIndex(root, [
      { id: 'dep', pointer: { file: '.lake/packages/source.lean', mode: 'lines', line: 1 } },
      { id: 'dangling', pointer: { file: 'dangling', mode: 'lines', line: 1 } }
    ]);
    expect(findNearestEntries(index, '.lake/packages/source.lean', 1).candidates).toMatchObject([{ entryId: 'dep' }]);
    expect(index.files.dangling.entries[0].resolution.status).toBe('file-missing');
  } finally { await fs.rm(external, { recursive: true, force: true }); }
});

describe('pointer index', () => {
  it('builds a file bucket retaining authored pointers and UTF-16 resolved ranges', async () => {
    await fs.writeFile(path.join(root, '中文.lean'), '😀前\n目标\n尾');
    const pointer = { file: './中文.lean', mode: 'regex', pattern: '目标\\n', beforeLines: 0 };
    const index = await buildPointerIndex(root, [{ id: '目标', package: '课程', title: { zh: '标题' }, pointer }]);
    expect(index).toMatchObject({ version: 3, files: { '中文.lean': {
      entries: [{ entryId: '目标', package: '课程', title: { zh: '标题' }, pointer,
        resolution: { status: 'ok', scope: { startLine: 2, startColumn: 1, endLine: 3,
          endColumn: 1, coveredEndLine: 2, endInclusive: false, priority: 0 } } }]
    } }, unfiled: [] });
  });
});
