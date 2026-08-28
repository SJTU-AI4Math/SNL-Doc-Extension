import { describe, expect, it } from 'vitest';
import { applyLibraryCounterDraftOp, applyLibraryGraphDraftOp } from './libraryDraftOperations';

describe('Library draft pure transforms', () => {
  it('applies graph topology and property operations without mutating the input', () => {
    const graph = {
      nodes: [
        { id: 'a', label: 'Entry', props: { entryId: 'entry-a', extension: 1 } },
        { id: 'b', label: 'Entry', props: { entryId: 'entry-b' } }
      ],
      relationships: [{ from: 'a', to: 'b', label: 'branch' }]
    };
    const outdented = applyLibraryGraphDraftOp(graph, { op: 'outdent', nodeId: 'b' });
    expect(outdented?.relationships).toEqual([]);
    expect(graph.relationships).toHaveLength(1);
    const updated = applyLibraryGraphDraftOp(outdented!, {
      op: 'setNodeEntryId', nodeId: 'a', expectedEntryId: 'entry-a', entryId: 'entry-c'
    });
    expect(updated?.nodes[0].props).toEqual({ entryId: 'entry-c', extension: 1 });
  });

  it('applies nested counter operations without mutating the input', () => {
    const counters = [{ id: 'a', name: 'A', numbering: '1', children: [
      { id: 'b', name: 'B', numbering: 'a', children: [] }
    ] }];
    const updated = applyLibraryCounterDraftOp(counters, {
      op: 'updateFields', id: 'b', patch: { name: 'Local B' }
    });
    expect(updated?.[0].children[0].name).toBe('Local B');
    expect(counters[0].children[0].name).toBe('B');
  });
});
