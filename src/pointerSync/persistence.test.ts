import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPointerIndex } from './index';
import { isPointerIndex, pointerIndexInputs, readPointerIndex, writePointerIndex } from './persistence';
import { cacheFingerprint, cachePath } from '../derivedCache';

// Use real native storage and valid envelope metadata: malformed raw JSON alone
// can be rejected before the Pointer payload validator is ever reached.
async function storeEnvelope(value: Awaited<ReturnType<typeof buildPointerIndex>>) {
  const target = cachePath(root, 'pointer-inverse');
  expect(target).toBe(path.join(root, '.SNL_Doc', '.cache', 'pointer-inverse', 'result.json'));
  const envelope = {
    format: 'snl-derived-cache', schema: 1, generator: 'pointer-inverse',
    version: '1', library: null,
    inputHash: cacheFingerprint(pointerIndexInputs(value)),
    valueHash: cacheFingerprint(value), value
  };
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(envelope));
}

it('reads a valid current v3 payload from the current envelope path', async () => {
  await fs.writeFile(path.join(root, 'x'), 'before\ntarget\nafter');
  const current = await buildPointerIndex(root, [{ id: 'a', pointer: { file: 'x', mode: 'lines', line: 2 } }]);
  expect(current.version).toBe(3);
  expect(isPointerIndex(current)).toBe(true);
  await storeEnvelope(current);
  expect(await readPointerIndex(root)).toEqual(current);
});

it.each(['v2 expanded scope', 'invalid scope priority', 'mismatched scope priority'])(
  'rejects %s inside an otherwise valid current cache envelope', async invalid => {
    const text = 'before\ntarget\nafter';
    await fs.writeFile(path.join(root, 'x'), text);
    const value = await buildPointerIndex(root, [{ id: 'a', pointer: { file: 'x', mode: 'lines', line: 2 } }]);
    const resolution = value.files.x.entries[0].resolution;
    if (resolution.status !== 'ok') throw new Error('Expected resolved fixture');
    if (invalid === 'v2 expanded scope') {
      Object.assign(value, { version: 2 });
      resolution.scope = {
        startLine: 1, startColumn: 1, endLine: 3, endColumn: 6, coveredEndLine: 3,
        startOffset: 0, endOffset: text.length, span: text.length, priority: 0, endInclusive: true
      };
    } else {
      Object.assign(resolution.scope, { priority: invalid === 'invalid scope priority' ? null : 1 });
    }
    // Independent validator, reader and writer obligations. Rehash after mutation
    // so the reader cannot pass this test just by rejecting broken outer metadata.
    expect(isPointerIndex(value)).toBe(false);
    await storeEnvelope(value);
    expect(await readPointerIndex(root)).toBeUndefined();
    await expect(writePointerIndex(root, value)).rejects.toThrow('Invalid Pointer index');
  }
);

it('leaves legacy syncSNL bytes untouched and never reads that path', async () => {
  const value = await buildPointerIndex(root, []);
  const legacy = path.join(root, '.SNL_Doc', 'syncSNL.json');
  const bytes = JSON.stringify(value) + '\n';
  await fs.writeFile(legacy, bytes);
  expect(await readPointerIndex(root)).toBeUndefined();
  expect(await fs.readFile(legacy, 'utf8')).toBe(bytes);
  await writePointerIndex(root, value);
  expect(await readPointerIndex(root)).toEqual(value);
  expect(await fs.readFile(legacy, 'utf8')).toBe(bytes);
});

it.each([
  '{', 'null', '{}', '{"version":999,"files":{},"unfiled":[]}',
  '{"version":1,"files":{"../x":{"fingerprint":null,"entries":[]}},"unfiled":[]}',
  '{"version":1,"files":{"x":{"fingerprint":"bad","entries":[]}},"unfiled":[]}'
])('rejects malformed persisted input %s', async text => {
  await fs.mkdir(path.join(root, '.SNL_Doc/.cache/pointer-inverse'), { recursive: true });
  await fs.writeFile(path.join(root, '.SNL_Doc', '.cache/pointer-inverse/result.json'), text);
  expect(await readPointerIndex(root)).toBeUndefined();
});

it('rejects malformed ranges, pointer priorities, unknown diagnostics, and duplicate records', async () => {
  await fs.writeFile(path.join(root, 'x'), 'a\nb');
  const index = await buildPointerIndex(root, [{ id: 'a', pointer: { file: 'x', mode: 'lines', line: 1 } }]);
  await fs.mkdir(path.join(root, '.SNL_Doc/.cache/pointer-inverse'), { recursive: true });

  for (const mutate of [
    (value: any) => { value.files.x.entries[0].resolution.scope.startColumn = 0; },
    (value: any) => { value.files.x.entries[0].resolution.scope.endLine = -1; },
    (value: any) => { value.files.x.entries[0].resolution.scope.coveredEndLine = 3; },
    (value: any) => { value.files.x.entries[0].resolution.scope.span++; },
    (value: any) => { value.files.x.entries[0].resolution.scope.priority = null; },
    (value: any) => { value.files.x.entries[0].resolution.scope.endInclusive = 'true'; },
    (value: any) => { value.files.x.entries[0].resolution.range = value.files.x.entries[0].resolution.scope; },
    (value: any) => { value.files.x.entries[0].pointer.priority = 'bad'; },
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
    await storeEnvelope(malformed);
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
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'snl-persist-')); await fs.mkdir(path.join(root, '.SNL_Doc')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('atomically writes deterministic pointer-inverse cache and validates its roundtrip', async () => {
  await fs.writeFile(path.join(root, 'x'), 'alpha\nβ');
  const entries = [
    { id: 'b', pointer: { file: 'x', mode: 'regex', pattern: 'β', afterLines: 0 } },
    { id: 'a', pointer: { file: 'x', mode: 'lines', line: 1 } }
  ];
  expect(await readPointerIndex(root)).toBeUndefined();
  const index = await buildPointerIndex(root, entries);
  await writePointerIndex(root, index);
  expect(await readPointerIndex(root)).toEqual(index);
  const target = path.join(root, '.SNL_Doc', '.cache/pointer-inverse/result.json');
  const bytes = await fs.readFile(target, 'utf8');
  await writePointerIndex(root, await buildPointerIndex(root, [...entries].reverse(), index));
  expect(await fs.readFile(target, 'utf8')).toBe(bytes);
  expect(await fs.readdir(path.dirname(target))).toEqual(['result.json']);
});

it('refuses a symlink cache path without overwriting the symlink target', async () => {
  await fs.mkdir(path.join(root, '.SNL_Doc/.cache/pointer-inverse'), { recursive: true });
  const outside = path.join(root, 'outside');
  await fs.writeFile(outside, 'untouched');
  await fs.symlink(outside, path.join(root, '.SNL_Doc', '.cache/pointer-inverse/result.json'));
  expect(await readPointerIndex(root)).toBeUndefined();
  await expect(writePointerIndex(root, await buildPointerIndex(root, []))).rejects.toThrow(/Unsafe/i);
  expect(await fs.readFile(outside, 'utf8')).toBe('untouched');
});
