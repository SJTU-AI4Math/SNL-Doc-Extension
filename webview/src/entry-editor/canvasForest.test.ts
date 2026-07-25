import { describe, expect, it } from 'vitest';
import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import {
  attachCanvasRoot,
  canPersistCanvasForest,
  canvasHoleIndex,
  createCanvasHole,
  detachCanvasSubtree,
  fillCanvasHole,
  deleteCanvasTarget,
  isCanvasHole,
  listCanvasTargets,
  moveCanvasCursor,
  reconcileCanvasArity,
  replaceCanvasTarget
} from './canvasForest';

const node = (macro_name: string, children: SnlSyntaxTree[] = []): SnlSyntaxTree => ({
  macro_name,
  kind: '',
  mdata: null,
  children
});

describe('Canvas forest detach semantics', () => {
  it('removes a nested subtree from its parent and appends it as a new root', () => {
    const original = node('root', [node('left'), node('right', [node('leaf')])]);
    const result = detachCanvasSubtree([original], 0, [1]);

    expect(result.map((root) => root.macro_name)).toEqual(['root', 'right']);
    expect(result[0].children).toHaveLength(2);
    expect(result[0].children[0].macro_name).toBe('left');
    expect(isCanvasHole(result[0].children[1])).toBe(true);
    expect(result[1].children[0].macro_name).toBe('leaf');
    expect(original.children.map((child) => child.macro_name)).toEqual(['left', 'right']);
  });

  it('supports detaching from an already detached root', () => {
    const forest = [node('root'), node('detached', [node('inner')])];
    const result = detachCanvasSubtree(forest, 1, [0]);

    expect(result.map((root) => root.macro_name)).toEqual(['root', 'detached', 'inner']);
    expect(result[1].children).toHaveLength(1);
    expect(isCanvasHole(result[1].children[0])).toBe(true);
  });

  it('preserves the vacated child index with a natural-size numbered hole', () => {
    const forest = [node('root', [node('first'), node('second')])];
    const result = detachCanvasSubtree(forest, 0, [0]);

    expect(result[0].children).toHaveLength(2);
    expect(isCanvasHole(result[0].children[0])).toBe(true);
    expect(canvasHoleIndex(result[0].children[0])).toBe(0);
    expect(result[0].children[0].macro_name).toContain('snlArgPlaceholder');
    expect(result[0].children[0].macro_name).not.toContain('\\rule');
    expect(result[0].children[1].macro_name).toBe('second');
    expect(detachCanvasSubtree(result, 0, [0])).toBe(result);
  });

  it('does not detach a block root or an invalid path', () => {
    const forest = [node('root', [node('child')])];
    expect(detachCanvasSubtree(forest, 0, [])).toBe(forest);
    expect(detachCanvasSubtree(forest, 0, [9])).toBe(forest);
  });

  it('attaches a detached root into a hole and removes that root block', () => {
    const forest = [
      node('root', [createCanvasHole(0), node('tail')]),
      node('detached', [node('leaf')])
    ];
    const result = attachCanvasRoot(forest, 1, 0, [0]);

    expect(result).toHaveLength(1);
    expect(result[0].children[0].macro_name).toBe('detached');
    expect(result[0].children[1].macro_name).toBe('tail');
  });

  it('rejects absorption into a non-hole or into the dragged root itself', () => {
    const forest = [node('root', [node('occupied')]), node('detached', [createCanvasHole(0)])];
    expect(attachCanvasRoot(forest, 1, 0, [0])).toBe(forest);
    expect(attachCanvasRoot(forest, 1, 1, [0])).toBe(forest);
  });

  it('fills a hole with a parsed subtree and lists nodes in depth-first Tab order', () => {
    const forest = [node('root', [createCanvasHole(0), node('tail')])];
    const filled = fillCanvasHole(forest, 0, [0], node('parsed', [node('inner')]));

    expect(filled[0].children[0].macro_name).toBe('parsed');
    expect(listCanvasTargets(filled).map((target) => target.path.join('.'))).toEqual([
      '', '0', '0.0', '1'
    ]);
  });

  it('replaces any focused subtree, including a root', () => {
    const forest = [node('root', [node('old')]), node('floating')];
    const childReplaced = replaceCanvasTarget(forest, 0, [0], node('new', [node('leaf')]));
    expect(childReplaced[0].children[0].macro_name).toBe('new');
    expect(childReplaced[0].children[0].children[0].macro_name).toBe('leaf');

    const rootReplaced = replaceCanvasTarget(childReplaced, 1, [], node('new-root'));
    expect(rootReplaced[1].macro_name).toBe('new-root');
  });

  it('allows persistence only with one root and no unresolved holes', () => {
    expect(canPersistCanvasForest([node('root')])).toBe(true);
    expect(canPersistCanvasForest([node('root', [createCanvasHole(0)])])).toBe(false);
    expect(canPersistCanvasForest([node('a'), node('b')])).toBe(false);
  });
});

