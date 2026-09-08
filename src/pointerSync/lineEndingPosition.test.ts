import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePointerText } from './text';
import { buildPointerIndex, findNearestEntries } from './index';
import { isPointerIndex, writePointerIndex, readPointerIndex } from './persistence';
import { captureSourceSnapshot } from '../sourceExport/archive';
import { buildSourceAssets } from '../sourceExport/transport';
import { DEFAULT_SOURCE_OPTIONS } from '../sourceExport/types';
import type { EntryPointer } from './schema';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(text: string, pointer: EntryPointer) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pointer-line-ending-')); roots.push(root);
  await fs.writeFile(path.join(root, 'x.lean'), text);
  const entries = [{ id: 'e', pointer }];
  const index = await buildPointerIndex(root, entries);
  const preview = await captureSourceSnapshot({ rootPath: root, destinationPath: path.join(root, 'export'), inline: false,
    entries, entryRoutes: [{ entryId: 'e', hash: '#/entry/e' }], renderSnapshotId: 'line-ending-test',
    options: { ...DEFAULT_SOURCE_OPTIONS, enabled: true, allowMissing: true } });
  return { root, index, preview };
}
const regex = (pattern: string): EntryPointer => ({ file: 'x.lean', mode: 'regex', pattern });

it('treats a lone CR as an editor newline and never publishes a negative scope', async () => {
  const pointer: EntryPointer = { file: 'x.lean', mode: 'lines', line: 1, column: 3, endColumn: 3 };
  const { root, index, preview } = await fixture('a\r', pointer);
  expect(index.files['x.lean'].entries[0].resolution.status).toBe('invalid-shape');
  expect(isPointerIndex(index)).toBe(true);
  expect(findNearestEntries(index, 'x.lean', 1, 2)).toMatchObject({ complete: false, candidates: [] });
  await writePointerIndex(root, index); expect(await readPointerIndex(root)).toEqual(index);
  expect(preview.manifest.pointers[0].status).toBe('unresolved');
  expect(() => buildSourceAssets(preview, false)).not.toThrow();
});

it.each(['a\\r', '\\n', '(?=\\n)'])('reports an unrepresentable CRLF-interior endpoint in %s before export', async pattern => {
  const { root, index, preview } = await fixture('a\r\nb', regex(pattern));
  expect(resolvePointerText(regex(pattern), 'a\r\nb').status).toBe('invalid-shape');
  expect(index.files['x.lean'].entries[0].resolution.status).toBe('invalid-shape');
  expect(findNearestEntries(index, 'x.lean', 1, 2).complete).toBe(false);
  await writePointerIndex(root, index); expect(await readPointerIndex(root)).toEqual(index);
  expect(preview.manifest.pointers[0].status).toBe('unresolved');
  for (const inline of [false, true]) expect(() => buildSourceAssets(preview, inline)).not.toThrow();
});

it('retains whole CRLF matches and exact original UTF16 offsets', async () => {
  const { index, preview } = await fixture('a\r\nb', regex('a\\r\\n'));
  expect(index.files['x.lean'].entries[0].resolution).toMatchObject({ status: 'ok', scope: {
    startLine: 1, startColumn: 1, endLine: 2, endColumn: 1, startOffset: 0, endOffset: 3, span: 3,
  } });
  expect(findNearestEntries(index, 'x.lean', 2, 1).candidates).toEqual([]);
  expect(() => buildSourceAssets(preview, false)).not.toThrow();
});

it('uses the same lone-CR row coordinates for forward, inverse and exported scopes', async () => {
  const pointer = regex('b');
  const { index, preview } = await fixture('a\rb\r', pointer);
  expect(resolvePointerText(pointer, 'a\rb\r')).toMatchObject({ status: 'ok', range: {
    startLine: 2, startColumn: 1, endLine: 2, endColumn: 2,
  } });
  expect(index.files['x.lean'].entries[0].resolution).toMatchObject({ status: 'ok', scope: {
    startLine: 2, endLine: 2, endColumn: 2, startOffset: 2, endOffset: 3, span: 1, endInclusive: false,
  } });
  // Preserve the existing export EOL vocabulary (bare CR is classified as mixed).
  expect(preview.manifest.files[0].eol).toBe('mixed');
  expect(findNearestEntries(index, 'x.lean', 2, 1).candidates.map(p => p.entryId)).toEqual(['e']);
  expect(findNearestEntries(index, 'x.lean', 2, 2).candidates).toEqual([]);
  expect(findNearestEntries(index, 'x.lean', 3, 1).candidates).toEqual([]);
  for (const inline of [false, true]) expect(() => buildSourceAssets(preview, inline)).not.toThrow();
});
