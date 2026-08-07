export interface NestedTreeNode<T> {
  id: string;
  children: T[];
}

function locateNestedNode<T extends NestedTreeNode<T>>(
  roots: T[],
  targetId: string
): { list: T[]; index: number } | null {
  for (let index = 0; index < roots.length; index += 1) {
    const node = roots[index];
    if (node.id === targetId) return { list: roots, index };
    const nested = locateNestedNode(node.children, targetId);
    if (nested) return nested;
  }
  return null;
}

/** Mutates a nested tree by replacing target with parent(target). */
export function wrapNestedNodeWithParent<T extends NestedTreeNode<T>>(
  roots: T[],
  targetId: string,
  parent: T
): boolean {
  if (parent.id === targetId || locateNestedNode(roots, parent.id)) return false;
  const target = locateNestedNode(roots, targetId);
  if (!target) return false;
  const node = target.list[target.index];
  parent.children = [node];
  target.list[target.index] = parent;
  return true;
}