describe('Canvas arity reconciliation', () => {
  it('evicts surplus children as their own roots when arity shrinks', () => {
    const forest = [node('root', [node('a'), node('b'), node('c')])];
    const next = reconcileCanvasArity(forest, 0, [], 1);

    expect(next[0].children.map((child) => child.macro_name)).toEqual(['a']);
    // Surplus subtrees pop out rather than vanishing.
    expect(next.slice(1).map((root) => root.macro_name)).toEqual(['b', 'c']);
  });

  it('adds empty slots when arity grows instead of resurrecting old children', () => {
    const forest = [node('root', [node('a')])];
    const next = reconcileCanvasArity(forest, 0, [], 3);

    expect(next).toHaveLength(1);
    expect(next[0].children[0].macro_name).toBe('a');
    expect(isCanvasHole(next[0].children[1])).toBe(true);
    expect(isCanvasHole(next[0].children[2])).toBe(true);
  });

  it('drops surplus empty slots without turning them into root blocks', () => {
    const forest = [node('root', [node('a'), createCanvasHole(1)])];
    const next = reconcileCanvasArity(forest, 0, [], 1);
    expect(next).toHaveLength(1);
    expect(next[0].children).toHaveLength(1);
  });

  it('leaves children untouched for dynamic arity', () => {
    const forest = [node('root', [node('a'), node('b')])];
    expect(reconcileCanvasArity(forest, 0, [], -1)).toBe(forest);
  });

  it('reconciles a nested node without disturbing its siblings', () => {
    const forest = [node('root', [node('keep'), node('shrink', [node('x'), node('y')])])];
    const next = reconcileCanvasArity(forest, 0, [1], 1);
    expect(next[0].children[0].macro_name).toBe('keep');
    expect(next[0].children[1].children.map((c) => c.macro_name)).toEqual(['x']);
    expect(next.slice(1).map((root) => root.macro_name)).toEqual(['y']);
  });
});

describe('Canvas cursor navigation', () => {
  const forest = [
    node('root', [node('a', [node('a0'), node('a1')]), node('b')]),
    node('second')
  ];

  it('cycles among siblings of the same Macro', () => {
    expect(moveCanvasCursor(forest, { rootIndex: 0, path: [0, 0] }, 'next')).toEqual({ rootIndex: 0, path: [0, 1] });
    expect(moveCanvasCursor(forest, { rootIndex: 0, path: [0, 1] }, 'next')).toEqual({ rootIndex: 0, path: [0, 0] });
    expect(moveCanvasCursor(forest, { rootIndex: 0, path: [0, 0] }, 'previous')).toEqual({ rootIndex: 0, path: [0, 1] });
  });

  it('cycles among roots when the cursor is on a root', () => {
    expect(moveCanvasCursor(forest, { rootIndex: 0, path: [] }, 'next')).toEqual({ rootIndex: 1, path: [] });
    expect(moveCanvasCursor(forest, { rootIndex: 1, path: [] }, 'next')).toEqual({ rootIndex: 0, path: [] });
  });

  it('enters the first child and returns to the parent', () => {
    expect(moveCanvasCursor(forest, { rootIndex: 0, path: [] }, 'child')).toEqual({ rootIndex: 0, path: [0] });
    expect(moveCanvasCursor(forest, { rootIndex: 0, path: [0, 1] }, 'parent')).toEqual({ rootIndex: 0, path: [0] });
  });

  it('keeps the cursor still when a move is unavailable', () => {
    const leaf = { rootIndex: 0, path: [1] };
    expect(moveCanvasCursor(forest, leaf, 'child')).toBe(leaf);
    const root = { rootIndex: 0, path: [] };
    expect(moveCanvasCursor(forest, root, 'parent')).toBe(root);
  });
});

