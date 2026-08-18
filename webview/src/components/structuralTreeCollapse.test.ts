import { describe, expect, it } from 'vitest';
import {
  describeStructuralTree,
  initialStructuralCollapse,
  reconcileStructuralCollapse,
  setAllStructuralNodes,
  toggleStructuralNode
} from './structuralTreeCollapse';

interface Node { id: string; children: Node[] }
const forest: Node[] = [
  { id: 'a', children: [
    { id: 'a1', children: [{ id: 'a1x', children: [] }] },
    { id: 'a2', children: [] }
  ] },
  { id: 'b', children: [
    { id: 'b1', children: [{ id: 'b1x', children: [] }] }
  ] }
];
const descriptors = describeStructuralTree(forest, n => n.id, n => n.children);

describe('structural tree absolute-depth collapse model', () => {
  it('describes foldable nodes in hidden branches at absolute depths', () => {
    expect(descriptors).toEqual([
      { id: 'a', depth: 0 }, { id: 'a1', depth: 1 },
      { id: 'b', depth: 0 }, { id: 'b1', depth: 1 }
    ]);
  });

  it('applies the target next state to every foldable node at its absolute depth', () => {
    const start = new Set(['a', 'a1']);
    expect([...toggleStructuralNode(start, descriptors, 'b1', true)].sort())
      .toEqual(['a', 'a1', 'b1']);
    expect([...toggleStructuralNode(new Set(['a1', 'b1']), descriptors, 'a1', true)])
      .toEqual([]);
  });

  it('keeps plain and Meta disclosure toggles local', () => {
    const start = new Set(['a', 'a1']);
    expect([...toggleStructuralNode(start, descriptors, 'b', false)].sort())
      .toEqual(['a', 'a1', 'b']);
  });

  it('initializes defaults, supports all operations, and reconciles stale ids', () => {
    expect([...initialStructuralCollapse(descriptors, true)]).toEqual(['a', 'a1', 'b', 'b1']);
    expect([...setAllStructuralNodes(descriptors, false)]).toEqual([]);
    expect([...setAllStructuralNodes(descriptors, true)]).toEqual(['a', 'a1', 'b', 'b1']);
    const next = descriptors.filter(d => d.id !== 'a1').concat({ id: 'new', depth: 2 });
    expect([...reconcileStructuralCollapse(new Set(['a1', 'b', 'stale']), descriptors, next, true)])
      .toEqual(['b', 'new']);
  });
});
