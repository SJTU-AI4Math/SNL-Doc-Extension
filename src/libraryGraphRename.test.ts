import { describe, expect, it } from 'vitest';
import { renameGraphNodeId, renameRawLibraryGraphNodeId } from './libraryGraph';

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

describe('renameRawLibraryGraphNodeId', () => {
  it('preserves wrapper, record extensions, and malformed rows while rewriting incident edges', () => {
    const raw = {
      version: 2,
      extension: { keep: true },
      nodes: [
        { id: 'root', label: 'Entry', props: { entryId: 'entry-a' }, topLevelExtension: 7 },
        { id: 'child', label: 'Entry', props: {} },
        'malformed-node'
      ],
      relationships: [
        { from: 'root', to: 'child', label: 'branch', properties: { order: 4 } },
        { from: 'child', to: 'root', label: 'custom', extension: 'keep' },
        17
      ]
    };
    const original = structuredClone(raw);
    const result = renameRawLibraryGraphNodeId(raw, 'root', 'intro');
    expect(result).toEqual({
      ok: true,
      value: {
        ...raw,
        nodes: [
          { ...(raw.nodes[0] as object), id: 'intro' },
          raw.nodes[1],
          raw.nodes[2]
        ],
        relationships: [
          { ...(raw.relationships[0] as object), from: 'intro' },
          { ...(raw.relationships[1] as object), to: 'intro' },
          raw.relationships[2]
        ]
      }
    });
    expect(raw).toEqual(original);
  });
});