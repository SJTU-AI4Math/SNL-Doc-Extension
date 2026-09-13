import { describe, expect, it } from 'vitest';
import { resolvePointerText } from './text';
import { resolvePointerTextAsync } from './resolve';
import { EntryPointer, normalizePointerFile } from './schema';

describe('shared text resolution', () => {
  const cases: Array<[EntryPointer, string, object]> = [
    [{ file: 'x', mode: 'lines', line: 1, endLine: 100 }, 'α\r\nβ',
      { status: 'ok', range: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 2, coveredEndLine: 2 } }],
    [{ file: 'x', mode: 'lines', line: 2 }, '', { status: 'line-out-of-range', line: 2, totalLines: 1 }],
    [{ file: 'x', mode: 'lines', line: 1 }, '', { status: 'ok', range: { startLine: 1, endLine: 1, endColumn: 1, coveredEndLine: 1 } }],
    [{ file: 'x', mode: 'regex', pattern: '^β$' }, 'α\nβ\nγ', { status: 'regex-no-match' }],
    [{ file: 'x', mode: 'regex', pattern: '^β$', flags: 'm' }, 'α\nβ\nγ', { status: 'ok', range: { startLine: 2, endColumn: 2 } }],
    [{ file: 'x', mode: 'regex', pattern: 'α', flags: 'i', occurrence: 2 }, 'α😀Α', { status: 'ok', range: { startColumn: 4, endColumn: 5 } }],
    [{ file: 'x', mode: 'regex', pattern: 'α.*β', flags: 's' }, 'α\nβ', { status: 'ok', range: { startLine: 1, endLine: 2, coveredEndLine: 2 } }],
    [{ file: 'x', mode: 'regex', pattern: 'β', flags: 'y' }, 'αβ', { status: 'regex-no-match' }],
    [{ file: 'x', mode: 'regex', pattern: '(?:)', flags: 'u', occurrence: 2 }, '😀α', { status: 'ok', range: { startColumn: 3, endColumn: 3 } }],
    [{ file: 'x', mode: 'regex', pattern: '(?:)', flags: 'u', occurrence: 4 }, '😀α', { status: 'regex-no-match' }],
    [{ file: 'x', mode: 'regex', pattern: '$' }, 'α\n', { status: 'ok', range: { startLine: 2, endLine: 2, coveredEndLine: 2 } }],
    [{ file: 'x', mode: 'regex', pattern: '[' }, 'α', { status: 'invalid-regex' }],
    [{ file: 'x', mode: 'regex', pattern: 'a', flags: 'gg' }, 'a', { status: 'invalid-regex' }],
    [{ file: 'x', mode: 'lines', line: 1, endLine: 100 }, 'α\n',
      { status: 'ok', range: { endLine: 2, endColumn: 1, coveredEndLine: 2 } }]
  ];
  it.each(cases)('pure/worker parity for %j on %j', async (pointer, text, expected) => {
    const pure = resolvePointerText(pointer, text);
    expect(pure).toMatchObject(expected);
    expect(await resolvePointerTextAsync(pointer, text)).toEqual(pure);
  });

  it('terminates catastrophic regex without blocking the host event loop', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      expect(await resolvePointerTextAsync({ file: 'x', mode: 'regex', pattern: '(a+)+$' },
        'a'.repeat(50000) + '!', 100)).toMatchObject({ status: 'regex-timeout', timeoutMs: 100 });
      expect(ticks).toBeGreaterThan(0);
    } finally { clearInterval(timer); }
  });

  it.each(['/tmp/x', 'C:\\x', 'C:x', '\\\\server\\x', '../x', 'a/../x', 'a\0b'])('rejects unsafe path %s', file => {
    expect(normalizePointerFile(file)).toBeUndefined();
    expect(resolvePointerText({ file, mode: 'lines', line: 1 }, '')).toMatchObject({ status: 'invalid-shape' });
  });
});
