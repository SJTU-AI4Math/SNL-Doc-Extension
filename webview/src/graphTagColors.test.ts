import { describe, expect, it } from 'vitest';
import { graphTagColor } from './SnlGraphApp';

describe('graph Tag palette exact membership', () => {
  const rules = [
    { id: 1, tag: null, color: '#000000' },
    { id: 2, tag: '__proto__', color: '#112233' },
    { id: 3, tag: '', color: '#445566' },
    { id: 4, tag: '中文,Tag', color: '#778899' }
  ];
  it('uses ordered rules, safely matching prototype-like, empty and comma-containing strings', () => {
    expect(graphTagColor(['中文,Tag', '', '__proto__'], rules)).toBe('#112233');
    expect(graphTagColor(['__proto__', '', '中文,Tag'], [...rules].reverse())).toBe('#778899');
    expect(graphTagColor([''], rules)).toBe('#445566');
    expect(graphTagColor(['中文,Tag'], rules)).toBe('#778899');
    expect(graphTagColor(['中文', 'Tag'], rules)).toBeUndefined();
    expect(graphTagColor([' __proto__', '__PROTO__'], rules)).toBeUndefined();
  });
  it('returns no override for absent tags, no hit, drafts or deleted rules', () => {
    expect(graphTagColor(undefined, rules)).toBeUndefined();
    expect(graphTagColor([], rules)).toBeUndefined();
    expect(graphTagColor(['no-hit'], rules)).toBeUndefined();
    expect(graphTagColor(['__proto__'], rules.filter(rule => rule.id !== 2))).toBeUndefined();
    expect(graphTagColor([''], [rules[0]])).toBeUndefined();
  });
});
