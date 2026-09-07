import { describe, expect, it } from 'vitest';
import { compilePointerScope, rankCompiledScopes, scopeContains, isCompiledPointerScope } from './scope';
import { resolvePointerText } from './text';
import { normalizeEntryPointer, type EntryPointer } from './schema';
function scope(p: EntryPointer, text: string) {
  const raw = resolvePointerText(p, text); if (raw.status !== 'ok') throw Error(JSON.stringify(raw));
  return compilePointerScope(p, raw.range, text);
}
const line = (extra: object = {}): EntryPointer => ({ file: 'x', mode: 'lines', line: 2, beforeLines: 0, afterLines: 0, ...extra });
describe('compiled inverse scope contract', () => {
  it('preserves independent omission, explicit zero, signed fractional priority and columns', () => {
    expect(normalizeEntryPointer(line({ column: 2, endColumn: 4, priority: 0 }))).toMatchObject({ column: 2, endColumn: 4, priority: 0 });
    for (const priority of [-1.5, 0, .25]) expect(scope(line({ priority }), 'a\nabc\nz').priority).toBe(priority);
    const text = Array(50).fill('row').join('\n');
    expect(scope({ file:'x', mode:'lines', line:20, beforeLines:0 }, text)).toMatchObject({ startLine:20,endLine:35 });
    expect(scope({ file:'x', mode:'lines', line:20, afterLines:0 }, text)).toMatchObject({ startLine:5,endLine:20 });
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
    expect(scope(line({beforeLines:1,afterLines:1}),text)).toMatchObject({startOffset:0,endOffset:10,span:10,endLine:3,endColumn:1,endInclusive:true});
  });
  it('includes EOL and empty EOF caret for whole rows/buffer rows, but not precise end', () => {
    const text='a\nxyz\n';
    const whole=scope(line(),text); expect(scopeContains(whole,2,4)).toBe(true);
    const precise=scope(line({endColumn:4}),text); expect(scopeContains(precise,2,4)).toBe(false);
    const added=scope(line({afterLines:1}),text); expect(scopeContains(added,3,1)).toBe(true); expect(scopeContains(added,3,2)).toBe(false);
    const point=scope({file:'x',mode:'regex',pattern:'$',beforeLines:0,afterLines:0},'');
    expect(scopeContains(point,1,1)).toBe(true); expect(scopeContains(point,1,2)).toBe(false);
    expect(isCompiledPointerScope(point)).toBe(true);
    const newline=scope({file:'x',mode:'regex',pattern:'a\\n',beforeLines:0,afterLines:0},'a\n');
    expect(scopeContains(newline,2,1)).toBe(false);
  });
  it('ranks by priority then actual expanded UTF16 span and retains all ties, never nearest', () => {
    const text='long first row\nabc\nend';
    const big=scope(line({beforeLines:1,priority:-.5}),text);
    const small=scope(line({priority:-.5}),text);
    const tie={...small};
    expect(rankCompiledScopes([big,small,tie],x=>x,2,2)).toEqual([small,tie]);
    expect(rankCompiledScopes([big,{...small,priority:-1}],x=>x,2,2)).toEqual([big]);
    expect(rankCompiledScopes([small],x=>x,1,2)).toEqual([]);
    expect(rankCompiledScopes([big],x=>x,4,1)).toEqual([]);
  });
});
