export interface StructuralTreeDescriptor {
  readonly id: string;
  readonly depth: number;
}

/** Describe every foldable node from the source model, including hidden branches. */
export function describeStructuralTree<T>(
  roots: readonly T[],
  getId: (node: T) => string,
  getChildren: (node: T) => readonly T[]
): StructuralTreeDescriptor[] {
  const result: StructuralTreeDescriptor[] = [];
  const visit = (node: T, depth: number): void => {
    const children = getChildren(node);
    if (children.length > 0) result.push({ id: getId(node), depth });
    for (const child of children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return result;
}

export function initialStructuralCollapse(
  descriptors: readonly StructuralTreeDescriptor[],
  defaultCollapsed: boolean
): Set<string> {
  return defaultCollapsed ? new Set(descriptors.map(({ id }) => id)) : new Set();
}

/** Prune removed ids and apply the surface default only to newly foldable ids. */
export function reconcileStructuralCollapse(
  collapsed: ReadonlySet<string>,
  previous: readonly StructuralTreeDescriptor[],
  next: readonly StructuralTreeDescriptor[],
  defaultCollapsed: boolean
): Set<string> {
  const previousIds = new Set(previous.map(({ id }) => id));
  const result = new Set<string>();
  for (const { id } of next) {
    if (collapsed.has(id) || (defaultCollapsed && !previousIds.has(id))) result.add(id);
  }
  // Preserve React state identity when reconciliation is semantically a no-op.
  // In particular, the initial effect must not leave a redundant state update
  // pending beside synchronous editor commands such as move followed by undo.
  if (
    collapsed instanceof Set
    && collapsed.size === result.size
    && [...result].every(id => collapsed.has(id))
  ) return collapsed;
  return result;
}

export function toggleStructuralNode(
  collapsed: ReadonlySet<string>,
  descriptors: readonly StructuralTreeDescriptor[],
  targetId: string,
  sameAbsoluteDepth: boolean
): Set<string> {
  const target = descriptors.find(({ id }) => id === targetId);
  if (!target) return new Set(collapsed);
  const shouldCollapse = !collapsed.has(targetId);
  const affected = sameAbsoluteDepth
    ? descriptors.filter(({ depth }) => depth === target.depth)
    : [target];
  const result = new Set(collapsed);
  for (const { id } of affected) {
    if (shouldCollapse) result.add(id);
    else result.delete(id);
  }
  return result;
}

export function setAllStructuralNodes(
  descriptors: readonly StructuralTreeDescriptor[],
  collapsed: boolean
): Set<string> {
  return collapsed ? new Set(descriptors.map(({ id }) => id)) : new Set();
}

export function structuralCollapseCapabilities(
  descriptors: readonly StructuralTreeDescriptor[],
  collapsed: ReadonlySet<string>
): { canExpand: boolean; canCollapse: boolean } {
  return {
    canExpand: descriptors.some(({ id }) => collapsed.has(id)),
    canCollapse: descriptors.some(({ id }) => !collapsed.has(id))
  };
}
