import { describe, expect, it } from 'vitest';
import { updateRawLibraryGraphNodeEntryId } from './libraryGraph';

describe('updateRawLibraryGraphNodeEntryId', () => {
  const graph = {
    version: 2,
    extension: { keep: true },
    nodes: [
      {
        id: 'outline-node',
        label: 'Entry',
        props: { entryId: 'entry-old', counterId: 'counter-a', custom: 7 },
        topLevelExtension: 'keep'
      },
      { id: 'other-node', label: 'Entry', props: { entryId: 'entry-other' } },
      'malformed-node'
    ],
    relationships: [
      { from: 'outline-node', to: 'other-node', label: 'branch', order: 3 },
      { from: 'other-node', to: 'outline-node', label: 'custom', extension: true },
      'malformed-relationship'
    ]
  };

  it('changes only the indexed Entry reference and preserves node identity and topology', () => {
    const original = structuredClone(graph);
    const result = updateRawLibraryGraphNodeEntryId(graph, 'outline-node', 'entry-new');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual({
      ...graph,
      nodes: [
        {
          id: 'outline-node',
          label: 'Entry',
          props: { entryId: 'entry-new', counterId: 'counter-a', custom: 7 },
          topLevelExtension: 'keep'
        },
        graph.nodes[1],
        'malformed-node'
      ]
    });
    expect(result.value.relationships).toBe(graph.relationships);
    expect(graph).toEqual(original);
  });

  it.each([
    ['', 'invalid'],
    [' entry-new', 'invalid'],
    ['entry-new\n', 'invalid']
  ] as const)('rejects invalid target %j without mutating graph', (entryId, reason) => {
    const original = structuredClone(graph);
    expect(updateRawLibraryGraphNodeEntryId(graph, 'outline-node', entryId))
      .toEqual({ ok: false, reason });
    expect(graph).toEqual(original);
  });

  it('rejects missing and malformed target nodes without replacing their data', () => {
    expect(updateRawLibraryGraphNodeEntryId(graph, 'missing', 'entry-new'))
      .toEqual({ ok: false, reason: 'notFound' });
    const malformedProps = {
      nodes: [{ id: 'outline-node', label: 'Entry', props: 'do-not-replace' }],
      relationships: []
    };
    expect(updateRawLibraryGraphNodeEntryId(malformedProps, 'outline-node', 'entry-new'))
      .toEqual({ ok: false, reason: 'invalid' });
    expect(malformedProps.nodes[0].props).toBe('do-not-replace');
  });
});
