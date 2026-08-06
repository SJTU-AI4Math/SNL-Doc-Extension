import { describe, expect, it } from 'vitest';
import {
  indexLibraryGraph,
  numberAllForIndexed,
  numberFor,
  type CounterNode,
  type LibraryGraph
} from './libraryGraph';

const counters: CounterNode[] = [{
  id: 'chapter', name: 'chapter', numbering: '1', children: [{
    id: 'section', name: 'section', numbering: '.1', children: [{
      id: 'theorem', name: 'theorem', numbering: 'A', children: []
    }]
  }]
}];

const sequence = [
  ['a', 'chapter'], ['b', 'section'], ['c', 'theorem'],
  ['d', 'section'], ['e', 'theorem'], ['x', ''],
  ['f', 'chapter'], ['g', 'section'], ['h', 'theorem']
] as const;

function graph(edges: Array<[string, string]>): LibraryGraph {
  return {
    nodes: sequence.map(([id, counterId]) => ({
      id, label: 'Entry', props: counterId ? { counterId } : {}
    })),
    relationships: edges.map(([from, to]) => ({ from, to, label: 'branch' }))
  };
}

const nested = graph(sequence.slice(1).map(([id], index) => [sequence[index][0], id]));
const flat = graph(sequence.slice(1).map(([id]) => ['a', id]));
const emptyEntries = new Map();
const emptyKinds = new Map();

describe('Library-linear Counter hierarchy numbering', () => {
  it('numbers the natural linear order independently of Entry tree shape', () => {
    const nestedNumbers = numberAllForIndexed(
      indexLibraryGraph(nested), emptyEntries, emptyKinds, counters
    );
    const flatNumbers = numberAllForIndexed(
      indexLibraryGraph(flat), emptyEntries, emptyKinds, counters
    );
    const expected = new Map<string, string | null>([
      ['a', '1'], ['b', '1.1'], ['c', '1.1A'],
      ['d', '1.2'], ['e', '1.2A'], ['x', null],
      ['f', '2'], ['g', '2.1'], ['h', '2.1A']
    ]);
    expect(nestedNumbers).toEqual(expected);
    expect(flatNumbers).toEqual(expected);
  });

  it('resets descendant counters only when their hierarchy parent advances', () => {
    const numbers = numberAllForIndexed(
      indexLibraryGraph(nested), emptyEntries, emptyKinds, counters
    );
    expect(numbers.get('c')).toBe('1.1A');
    expect(numbers.get('e')).toBe('1.2A');
    expect(numbers.get('h')).toBe('2.1A');
  });

  it('keeps each Library numbering scope independent', () => {
    expect(numberFor(nested, 'h', emptyEntries, emptyKinds, counters)).toBe('2.1A');
    expect(numberFor(graph([]), 'a', emptyEntries, emptyKinds, counters)).toBe('1');
  });
});
