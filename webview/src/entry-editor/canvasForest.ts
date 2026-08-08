import {
  createEmptySnlSyntaxTreeNode,
  isEmptySnlSyntaxTreeNode,
  type SnlSyntaxTree
} from '@sjtu-ai4math/snl-basics/core';

export type CanvasTreePath = readonly number[];

const CANVAS_HOLE_KEY = '__snl_canvas_hole__';
const CANVAS_HOLE_INDEX_KEY = '__snl_canvas_hole_index__';

/** Schema for persisted Canvas ASTs; old Tree2 drafts are intentionally discarded. */
export const CANVAS_FOREST_DRAFT_VERSION = 3 as const;

function sanitizeCanvasNodeForDraft(node: SnlSyntaxTree): SnlSyntaxTree {
  let mdata = node.mdata;
  if (mdata && typeof mdata === 'object' && !Array.isArray(mdata)) {
    const next = { ...(mdata as Record<string, unknown>) };
    delete next.bindRef;
    mdata = Object.keys(next).length > 0 ? next : null;
  }
  return {
    ...node,
    kind: node.kind === 'partial' ? 'sub' : node.kind,
    mdata,
    children: node.children.map(sanitizeCanvasNodeForDraft)
  };
}

/** Never persist derived binding links; they are recomputed by the renderer. */
export function sanitizeCanvasForestForDraft(forest: readonly SnlSyntaxTree[]): SnlSyntaxTree[] {
  return forest.map(sanitizeCanvasNodeForDraft);
}

/** Refuse stale/unversioned AST drafts rather than allowing Tree2 state to return. */
export function restoreCanvasForestDraft(
  value: unknown,
  version: unknown
): SnlSyntaxTree[] | undefined {
  if (version !== CANVAS_FOREST_DRAFT_VERSION || !Array.isArray(value)) return undefined;
  return sanitizeCanvasForestForDraft(value as SnlSyntaxTree[]);
}

export interface CanvasTarget {
  rootIndex: number;
  path: CanvasTreePath;
  node: SnlSyntaxTree;
}

/**
 * An unfilled argument slot.
 *
 * Cat 2026-07-25: this is now the SNL empty node (`macro_name === ''`), which
 * the parser produces for `f(a,,b)` and the renderer draws as the numbered
 * placeholder. It therefore SERIALIZES and ROUND TRIPS — an entry saved with
 * unfilled slots reopens with those slots still in place. The `mdata` marker
 * is kept as a fast path for Canvas-authored holes, but detection must not
 * depend on it, since `mdata` does not survive a text round trip.
 */
export function createCanvasHole(index = 0): SnlSyntaxTree {
  const safeIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  return {
    ...createEmptySnlSyntaxTreeNode(),
    kind: 'argPlaceholder',
    mdata: {
      [CANVAS_HOLE_KEY]: true,
      [CANVAS_HOLE_INDEX_KEY]: safeIndex
    }
  };
}

export function isCanvasHole(node: SnlSyntaxTree | undefined): boolean {
  if (!node) return false;
  // Structural check first: this is what makes a reopened entry work.
  if (isEmptySnlSyntaxTreeNode(node)) return true;
  if (!node.mdata || typeof node.mdata !== 'object') return false;
  return (node.mdata as Record<string, unknown>)[CANVAS_HOLE_KEY] === true;
}

/**
 * Which slot this hole was authored as, or null once it has been through a
 * text round trip (`mdata` does not survive serialization). Callers that need
 * a reliable index should use the child's position in its parent instead.
 */
