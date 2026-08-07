import { describe, expect, it } from 'vitest';
import { wrapNestedNodeWithParent } from './treeWrapParent';

describe('shared tree add-parent transforms', () => {
  it('wraps a nested counter node without moving its siblings or children', () => {
    const roots = [
      { id: 'a', children: [] as Array<{ id: string; children: unknown[] }> },
      {
        id: 'b',
        children: [{ id: 'c', children: [{ id: 'd', children: [] }] }]
      }
    ];
    const parent = { id: 'p', children: [] as typeof roots };

    expect(wrapNestedNodeWithParent(roots, 'c', parent)).toBe(true);
    expect(roots.map((node) => node.id)).toEqual(['a', 'b']);
    expect(roots[1].children.map((node) => node.id)).toEqual(['p']);
    expect(parent.children.map((node) => node.id)).toEqual(['c']);
    expect((parent.children[0].children as Array<{ id: string }>).map((node) => node.id))
      .toEqual(['d']);
  });

});
