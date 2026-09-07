import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPointerIndex, queryNearestEntries } from './index';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid column %s equally for persisted and dirty-text queries', async column => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pointer-query-position-'));
    roots.push(root);
    const text = 'alpha beta\n';
    await fs.writeFile(path.join(root, 'x'), text);
    const index = await buildPointerIndex(root, [{ id: 'entry', pointer: {
      file: 'x', mode: 'lines', line: 1, beforeLines: 0, afterLines: 0,
    } }]);
    const expected = { candidates: [], complete: false, unresolved: [] };
    expect(await queryNearestEntries(index, 'x', 1, undefined, column)).toEqual(expected);
    expect(await queryNearestEntries(index, 'x', 1, text, column)).toEqual(expected);
  },
);
