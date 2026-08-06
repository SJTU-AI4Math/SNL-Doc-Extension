import { describe, expect, it } from 'vitest';
import { renameGraphNodeId } from './libraryGraph';

const nodes = [
  { id: 'root', label: 'Entry', props: { entryId: 'entry-a', extension: { keep: true } } },
  { id: 'child', label: 'Entry', props: { entryId: 'entry-b' } }
];
const relationships = [
  { from: 'root', to: 'child', label: 'branch' },
  { from: 'child', to: 'root', label: 'reference' }
];

describe('renameGraphNodeId', () => {
  it('renames exactly one graph-local node and every incident edge', () => {
    const result = renameGraphNodeId(nodes, relationships, 'root', 'intro');
    expect(result).toEqual({
      ok: true,
      nodes: [
        { id: 'intro', label: 'Entry', props: { entryId: 'entry-a', extension: { keep: true } } },
        nodes[1]
      ],
      relationships: [
        { from: 'intro', to: 'child', label: 'branch' },
        { from: 'child', to: 'intro', label: 'reference' }
      ]
    });
    expect(nodes[0].id).toBe('root');
    expect(relationships[0].from).toBe('root');
  });

  it.each([
    ['root', '', 'invalid'],
    ['root', '  ', 'invalid'],
    ['root', ' bad', 'invalid'],
    ['root', 'bad\nnode', 'invalid'],
    ['root', 'child', 'duplicate'],
    ['absent', 'fresh', 'notFound']
  ] as const)('rejects %j → %j without mutating the graph', (oldNodeId, newNodeId, reason) => {
    const result = renameGraphNodeId(nodes, relationships, oldNodeId, newNodeId);
    expect(result).toEqual({ ok: false, reason });
    expect(nodes.map((node) => node.id)).toEqual(['root', 'child']);
    expect(relationships[0].from).toBe('root');
  });
});