export function canvasHoleIndex(node: SnlSyntaxTree | undefined): number | null {
  if (!isCanvasHole(node)) return null;
  const value = (node!.mdata as Record<string, unknown> | null)?.[CANVAS_HOLE_INDEX_KEY];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function nodeAtPath(tree: SnlSyntaxTree, path: CanvasTreePath): SnlSyntaxTree | undefined {
  let current: SnlSyntaxTree | undefined = tree;
  for (const index of path) current = current?.children[index];
  return current;
}

function replaceAtPath(
  tree: SnlSyntaxTree,
  path: CanvasTreePath,
  replacement: SnlSyntaxTree
): SnlSyntaxTree | null {
  if (path.length === 0) return replacement;
  const [index, ...rest] = path;
  if (!Number.isInteger(index) || index < 0 || index >= tree.children.length) {
    return null;
  }
  const child = replaceAtPath(tree.children[index], rest, replacement);
  if (!child) return null;
  const children = tree.children.slice();
  children[index] = child;
  return { ...tree, children };
}

interface DetachResult {
  tree: SnlSyntaxTree;
  detached: SnlSyntaxTree;
}

function detachFromTree(
  tree: SnlSyntaxTree,
  path: CanvasTreePath,
  hole: SnlSyntaxTree
): DetachResult | null {
  if (path.length === 0) return null;
  const [index, ...rest] = path;
  if (!Number.isInteger(index) || index < 0 || index >= tree.children.length) {
    return null;
  }
  if (rest.length === 0) {
    if (isCanvasHole(tree.children[index])) return null;
    const children = tree.children.slice();
    children[index] = hole;
    return {
      tree: { ...tree, children },
      detached: tree.children[index]
    };
  }
  const nested = detachFromTree(tree.children[index], rest, hole);
  if (!nested) return null;
  const children = tree.children.slice();
  children[index] = nested.tree;
  return {
    tree: { ...tree, children },
    detached: nested.detached
  };
}

/** Replace a nested subtree with a numbered Canvas slot and append it as a root. */
export function detachCanvasSubtree(
  forest: readonly SnlSyntaxTree[],
  rootIndex: number,
  path: CanvasTreePath,
  removeSlot = false
): SnlSyntaxTree[] {
  if (
    path.length === 0 ||
    !Number.isInteger(rootIndex) ||
    rootIndex < 0 ||
    rootIndex >= forest.length
  ) {
    return forest as SnlSyntaxTree[];
  }
  const hole = createCanvasHole(path[path.length - 1]);
  const result = detachFromTree(forest[rootIndex], path, hole);
  if (!result) return forest as SnlSyntaxTree[];
  const next = forest.slice();
  // A dynamic-arity parent has no fixed positions, so the vacated slot is
  // removed rather than left as a blank the author cannot clear.
  next[rootIndex] = removeSlot
    ? removeChildAt(result.tree, path) ?? result.tree
    : result.tree;
  next.push(result.detached);
  return next;
}

/** Drop the child at `path` from its parent, shrinking the parent's arity. */
function removeChildAt(tree: SnlSyntaxTree, path: CanvasTreePath): SnlSyntaxTree | null {
  const parentPath = path.slice(0, -1);
  const parent = nodeAtPath(tree, parentPath);
  if (!parent) return null;
  const children = parent.children.slice();
  children.splice(path[path.length - 1], 1);
  return replaceAtPath(tree, parentPath, { ...parent, children });
}

/** Insert one detached root into a slot and remove its former root block. */
export function attachCanvasRoot(
  forest: readonly SnlSyntaxTree[],
  draggedRootIndex: number,
  targetRootIndex: number,
  targetPath: CanvasTreePath,
  append = false
): SnlSyntaxTree[] {
  if (
    draggedRootIndex === targetRootIndex ||
    draggedRootIndex < 0 ||
    targetRootIndex < 0 ||
    draggedRootIndex >= forest.length ||
    targetRootIndex >= forest.length
  ) {
    return forest as SnlSyntaxTree[];
  }
  // Route C: a variadic Macro grows a new argument at the drop instead of
  // filling an existing slot, so `targetPath` points one past its last child.
  const attached = append
    ? appendChildAt(forest[targetRootIndex], targetPath, forest[draggedRootIndex])
    : isCanvasHole(nodeAtPath(forest[targetRootIndex], targetPath))
      ? replaceAtPath(forest[targetRootIndex], targetPath, forest[draggedRootIndex])
      : null;
  if (!attached) return forest as SnlSyntaxTree[];
  const next = forest.slice();
  next[targetRootIndex] = attached;
  next.splice(draggedRootIndex, 1);
  return next;
}

/** Insert `subtree` as the child at `path`, growing the parent's arity. */
function appendChildAt(
  tree: SnlSyntaxTree,
  path: CanvasTreePath,
  subtree: SnlSyntaxTree
): SnlSyntaxTree | null {
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const parent = nodeAtPath(tree, parentPath);
  if (!parent) return null;
  const index = path[path.length - 1];
  if (!Number.isInteger(index) || index < 0 || index > parent.children.length) return null;
  const children = parent.children.slice();
  children.splice(index, 0, subtree);
  return replaceAtPath(tree, parentPath, { ...parent, children });
}

/** Replace any focused subtree (or an entire root) with parsed SNL. */
export function replaceCanvasTarget(
  forest: readonly SnlSyntaxTree[],
  targetRootIndex: number,
  targetPath: CanvasTreePath,
  subtree: SnlSyntaxTree
): SnlSyntaxTree[] {
  if (targetRootIndex < 0 || targetRootIndex >= forest.length) {
    return forest as SnlSyntaxTree[];
  }
  const root = replaceAtPath(forest[targetRootIndex], targetPath, subtree);
  if (!root) return forest as SnlSyntaxTree[];
  const next = forest.slice();
  next[targetRootIndex] = root;
  return next;
}

/** Replace an unresolved slot with a parsed SNL subtree. */
export function fillCanvasHole(
  forest: readonly SnlSyntaxTree[],
  targetRootIndex: number,
  targetPath: CanvasTreePath,
  subtree: SnlSyntaxTree
): SnlSyntaxTree[] {
  if (targetRootIndex < 0 || targetRootIndex >= forest.length) {
    return forest as SnlSyntaxTree[];
  }
  if (!isCanvasHole(nodeAtPath(forest[targetRootIndex], targetPath))) {
    return forest as SnlSyntaxTree[];
  }
  const root = replaceAtPath(forest[targetRootIndex], targetPath, subtree);
  if (!root) return forest as SnlSyntaxTree[];
  const next = forest.slice();
  next[targetRootIndex] = root;
  return next;
}

export function listCanvasTargets(forest: readonly SnlSyntaxTree[]): CanvasTarget[] {
  const targets: CanvasTarget[] = [];
  const visit = (node: SnlSyntaxTree, rootIndex: number, path: number[]): void => {
    targets.push({ rootIndex, path, node });
    node.children.forEach((child, index) => visit(child, rootIndex, [...path, index]));
  };
  forest.forEach((root, rootIndex) => visit(root, rootIndex, []));
  return targets;
}

function hasCanvasHole(node: SnlSyntaxTree): boolean {
  return isCanvasHole(node) || node.children.some(hasCanvasHole);
}

export type CanvasMove = 'next' | 'previous' | 'child' | 'parent';

export interface CanvasCursor {
  rootIndex: number;
  path: CanvasTreePath;
}

/**
 * Structural tree navigation (cat 2026-07-25).
 *
 *   next / previous — cycle among siblings (always children of the same
 *                     Macro). At a root, cycle among roots instead.
 *   child           — enter the first child; unavailable on a leaf.
 *   parent          — go to the parent; unavailable at a root.
 *
 * Unavailable moves return the cursor unchanged (null when there is none).
 */
export function moveCanvasCursor(
  forest: readonly SnlSyntaxTree[],
  cursor: CanvasCursor | null,
  move: CanvasMove
): CanvasCursor | null {
  if (forest.length === 0) return null;
  if (!cursor) {
    // No cursor yet: sibling motion lands on the first/last root.
    if (move === 'next') return { rootIndex: 0, path: [] };
    if (move === 'previous') return { rootIndex: forest.length - 1, path: [] };
    return null;
  }
  const root = forest[cursor.rootIndex];
  if (!root) return null;
  const node = nodeAtPath(root, cursor.path);
  if (!node) return null;

  if (move === 'child') {
    return node.children.length > 0
      ? { rootIndex: cursor.rootIndex, path: [...cursor.path, 0] }
      : cursor;
  }
  if (move === 'parent') {
    return cursor.path.length > 0
      ? { rootIndex: cursor.rootIndex, path: cursor.path.slice(0, -1) }
      : cursor;
  }

  const delta = move === 'next' ? 1 : -1;
  if (cursor.path.length === 0) {
    const count = forest.length;
    return {
      rootIndex: (cursor.rootIndex + delta + count) % count,
      path: []
    };
  }
  const parent = nodeAtPath(root, cursor.path.slice(0, -1));
  const count = parent?.children.length ?? 0;
  if (count === 0) return cursor;
  const index = cursor.path[cursor.path.length - 1];
  return {
    rootIndex: cursor.rootIndex,
    path: [...cursor.path.slice(0, -1), (index + delta + count) % count]
  };
}

/**
 * Delete the node at `path`.
 *
 * A nested node normally collapses into an empty slot so its parent's arity is
 * preserved. When the parent is DYNAMIC-arity the slot itself is removed
 * instead (`removeSlot`), because a variadic Macro has no fixed positions —
 * otherwise it would accumulate blank slots the author can never get rid of.
 * Deleting a root removes the whole block. Cat 2026-07-25.
 */
export function deleteCanvasTarget(
  forest: readonly SnlSyntaxTree[],
  rootIndex: number,
  path: CanvasTreePath,
  removeSlot = false
): SnlSyntaxTree[] {
  const source = forest as SnlSyntaxTree[];
  if (rootIndex < 0 || rootIndex >= forest.length) return source;
  if (path.length === 0) {
    const next = forest.slice();
    next.splice(rootIndex, 1);
    return next;
  }
  const existing = nodeAtPath(forest[rootIndex], path);
  if (!existing) return source;
  if (removeSlot) {
    const root = removeChildAt(forest[rootIndex], path);
    if (!root) return source;
    const next = forest.slice();
    next[rootIndex] = root;
    return next;
  }
  if (isCanvasHole(existing)) return source;
  const hole = createCanvasHole(path[path.length - 1]);
  const root = replaceAtPath(forest[rootIndex], path, hole);
  if (!root) return source;
  const next = forest.slice();
  next[rootIndex] = root;
  return next;
}

/**
 * True for the one shape that has NO surface form: a node whose single child
 * is an unfilled slot.
 *
 * `f(<hole>)` would serialize to `f()`, which the parser reads back as ZERO
 * arguments — the slot silently disappears. Every other arity is fine, since
 * an empty slot is expressed by a comma (`f(,)`, `f(a,)`, `f(a,,b)`).
 * Cat 2026-07-25.
 */
function hasUnserializableLoneSlot(node: SnlSyntaxTree): boolean {
  if (node.children.length === 1 && isCanvasHole(node.children[0])) return true;
  return node.children.some(hasUnserializableLoneSlot);
}

/**
 * A Canvas forest is serializable when it is a single tree that can be written
 * and read back unchanged.
 *
 * Cat 2026-07-25: unfilled slots NO LONGER block saving — an empty slot is a
 * real SNL node (`f(a,,b)`) that round trips, so saving a half-finished tree
 * is a legitimate author workflow. Two shapes still block, both because they
 * genuinely cannot be serialized: several disconnected root blocks (no single
 * tree to write) and a lone unfilled slot (`f()` reparses as zero arguments).
 */
export function canPersistCanvasForest(forest: readonly SnlSyntaxTree[]): boolean {
  if (forest.length !== 1) return false;
  // A bare slot as the whole tree serializes to the empty string, which is
  // not parseable at all.
  if (isCanvasHole(forest[0])) return false;
  return !hasUnserializableLoneSlot(forest[0]);
}

/** True when any slot is still unfilled — advisory only, never a save gate. */
export function canvasForestHasUnfilledSlots(forest: readonly SnlSyntaxTree[]): boolean {
  return forest.some(hasCanvasHole);
}

/**
 * Set how many arguments a DYNAMIC-arity node has.
 *
 * Fixed arity is derived from the Macro template and reconciled
 * ({@link reconcileCanvasArity}); dynamic arity is authored, so it needs a
 * writable operation instead:
 *
 *  - growing appends empty slots, never resurrecting evicted children;
 *  - shrinking sheds EMPTY SLOTS FIRST, wherever they sit, and only evicts
 *    real subtrees (to the forest, as their own root blocks) once no blank
 *    remains. This differs from `reconcileCanvasArity`, which truncates from
 *    the tail: a variadic Macro has no fixed positions, so removing a blank
 *    from the middle loses nothing, whereas truncating would evict content
 *    while a blank survived;
 *  - `nextCount` is clamped at 0 — a variadic Macro with no arguments is
 *    legal SNL (`f`), so there is no reason to force a minimum.
 *
 * Returns the same array reference when nothing changes, so callers keep
 * their no-op / undo semantics. Cat 2026-07-25.
 */
export function setCanvasDynamicArity(
  forest: readonly SnlSyntaxTree[],
  rootIndex: number,
  path: CanvasTreePath,
  nextCount: number,
  onEvict?: (subtree: SnlSyntaxTree) => void
): SnlSyntaxTree[] {
  const source = forest as SnlSyntaxTree[];
  if (rootIndex < 0 || rootIndex >= forest.length) return source;
  const node = nodeAtPath(forest[rootIndex], path);
  if (!node) return source;
  const target = Math.max(0, Math.trunc(nextCount));
  if (target === node.children.length) return source;

  let kept: SnlSyntaxTree[];
  const evicted: SnlSyntaxTree[] = [];
  if (target > node.children.length) {
    kept = node.children.slice();
    while (kept.length < target) kept.push(createCanvasHole(kept.length));
  } else {
    // Shed empty slots before real content, wherever they sit, so shrinking
    // never throws away a subtree while a blank slot survives.
    kept = node.children.slice();
    while (kept.length > target) {
      const lastEmpty = kept.map(isCanvasHole).lastIndexOf(true);
      const dropAt = lastEmpty === -1 ? kept.length - 1 : lastEmpty;
      const [removed] = kept.splice(dropAt, 1);
      if (!isCanvasHole(removed)) evicted.push(removed);
    }
  }

  const root = replaceAtPath(forest[rootIndex], path, { ...node, children: kept });
  if (!root) return source;
  for (const subtree of evicted) onEvict?.(subtree);
  const next = forest.slice();
  next[rootIndex] = root;
  next.push(...evicted);
  return next;
}

/**
 * Reconcile a node's children with the arity its (new) Macro requires.
 *
 * Cat 2026-07-25: changing a Macro must never silently swallow or resurrect
 * subtrees. Surplus children are evicted to the forest as their own root
 * blocks so the author can re-place them; new slots appear as empty
 * placeholders the author fills manually. Empty placeholders are dropped
 * rather than evicted — there is nothing to preserve.
 *
 * `arity < 0` means dynamic arity: children are left untouched.
 */
export function reconcileCanvasArity(
  forest: readonly SnlSyntaxTree[],
  rootIndex: number,
  path: CanvasTreePath,
  arity: number,
  onEvict?: (subtree: SnlSyntaxTree) => void
): SnlSyntaxTree[] {
  const source = forest as SnlSyntaxTree[];
  if (arity < 0 || rootIndex < 0 || rootIndex >= forest.length) return source;
  const node = nodeAtPath(forest[rootIndex], path);
  if (!node || node.children.length === arity) return source;

  const kept = node.children.slice(0, arity);
  const evicted = node.children.slice(arity).filter((child) => !isCanvasHole(child));
  // Grown slots are always empty: a Macro that regains arity must not
  // resurrect the children a previous shrink evicted.
  while (kept.length < arity) kept.push(createCanvasHole(kept.length));

  const root = replaceAtPath(forest[rootIndex], path, { ...node, children: kept });
  if (!root) return source;
  for (const subtree of evicted) onEvict?.(subtree);
  const next = forest.slice();
  next[rootIndex] = root;
  next.push(...evicted);
  return next;
}
