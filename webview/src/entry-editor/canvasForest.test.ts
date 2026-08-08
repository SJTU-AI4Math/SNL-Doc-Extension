import { describe, expect, it } from 'vitest';
import { tryParseSnlSyntaxTree, type SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { serializeTreePreserving, stripEmptyPlaceholders } from '../CreateEntryApp';
import {
  attachCanvasRoot,
  canPersistCanvasForest,
  canvasForestHasUnfilledSlots,
  canvasHoleIndex,
  CANVAS_FOREST_DRAFT_VERSION,
  createCanvasHole,
  detachCanvasSubtree,
  fillCanvasHole,
  deleteCanvasTarget,
  isCanvasHole,
  listCanvasTargets,
  moveCanvasCursor,
  reconcileCanvasArity,
  restoreCanvasForestDraft,
  sanitizeCanvasForestForDraft,
  setCanvasDynamicArity,
  replaceCanvasTarget
} from './canvasForest';

const node = (macro_name: string, children: SnlSyntaxTree[] = []): SnlSyntaxTree => ({
  macro_name,
  kind: '',
  mdata: null,
  children
});

describe('Canvas draft schema safety', () => {
  it('discards unversioned Tree2 forests so they cannot resurrect stale state', () => {
    expect(restoreCanvasForestDraft([node('legacy')], undefined)).toBeUndefined();
    expect(restoreCanvasForestDraft([node('legacy')], CANVAS_FOREST_DRAFT_VERSION - 1)).toBeUndefined();
  });

  it('strips derived bindRef recursively while preserving unrelated metadata', () => {
    const forest = [{
      ...node('root', [{
        ...node('child'), kind: 'partial',
        mdata: { bindRef: 'b1', src: 'ctx', canvas: { x: 2 } }
      }]),
      mdata: { bindRef: 'b0', provenance: 'keep' }
    }];
    const sanitized = sanitizeCanvasForestForDraft(forest);
    expect(sanitized).toEqual([{
      ...node('root', [{
        ...node('child'), kind: 'sub',
        postfix: { type: 'name', name: 'ctx' },
        mdata: { canvas: { x: 2 } }
      }]),
      mdata: { provenance: 'keep' }
    }]);
    expect(forest[0].mdata).toHaveProperty('bindRef', 'b0');
    expect(restoreCanvasForestDraft(sanitized, CANVAS_FOREST_DRAFT_VERSION)).toEqual(sanitized);
  });
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

  it('preserves the vacated child index with a numbered hole', () => {
    const forest = [node('root', [node('first'), node('second')])];
    const result = detachCanvasSubtree(forest, 0, [0]);

    expect(result[0].children).toHaveLength(2);
    expect(isCanvasHole(result[0].children[0])).toBe(true);
    expect(canvasHoleIndex(result[0].children[0])).toBe(0);
    // A hole is the SNL empty node now, so it serializes as nothing between
    // two commas rather than as a KaTeX blob that cannot be reparsed.
    expect(result[0].children[0].macro_name).toBe('');
    expect(result[0].children[0].env_mode).toBeUndefined();
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

  it('allows persistence with unfilled slots, but not with unwritable shapes', () => {
    expect(canPersistCanvasForest([node('root')])).toBe(true);
    // Cat 2026-07-25: a half-finished tree is a legitimate thing to save, as
    // long as the slots survive the text round trip.
    expect(canPersistCanvasForest([node('root', [node('a'), createCanvasHole(1)])])).toBe(true);
    expect(canPersistCanvasForest([node('root', [createCanvasHole(0), createCanvasHole(1)])])).toBe(true);
    // Several disconnected blocks genuinely have no single tree to write.
    expect(canPersistCanvasForest([node('a'), node('b')])).toBe(false);
    // A LONE slot has no surface form: `f(<hole>)` serializes to `f()`, which
    // reparses as zero arguments and silently loses the slot.
    expect(canPersistCanvasForest([node('neg', [createCanvasHole(0)])])).toBe(false);
    // ...including when it is nested deeper in the tree.
    expect(canPersistCanvasForest([node('root', [node('neg', [createCanvasHole(0)])])])).toBe(false);
    // A bare slot as the entire tree serializes to '' and does not parse.
    expect(canPersistCanvasForest([createCanvasHole(0)])).toBe(false);
  });

  it('reports unfilled slots separately, as advice rather than a gate', () => {
    expect(canvasForestHasUnfilledSlots([node('root')])).toBe(false);
    expect(canvasForestHasUnfilledSlots([node('root', [createCanvasHole(0)])])).toBe(true);
    expect(canvasForestHasUnfilledSlots([node('root', [node('a', [createCanvasHole(0)])])])).toBe(true);
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

describe('Canvas hole text round trip', () => {
  it('survives serialize -> parse so a saved entry reopens with its slots', () => {
    const forest = [node('pair', [node('a'), createCanvasHole(1)])];
    const snl = serializeTreePreserving(forest[0]);
    // The hole is written as an empty argument, not as an unparseable blob.
    expect(snl).toBe('pair(a,)');

    const reparsed = tryParseSnlSyntaxTree(snl);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.tree.children).toHaveLength(2);
    // mdata does not survive the text round trip, so detection must be
    // structural — this is what makes reopening work.
    expect(reparsed.tree.children[1].mdata).toBeNull();
    expect(isCanvasHole(reparsed.tree.children[1])).toBe(true);
    expect(canPersistCanvasForest([reparsed.tree])).toBe(true);
  });

  it('round trips a hole in the middle of an argument list', () => {
    const forest = [node('triple', [node('a'), createCanvasHole(1), node('c')])];
    const snl = serializeTreePreserving(forest[0]);
    expect(snl).toBe('triple(a,,c)');

    const reparsed = tryParseSnlSyntaxTree(snl);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.tree.children.map(isCanvasHole)).toEqual([false, true, false]);
    // Serializing again is stable.
    expect(serializeTreePreserving(reparsed.tree)).toBe('triple(a,,c)');
  });
});

describe('Canvas lone-slot guard', () => {
  it('never lets a lone slot reach the file, because f() loses it', () => {
    const forest = [node('neg', [createCanvasHole(0)])];
    // Proof that the guard is necessary rather than defensive: the shape
    // really does not survive the round trip.
    const snl = serializeTreePreserving(forest[0]);
    expect(snl).toBe('neg()');
    const reparsed = tryParseSnlSyntaxTree(snl);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.tree.children).toHaveLength(0);

    expect(canPersistCanvasForest(forest)).toBe(false);
  });

  it('a slot beside any sibling is fine, because the comma carries it', () => {
    const forest = [node('pair', [node('a'), createCanvasHole(1)])];
    const snl = serializeTreePreserving(forest[0]);
    const reparsed = tryParseSnlSyntaxTree(snl);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.tree.children).toHaveLength(2);
    expect(canPersistCanvasForest(forest)).toBe(true);
  });
});

describe('Inductive editor empty-row pruning', () => {
  it('keeps unfilled rows so both editors agree on a half-finished tree', () => {
    // Cat 2026-07-25: these used to be silently dropped, so switching from
    // the Inductive tab to the Canvas tab lost the author's slots.
    const tree = node('root', [node('a'), node('')]);
    const pruned = stripEmptyPlaceholders(tree);
    expect(pruned.children).toHaveLength(2);
    expect(serializeTreePreserving(pruned)).toBe('root(a,)');

    const leading = stripEmptyPlaceholders(node('root', [node(''), node('b')]));
    expect(serializeTreePreserving(leading)).toBe('root(,b)');
  });

  it('still prunes the lone empty row, which cannot be serialized', () => {
    const pruned = stripEmptyPlaceholders(node('neg', [node('')]));
    expect(pruned.children).toHaveLength(0);
    expect(serializeTreePreserving(pruned)).toBe('neg');
  });

  it('prunes a lone empty row nested deeper too', () => {
    const pruned = stripEmptyPlaceholders(node('root', [node('a'), node('neg', [node('')])]));
    expect(pruned.children[1].children).toHaveLength(0);
    expect(serializeTreePreserving(pruned)).toBe('root(a,neg)');
  });
});

describe('Canvas dynamic arity', () => {
  it('appends empty slots when the author grows a variadic node', () => {
    const next = setCanvasDynamicArity([node('list', [node('a')])], 0, [], 3);
    expect(next).toHaveLength(1);
    expect(next[0].children[0].macro_name).toBe('a');
    expect(next[0].children.slice(1).every(isCanvasHole)).toBe(true);
  });

  it('drops empty slots before evicting real content when shrinking', () => {
    const forest = [node('list', [node('a'), createCanvasHole(1), node('c')])];
    const next = setCanvasDynamicArity(forest, 0, [], 2);
    // The blank slot goes first; 'c' survives in place, nothing is evicted.
    expect(next).toHaveLength(1);
    expect(next[0].children.map((child) => child.macro_name)).toEqual(['a', 'c']);
  });

  it('evicts real subtrees as their own blocks once slots run out', () => {
    const forest = [node('list', [node('a'), node('b'), node('c')])];
    const evicted: string[] = [];
    const next = setCanvasDynamicArity(forest, 0, [], 1, (subtree) => {
      evicted.push(subtree.macro_name);
    });
    expect(next[0].children.map((child) => child.macro_name)).toEqual(['a']);
    expect(next.slice(1).map((root) => root.macro_name)).toEqual(['c', 'b']);
    expect(evicted.sort()).toEqual(['b', 'c']);
  });

  it('allows shrinking all the way to zero, which is legal SNL', () => {
    const next = setCanvasDynamicArity([node('list', [createCanvasHole(0)])], 0, [], 0);
    expect(next[0].children).toEqual([]);
  });

  it('clamps a negative count and is a no-op at the current count', () => {
    const forest = [node('list', [node('a')])];
    expect(setCanvasDynamicArity(forest, 0, [], -5)[0].children).toEqual([]);
    // No change means the SAME reference, so undo/no-op semantics hold.
    expect(setCanvasDynamicArity(forest, 0, [], 1)).toBe(forest);
  });

  it('never resurrects evicted children when the count grows again', () => {
    const shrunk = setCanvasDynamicArity([node('list', [node('a'), node('b')])], 0, [], 1);
    const grown = setCanvasDynamicArity(shrunk, 0, [], 2);
    expect(grown[0].children[0].macro_name).toBe('a');
    expect(isCanvasHole(grown[0].children[1])).toBe(true);
    expect(grown.slice(1).map((root) => root.macro_name)).toEqual(['b']);
  });

  it('operates on a nested node without touching its siblings', () => {
    const forest = [node('root', [node('keep'), node('list', [node('x')])])];
    const next = setCanvasDynamicArity(forest, 0, [1], 2);
    expect(next[0].children[0].macro_name).toBe('keep');
    expect(next[0].children[1].children).toHaveLength(2);
    expect(isCanvasHole(next[0].children[1].children[1])).toBe(true);
  });
});

describe('Canvas delete and detach under a dynamic parent', () => {
  it('removes the slot entirely instead of leaving a blank', () => {
    const forest = [node('list', [node('a'), node('b'), node('c')])];
    const next = deleteCanvasTarget(forest, 0, [1], true);
    expect(next[0].children.map((child) => child.macro_name)).toEqual(['a', 'c']);
  });

  it('still collapses to a numbered slot for a fixed-arity parent', () => {
    const forest = [node('pair', [node('a'), node('b')])];
    const next = deleteCanvasTarget(forest, 0, [1]);
    expect(next[0].children).toHaveLength(2);
    expect(isCanvasHole(next[0].children[1])).toBe(true);
  });

  it('lets a dynamic parent delete an existing empty slot', () => {
    // The non-removeSlot path refuses this, which is why a variadic node
    // would otherwise accumulate blanks forever.
    const forest = [node('list', [node('a'), createCanvasHole(1)])];
    expect(deleteCanvasTarget(forest, 0, [1])).toBe(forest);
    expect(deleteCanvasTarget(forest, 0, [1], true)[0].children).toHaveLength(1);
  });

  it('shrinks the parent when a dynamic child is dragged out', () => {
    const forest = [node('list', [node('a'), node('b')])];
    const next = detachCanvasSubtree(forest, 0, [0], true);
    expect(next[0].children.map((child) => child.macro_name)).toEqual(['b']);
    expect(next[1].macro_name).toBe('a');
  });

  it('keeps the numbered slot when a fixed-arity child is dragged out', () => {
    const next = detachCanvasSubtree([node('pair', [node('a'), node('b')])], 0, [0]);
    expect(next[0].children).toHaveLength(2);
    expect(isCanvasHole(next[0].children[0])).toBe(true);
  });
});

describe('Canvas drag-to-append onto a variadic Macro', () => {
  it('grows the parent instead of requiring an existing slot', () => {
    const forest = [node('list', [node('a')]), node('dragged')];
    const next = attachCanvasRoot(forest, 1, 0, [1], true);
    expect(next).toHaveLength(1);
    expect(next[0].children.map((child) => child.macro_name)).toEqual(['a', 'dragged']);
  });

  it('can append onto a variadic Macro that has no arguments yet', () => {
    const next = attachCanvasRoot([node('list'), node('dragged')], 1, 0, [0], true);
    expect(next[0].children.map((child) => child.macro_name)).toEqual(['dragged']);
  });

  it('refuses an append position beyond the end', () => {
    const forest = [node('list', [node('a')]), node('dragged')];
    expect(attachCanvasRoot(forest, 1, 0, [5], true)).toBe(forest);
  });

  it('still requires an empty slot when not appending', () => {
    const forest = [node('pair', [node('a'), node('b')]), node('dragged')];
    // No hole at [1], so a non-append drop must be refused.
    expect(attachCanvasRoot(forest, 1, 0, [1], false)).toBe(forest);
  });
});
