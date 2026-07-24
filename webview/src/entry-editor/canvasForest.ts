import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';

export type CanvasTreePath = readonly number[];

interface DetachResult {
  tree: SnlSyntaxTree;
  detached: SnlSyntaxTree;
}

function detachFromTree(
  tree: SnlSyntaxTree,
  path: CanvasTreePath
): DetachResult | null {
  if (path.length === 0) return null;
  const [index, ...rest] = path;
  if (!Number.isInteger(index) || index < 0 || index >= tree.children.length) {
    return null;
  }
  if (rest.length === 0) {
    return {
      tree: {
        ...tree,
        children: tree.children.filter((_, childIndex) => childIndex !== index)
      },
      detached: tree.children[index]
    };
  }
  const nested = detachFromTree(tree.children[index], rest);
  if (!nested) return null;
  const children = tree.children.slice();
  children[index] = nested.tree;
  return {
    tree: { ...tree, children },
    detached: nested.detached
  };
}

/**
 * Destructively changes the Canvas syntax forest (immutably): the selected
 * subtree is removed from its parent root and appended as a new root.
 */
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
  const result = detachFromTree(forest[rootIndex], path);
  if (!result) return forest as SnlSyntaxTree[];
  const next = forest.slice();
  next[rootIndex] = result.tree;
  next.push(result.detached);
  return next;
}

export function canPersistCanvasForest(forest: readonly SnlSyntaxTree[]): boolean {
  return forest.length === 1;
}
