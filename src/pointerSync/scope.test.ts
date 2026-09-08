import { describe, expect, it, vi } from 'vitest';
import { comparePointerIdentity, compilePointerScope, rankCompiledScopes, scopeContains, isCompiledPointerScope } from './scope';
import { resolvePointerText } from './text';
import { normalizeEntryPointer, type EntryPointer } from './schema';
function scope(p: EntryPointer, text: string) {
  const raw = resolvePointerText(p, text); if (raw.status !== 'ok') throw Error(JSON.stringify(raw));
  return { ...compilePointerScope(p, raw.range, text), entryId: '' };
}
const line = (extra: object = {}): EntryPointer => ({ file: 'x', mode: 'lines', line: 2, ...extra });
describe('compiled inverse scope contract', () => {
  it('compares identity alone without locale collation and treats omitted package as empty', () => {
    const locale = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => { throw Error('locale collation forbidden'); });
    try {
      expect(comparePointerIdentity({ entryId: 'a' }, { entryId: 'a', package: '' })).toBe(0);
      for (const [a, b] of [
        [{ entryId: 'Z', package: 'zz' }, { entryId: 'ä', package: '' }],
        [{ entryId: '😀' }, { entryId: '\uE000' }],
        [{ entryId: 'a' }, { entryId: 'a', package: 'A' }],
        [{ entryId: 'a', package: 'Z' }, { entryId: 'a', package: 'ä' }],
        [{ entryId: 'a', package: '😀' }, { entryId: 'a', package: '\uE000' }],
      ]) {
        expect(comparePointerIdentity(a, b)).toBeLessThan(0);
        expect(comparePointerIdentity(b, a)).toBeGreaterThan(0);
      }
      expect(locale).not.toHaveBeenCalled();
    } finally { locale.mockRestore(); }
  });
  it('orders all winning identities by UTF-16 EntryId then PackageId, never locale or input order', () => {
    const compiled = scope(line(), 'a\nabc\nz');
    const identities = [
      { entryId: '\uE000' }, { entryId: '😀' }, { entryId: 'ä' },
      { entryId: 'a', package: 'ä' }, { entryId: 'a', package: 'Z' },
      { entryId: 'a' }, { entryId: 'Z' }, { entryId: 'a\n' }, { entryId: 'a"' },
    ];
    const items = identities.map(identity => ({ ...compiled, ...identity }));
    const expected = [items[6], items[5], items[4], items[3], items[7], items[8], items[2], items[1], items[0]];
    for (const input of [items, [...items].reverse(), [...items.slice(3), ...items.slice(0, 3)]]) {
      const candidates = [
        ...input,
        { ...compiled, entryId: 'A', priority: -1 },
        { ...scope(line({ line: 1, endLine: 2 }), 'a\nabc\nz'), entryId: 'B' },
      ];
      expect(rankCompiledScopes(candidates, x => x, 2, 2)).toEqual(expected);
    }
  });
  it('ignores independently omitted legacy fields and preserves signed fractional priority and columns', () => {
    expect(normalizeEntryPointer(line({ column: 2, endColumn: 4, priority: 0 }))).toMatchObject({ column: 2, endColumn: 4, priority: 0 });
    for (const priority of [-1.5, 0, .25]) expect(scope(line({ priority }), 'a\nabc\nz').priority).toBe(priority);
    const text = Array(50).fill('row').join('\n');
    expect(scope(line({ line:20, beforeLines:0 }), text)).toMatchObject({ startLine:20,endLine:20 });
    expect(scope(line({ line:20, afterLines:0 }), text)).toMatchObject({ startLine:20,endLine:20 });
  });
  it.each([0,-1,1.5,NaN,Infinity,'2',Number.MAX_SAFE_INTEGER+1])('rejects malformed columns %s instead of widening', column => {
    expect(normalizeEntryPointer(line({ column }))).toBeNull();
    expect(normalizeEntryPointer(line({ endColumn:column }))).toBeNull();
  });
  it.each([NaN,Infinity,-Infinity,'0',null])('rejects malformed priority %s', priority => expect(normalizeEntryPointer(line({priority}))).toBeNull());
  it('fails visible for out-of-bounds/reversed explicit coordinates', () => {
    for (const p of [line({column:9}),line({endColumn:9}),line({column:3,endColumn:2}),line({endLine:9,endColumn:1})]) {
      expect(resolvePointerText(p,'a\nabc')).toMatchObject({status:'invalid-shape'});
    }
  });
  it('handles exact UTF16 emoji columns, CRLF span, disjoint ranges and half-open endpoints', () => {
    const text='x\r\n😀abc\r\n';
    const a=scope(line({column:1,endColumn:3}),text), b=scope(line({column:3,endColumn:6}),text);
    expect(a).toMatchObject({ startOffset:3,endOffset:5,span:2,endInclusive:false });
    expect(scopeContains(a,2,2)).toBe(true); expect(scopeContains(a,2,3)).toBe(false);
    expect(rankCompiledScopes([a,b],x=>x,2,3)).toEqual([b]);
    expect(scope(line({line:1,endLine:3}),text)).toMatchObject({startOffset:0,endOffset:10,span:10,endLine:3,endColumn:1,endInclusive:true});
  });
  it('includes EOL and explicitly addressed empty EOF caret, but not precise end', () => {
    const text='a\nxyz\n';
    const whole=scope(line(),text); expect(scopeContains(whole,2,4)).toBe(true);
    const precise=scope(line({endColumn:4}),text); expect(scopeContains(precise,2,4)).toBe(false);
    const eof=scope(line({endLine:3}),text); expect(scopeContains(eof,3,1)).toBe(true); expect(scopeContains(eof,3,2)).toBe(false);
    expect(scopeContains(whole,3,1)).toBe(false);
    const point=scope({file:'x',mode:'regex',pattern:'$'},'');
    expect(scopeContains(point,1,1)).toBe(true); expect(scopeContains(point,1,2)).toBe(false);
    expect(isCompiledPointerScope(point)).toBe(true);
    const newline=scope({file:'x',mode:'regex',pattern:'a\\n'},'a\n');
    expect(scopeContains(newline,2,1)).toBe(false);
  });
  it('ranks by priority then exact UTF16 span and retains all ties, never nearest', () => {
    const text='long first row\nabc\nend';
    const big=scope(line({line:1,endLine:2,priority:-.5}),text);
    const small=scope(line({priority:-.5}),text);
    const tie={...small};
    expect(rankCompiledScopes([big,small,tie],x=>x,2,2)).toEqual([small,tie]);
    expect(rankCompiledScopes([big,{...small,priority:-1}],x=>x,2,2)).toEqual([big]);
    expect(rankCompiledScopes([small],x=>x,1,2)).toEqual([]);
    expect(rankCompiledScopes([big],x=>x,4,1)).toEqual([]);
  });
});
