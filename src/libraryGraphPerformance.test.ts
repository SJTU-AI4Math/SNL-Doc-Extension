import { describe, expect, it } from 'vitest';
import {
  indexLibraryGraph,
  numberAllForIndexed,
  numberFor,
  type CounterNode,
  type GraphNode,
  type GraphRelationship,
  type LibraryGraph
} from './libraryGraph';

function countedIterable<T>(values: T[], onIterate: () => void): T[] {
  return new Proxy(values, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) onIterate();
      return Reflect.get(target, property, receiver);
    }
  });
}

describe('library graph indexed numbering', () => {
  it('reuses one graph index across all node-number lookups', () => {
    let nodeWalks = 0;
    let relationshipWalks = 0;
    const nodes: GraphNode[] = [
      { id: 'n1', label: 'Entry', props: { entryId: 'e1' } },
      { id: 'n2', label: 'Entry', props: { entryId: 'e2' } },
      { id: 'n3', label: 'Entry', props: { entryId: 'e3' } }
    ];
    const relationships: GraphRelationship[] = [
      { from: 'n1', to: 'n2', label: 'branch' },
      { from: 'n1', to: 'n3', label: 'branch' }
    ];
    const graph: LibraryGraph = {
      nodes: countedIterable(nodes, () => { nodeWalks += 1; }),
      relationships: countedIterable(relationships, () => { relationshipWalks += 1; })
    };
    const entries = new Map([
      ['e1', { kind: 'k' }],
      ['e2', { kind: 'k' }],
      ['e3', { kind: 'k' }]
    ]);
    const kinds = new Map([['k', { defaultCounterName: 'main' }]]);
    const counters: CounterNode[] = [
      { id: 'counter', name: 'main', numbering: '1.', children: [] }
    ];

    const index = indexLibraryGraph(graph);
    const walksAfterIndex = { nodeWalks, relationshipWalks };
    const numberMap = numberAllForIndexed(index, entries, kinds, counters);
    const numbers = nodes.map((node) => numberMap.get(node.id));

    expect(numbers).toEqual(['1.', '2.', '3.']);
    expect({ nodeWalks, relationshipWalks }).toEqual(walksAfterIndex);
    expect(walksAfterIndex).toEqual({ nodeWalks: 2, relationshipWalks: 1 });
  });

  it('preserves the public numberFor API', () => {
    const graph: LibraryGraph = {
      nodes: [{ id: 'n', label: 'Entry', props: { entryId: 'e' } }],
      relationships: []
    };
    const entries = new Map([['e', { kind: 'k' }]]);
    const kinds = new Map([['k', { defaultCounterName: 'main' }]]);
    const counters: CounterNode[] = [
      { id: 'counter', name: 'main', numbering: '(A)', children: [] }
    ];

    expect(numberFor(graph, 'n', entries, kinds, counters)).toBe('(A)');
  });
});
