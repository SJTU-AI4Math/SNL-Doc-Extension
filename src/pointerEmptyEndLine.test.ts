import { describe, expect, it } from 'vitest';
import { resolvePointerText } from './pointerSync/text';
import { findNearestEntries } from './pointerSync';
import { isPointerIndex } from './pointerSync/persistence';
import { compilePointerScope } from './pointerSync/scope';
describe('Explicit lines Pointer empty endpoint', () => {
  it('keeps an explicitly named empty end line inside a zero-distance match', () => {
    const pointer = { file: 'x.lean', mode: 'lines' as const, line: 1, endLine: 3, beforeLines: 0, afterLines: 0 };
    const resolution = resolvePointerText(pointer, 'a\nb\n');
    expect(resolution).toMatchObject({ status: 'ok', range: { startLine: 1, endLine: 3, coveredEndLine: 3 } });
    if (resolution.status !== 'ok') throw Error('unexpected resolution');
    const index = { version: 2 as const, files: { 'x.lean': { fingerprint: 'a'.repeat(64), entries: [{ entryId: 'A', pointer, resolution: { status: 'ok' as const, scope: compilePointerScope(pointer, resolution.range, 'a\nb\n') } }] } }, unfiled: [] };
    expect(findNearestEntries(index, 'x.lean', 3).candidates).toHaveLength(1);
    expect(isPointerIndex(index)).toBe(true);
  });
  it('does not give regex the same inclusive-empty-endpoint rule', () => {
    const resolution = resolvePointerText({ file: 'x.lean', mode: 'regex', pattern: 'a\\nb\\n' }, 'a\nb\n');
    expect(resolution).toMatchObject({ status: 'ok', range: { coveredEndLine: 2 } });
  });
});