describe('Canvas delete', () => {
  it('collapses a nested node into an empty slot so arity is preserved', () => {
    const forest = [node('root', [node('a'), node('b')])];
    const next = deleteCanvasTarget(forest, 0, [0]);
    expect(next[0].children).toHaveLength(2);
    expect(isCanvasHole(next[0].children[0])).toBe(true);
    expect(next[0].children[1].macro_name).toBe('b');
  });

  it('removes the whole block when the target is a root', () => {
    const forest = [node('first'), node('second')];
    expect(deleteCanvasTarget(forest, 0, []).map((root) => root.macro_name)).toEqual(['second']);
  });

  it('is a no-op on an already empty slot', () => {
    const forest = [node('root', [createCanvasHole(0)])];
    expect(deleteCanvasTarget(forest, 0, [0])).toBe(forest);
  });
});

describe('Canvas arity round-trip', () => {
  it('never resurrects evicted children when the same node regains arity', () => {
    const shrinkTarget = node('root', [node('a'), node('b'), node('c')]);
    const shrunk = reconcileCanvasArity([shrinkTarget], 0, [], 1);
    expect(shrunk.slice(1).map((root) => root.macro_name)).toEqual(['b', 'c']);

    // Grow the SAME node object back: the old children must not come back.
    const grown = reconcileCanvasArity(shrunk, 0, [], 3);
    expect(grown[0].children[0].macro_name).toBe('a');
    expect(isCanvasHole(grown[0].children[1])).toBe(true);
    expect(isCanvasHole(grown[0].children[2])).toBe(true);
    // The evicted blocks are still their own roots, not duplicated back in.
    expect(grown.slice(1).map((root) => root.macro_name)).toEqual(['b', 'c']);
  });

  it('numbers grown slots by their child index', () => {
    const grown = reconcileCanvasArity([node('root', [node('a')])], 0, [], 3);
    expect(canvasHoleIndex(grown[0].children[1])).toBe(1);
    expect(canvasHoleIndex(grown[0].children[2])).toBe(2);
  });

  it('reports evicted subtrees before they are appended to the forest', () => {
    // Callers use this hook to assign a stable identity; it must fire for
    // every evicted subtree and only when the reconcile actually happens.
    const seen: SnlSyntaxTree[] = [];
    const next = reconcileCanvasArity(
      [node('root', [node('a'), node('b')])], 0, [], 1,
      (subtree) => seen.push(subtree)
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(next[1]);

    const untouched: SnlSyntaxTree[] = [];
    reconcileCanvasArity([node('root', [node('a')])], 0, [], 1, (s) => untouched.push(s));
    expect(untouched).toEqual([]);
  });

  it('reports every evicted subtree so callers can stabilise its identity', () => {
    const evicted: string[] = [];
    reconcileCanvasArity([node('root', [node('a'), node('b'), node('c')])], 0, [], 1, (subtree) => {
      evicted.push(subtree.macro_name);
    });
    expect(evicted).toEqual(['b', 'c']);
  });
});

describe('Canvas delete slot numbering', () => {
  it('numbers the replacement slot by the deleted child index', () => {
    const next = deleteCanvasTarget([node('root', [node('a'), node('b')])], 0, [1]);
    expect(canvasHoleIndex(next[0].children[1])).toBe(1);
  });
});
