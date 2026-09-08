import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPointerIndex } from './index';
import { isPointerIndex, readPointerIndex, writePointerIndex } from './persistence';

it.each([
  '{', 'null', '{}', '{"version":999,"files":{},"unfiled":[]}',
  '{"version":1,"files":{"../x":{"fingerprint":null,"entries":[]}},"unfiled":[]}',
  '{"version":1,"files":{"x":{"fingerprint":"bad","entries":[]}},"unfiled":[]}'
])('rejects malformed persisted input %s', async text => {
  await fs.mkdir(path.join(root, '.SNL_Doc'));
  await fs.writeFile(path.join(root, '.SNL_Doc', 'syncSNL.json'), text);
  expect(await readPointerIndex(root)).toBeUndefined();
});

it('rejects malformed ranges, pointer thresholds, unknown diagnostics, and duplicate records', async () => {
  await fs.writeFile(path.join(root, 'x'), 'a\nb');
  const index = await buildPointerIndex(root, [{ id: 'a', pointer: { file: 'x', mode: 'lines', line: 1 } }]);
  await fs.mkdir(path.join(root, '.SNL_Doc'));
  const cachePath = path.join(root, '.SNL_Doc', 'syncSNL.json');
  for (const mutate of [
    (value: any) => { value.files.x.entries[0].resolution.scope.startColumn = 0; },
    (value: any) => { value.files.x.entries[0].resolution.scope.endLine = -1; },
    (value: any) => { value.files.x.entries[0].resolution.scope.coveredEndLine = 3; },
    (value: any) => { value.files.x.entries[0].resolution.scope.span++; },
    (value: any) => { value.files.x.entries[0].resolution.scope.priority = null; },
    (value: any) => { value.files.x.entries[0].resolution.scope.endInclusive = 'true'; },
    (value: any) => { value.files.x.entries[0].resolution.range = value.files.x.entries[0].resolution.scope; },
    (value: any) => { value.files.x.entries[0].pointer.beforeLines = -1; },
    (value: any) => { value.files.x.entries[0].resolution = { status: 'invented' }; },
    (value: any) => { value.files.x.entries[0].resolution = { status: 'regex-timeout' }; },
    (value: any) => { value.files.x.fingerprint = null; },
    (value: any) => { value.files.x.entries[0].title = { type: 'i18n', default_language: 'en', values: { en: 42 } }; },
    (value: any) => { value.files.x.entries[0].title = { type: 'i18n', default_language: 'en', values: {} }; },
    (value: any) => { value.files.x.entries[0].title = { type: 'i18n', values: { en: 'Alpha' } }; },
    (value: any) => { value.files.x.entries.push(value.files.x.entries[0]); }
  ]) {
    const malformed = JSON.parse(JSON.stringify(index));
    mutate(malformed);
    expect(isPointerIndex(malformed)).toBe(false);
    await fs.writeFile(cachePath, JSON.stringify(malformed));
    expect(await readPointerIndex(root)).toBeUndefined();
    await expect(writePointerIndex(root, malformed)).rejects.toThrow('Invalid Pointer index');
  }
});

it('roundtrips unresolved pointers and arbitrary own file keys without prototype loss', async () => {
  await fs.writeFile(path.join(root, '__proto__'), 'a\n');
  await fs.writeFile(path.join(root, 'constructor'), 'x');
  const index = await buildPointerIndex(root, [
    { id: '__proto__', pointer: { file: '__proto__', mode: 'lines', line: 1, endLine: 5 } },
    { id: 'constructor', pointer: { file: 'constructor', mode: 'regex', pattern: '[' } },
    { id: 'missing', pointer: { file: 'missing', mode: 'lines', line: 1 } },
    { id: 'unsafe', pointer: { file: '../unsafe', mode: 'lines', line: 1 } }
  ]);
  await writePointerIndex(root, index);
  const loaded = await readPointerIndex(root);
  expect(loaded).toEqual(index);
  expect(Object.hasOwn(loaded!.files, '__proto__')).toBe(true);
  expect(loaded!.files.__proto__.entries[0].entryId).toBe('__proto__');
});
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'snl-persist-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('atomically writes deterministic syncSNL.json and validates its roundtrip', async () => {
  await fs.writeFile(path.join(root, 'x'), 'alpha\nβ');
  const entries = [
    { id: 'b', pointer: { file: 'x', mode: 'regex', pattern: 'β', afterLines: 0 } },
    { id: 'a', pointer: { file: 'x', mode: 'lines', line: 1 } }
  ];
  expect(await readPointerIndex(root)).toBeUndefined();
  const index = await buildPointerIndex(root, entries);
  await writePointerIndex(root, index);
  expect(await readPointerIndex(root)).toEqual(index);
  const target = path.join(root, '.SNL_Doc', 'syncSNL.json');
  const bytes = await fs.readFile(target, 'utf8');
  await writePointerIndex(root, await buildPointerIndex(root, [...entries].reverse(), index));
  expect(await fs.readFile(target, 'utf8')).toBe(bytes);
  expect(await fs.readdir(path.dirname(target))).toEqual(['syncSNL.json']);
});

it('refuses a symlink cache path without overwriting the symlink target', async () => {
  await fs.mkdir(path.join(root, '.SNL_Doc'));
  const outside = path.join(root, 'outside');
  await fs.writeFile(outside, 'untouched');
  await fs.symlink(outside, path.join(root, '.SNL_Doc', 'syncSNL.json'));
  expect(await readPointerIndex(root)).toBeUndefined();
  await expect(writePointerIndex(root, await buildPointerIndex(root, []))).rejects.toThrow(/symlink/i);
  expect(await fs.readFile(outside, 'utf8')).toBe('untouched');
});
