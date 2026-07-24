import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';

export type CanvasTreePath = readonly number[];

const CANVAS_HOLE_KEY = '__snl_canvas_hole__';

export function createCanvasHole(widthPx = 16, heightPx = 16): SnlSyntaxTree {
  const widthEm = Math.max(0.25, Math.min(50, widthPx / 16));
  const heightEm = Math.max(0.25, Math.min(50, heightPx / 16));
  return {
    macro_name: `\\rule{${widthEm}em}{0pt}\\vphantom{\\rule{0pt}{${heightEm}em}}`,
    env_mode: 'formula_inline',
    kind: 'partial',
    mdata: { [CANVAS_HOLE_KEY]: true },
    children: []
  };
}

export function isCanvasHole(node: SnlSyntaxTree | undefined): boolean {
  if (!node?.mdata || typeof node.mdata !== 'object') return false;
  return (node.mdata as Record<string, unknown>)[CANVAS_HOLE_KEY] === true;
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

/**
 * Destructively changes the Canvas syntax forest (immutably): the selected
 * subtree is replaced by a non-persistable visual hole and appended as a root.
 */
export function detachCanvasSubtree(
  forest: readonly SnlSyntaxTree[],
  rootIndex: number,
  path: CanvasTreePath,
  hole: SnlSyntaxTree = createCanvasHole()
): SnlSyntaxTree[] {
  if (
    path.length === 0 ||
    !Number.isInteger(rootIndex) ||
    rootIndex < 0 ||
    rootIndex >= forest.length
  ) {
    return forest as SnlSyntaxTree[];
  }
  const result = detachFromTree(forest[rootIndex], path, hole);
  if (!result) return forest as SnlSyntaxTree[];
  const next = forest.slice();
  next[rootIndex] = result.tree;
  next.push(result.detached);
  return next;
}

export function canPersistCanvasForest(forest: readonly SnlSyntaxTree[]): boolean {
  return forest.length === 1;
}
