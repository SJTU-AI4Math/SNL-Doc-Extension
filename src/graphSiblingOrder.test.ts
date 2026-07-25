import { describe, expect, it } from 'vitest';
import { moveGraphSibling } from './graphSiblingOrder';

const nodes = (ids: string[]) => ids.map((id) => ({ id }));

describe('moveGraphSibling', () => {
  it('moves a root directly to the first sibling position without scrambling others', () => {
    const result = moveGraphSibling(
      nodes(['a', 'nested', 'b', 'c']),
      [{ from: 'a', to: 'nested', label: 'branch' }],
      'c',
      'up',
      true
    );

    expect(result.nodes.map((node) => node.id)).toEqual(['c', 'nested', 'a', 'b']);
  });

  it('moves a nested node directly to the last sibling position', () => {
    const result = moveGraphSibling(
      nodes(['parent', 'a', 'b', 'c', 'other']),
      [
        { from: 'parent', to: 'a', label: 'branch' },
        { from: 'other', to: 'x', label: 'context' },
        { from: 'parent', to: 'b', label: 'branch' },
        { from: 'parent', to: 'c', label: 'branch' }
      ],
      'b',
      'down',
      true
    );

    expect(result.relationships.map((rel) => rel.to)).toEqual(['a', 'x', 'c', 'b']);
  });

  it('keeps plain movement to one sibling step', () => {
    const result = moveGraphSibling(
      nodes(['parent', 'a', 'b', 'c']),
      [
        { from: 'parent', to: 'a', label: 'branch' },
        { from: 'parent', to: 'b', label: 'branch' },
        { from: 'parent', to: 'c', label: 'branch' }
      ],
      'b',
      'up',
      false
    );

    expect(result.relationships.map((rel) => rel.to)).toEqual(['b', 'a', 'c']);
  });
});
