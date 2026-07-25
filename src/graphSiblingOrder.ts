export interface OrderedGraphNode {
  id: string;
}

export interface OrderedGraphRelationship {
  from: string;
  to: string;
  label: string;
}

export interface GraphSiblingOrderResult<
  N extends OrderedGraphNode,
  R extends OrderedGraphRelationship
> {
  nodes: N[];
  relationships: R[];
}

/**
 * Reorder one node among siblings while preserving every unrelated array slot.
 * `toEdge` performs a stable move-to-front/back; otherwise it swaps one step.
 */
export function moveGraphSibling<
  N extends OrderedGraphNode,
  R extends OrderedGraphRelationship
>(
  nodes: readonly N[],
  relationships: readonly R[],
  nodeId: string,
  direction: 'up' | 'down',
  toEdge: boolean
): GraphSiblingOrderResult<N, R> {
  const nextNodes = [...nodes];
  const nextRelationships = [...relationships];
  const parentRel = nextRelationships.find(
    (relationship) => relationship.label === 'branch' && relationship.to === nodeId
  );

  const moveValuesAt = <T>(array: T[], indices: number[], current: number): void => {
    if (current < 0) return;
    const target = toEdge
      ? (direction === 'up' ? 0 : indices.length - 1)
      : current + (direction === 'up' ? -1 : 1);
    if (target < 0 || target >= indices.length || target === current) return;
    const values = indices.map((index) => array[index]);
    const [moved] = values.splice(current, 1);
    values.splice(target, 0, moved);
    indices.forEach((index, position) => { array[index] = values[position]; });
  };

  if (!parentRel) {
    const hasParent = (id: string): boolean => nextRelationships.some(
      (relationship) => relationship.label === 'branch' && relationship.to === id
    );
    const siblingIndices = nextNodes
      .map((node, index) => hasParent(node.id) ? -1 : index)
      .filter((index) => index >= 0);
    const current = siblingIndices.findIndex((index) => nextNodes[index].id === nodeId);
    moveValuesAt(nextNodes, siblingIndices, current);
    return { nodes: nextNodes, relationships: nextRelationships };
  }

  const siblingIndices = nextRelationships
    .map((relationship, index) =>
      relationship.label === 'branch' && relationship.from === parentRel.from ? index : -1
    )
    .filter((index) => index >= 0);
  const current = siblingIndices.findIndex(
    (index) => nextRelationships[index].to === nodeId
  );
  moveValuesAt(nextRelationships, siblingIndices, current);
  return { nodes: nextNodes, relationships: nextRelationships };
}
