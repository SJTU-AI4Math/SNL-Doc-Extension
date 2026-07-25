import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';

export type CanvasTreePath = readonly number[];

const CANVAS_HOLE_KEY = '__snl_canvas_hole__';
const CANVAS_HOLE_INDEX_KEY = '__snl_canvas_hole_index__';

export interface CanvasTarget {
  rootIndex: number;
  path: CanvasTreePath;
  node: SnlSyntaxTree;
}

export function createCanvasHole(index = 0): SnlSyntaxTree {
  const safeIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  return {
    macro_name: `\\mathord{\\htmlClass{snlArgPlaceholder}{${safeIndex}}}`,
    env_mode: 'formula_inline',
    kind: 'argPlaceholder',
    mdata: {
      [CANVAS_HOLE_KEY]: true,
      [CANVAS_HOLE_INDEX_KEY]: safeIndex
    },
    children: []
  };
}

export function isCanvasHole(node: SnlSyntaxTree | undefined): boolean {
  if (!node?.mdata || typeof node.mdata !== 'object') return false;
  return (node.mdata as Record<string, unknown>)[CANVAS_HOLE_KEY] === true;
}

export function canvasHoleIndex(node: SnlSyntaxTree | undefined): number | null {
  if (!isCanvasHole(node)) return null;
  const value = (node!.mdata as Record<string, unknown>)[CANVAS_HOLE_INDEX_KEY];
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
  path: CanvasTreePath
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
  next[rootIndex] = result.tree;
  next.push(result.detached);
  return next;
}

/** Insert one detached root into a slot and remove its former root block. */
export function attachCanvasRoot(
  forest: readonly SnlSyntaxTree[],
  draggedRootIndex: number,
  targetRootIndex: number,
  targetPath: CanvasTreePath
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
  if (!isCanvasHole(nodeAtPath(forest[targetRootIndex], targetPath))) {
    return forest as SnlSyntaxTree[];
  }
  const attached = replaceAtPath(
    forest[targetRootIndex],
    targetPath,
    forest[draggedRootIndex]
  );
  if (!attached) return forest as SnlSyntaxTree[];
  const next = forest.slice();
  next[targetRootIndex] = attached;
  next.splice(draggedRootIndex, 1);
  return next;
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

export function canPersistCanvasForest(forest: readonly SnlSyntaxTree[]): boolean {
  return forest.length === 1 && !hasCanvasHole(forest[0]);
}
