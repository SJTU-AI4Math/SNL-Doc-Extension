import { moveGraphSibling } from './graphSiblingOrder';

export interface LibraryDraftGraphNode {
  id: string;
  label: string;
  props: Record<string, unknown>;
}
export interface LibraryDraftGraphRelationship {
  from: string;
  to: string;
  label: string;
  /** Ephemeral host-provided identity for preserving raw relationship extensions. */
  _draftKey?: string;
}
export interface LibraryDraftGraph {
  nodes: LibraryDraftGraphNode[];
  relationships: LibraryDraftGraphRelationship[];
}
export interface LibraryDraftCounter {
  id: string;
  name: string;
  numbering: string;
  children: LibraryDraftCounter[];
}
export type LibraryDraftOperation = { op?: string; [key: string]: unknown };

function cloneGraph(graph: LibraryDraftGraph): LibraryDraftGraph {
  return {
    nodes: graph.nodes.map((node) => ({ ...node, props: { ...node.props } })),
    relationships: graph.relationships.map((relationship) => ({ ...relationship }))
  };
}

function freshGraphNodeId(nodes: LibraryDraftGraphNode[]): string {
  const ids = new Set(nodes.map(({ id }) => id));
  let index = 1;
  while (ids.has(`n_${index}`)) index += 1;
  return `n_${index}`;
}

export function applyLibraryGraphDraftOp(
  input: LibraryDraftGraph,
  op: LibraryDraftOperation
): LibraryDraftGraph | null {
  let { nodes, relationships } = cloneGraph(input);
  switch (op.op) {
    case 'addNode':
    case 'wrapNode': {
      const entryId = typeof op.entryId === 'string' ? op.entryId.trim() : '';
      if (!entryId) return null;
      const parentId = typeof op.parentId === 'string' ? op.parentId : null;
      const wrapTargetId = op.op === 'wrapNode' && typeof op.wrapTargetId === 'string'
        ? op.wrapTargetId : null;
      if (parentId && !nodes.some(({ id }) => id === parentId)) return null;
      if (op.op === 'wrapNode' && (!wrapTargetId || !nodes.some(({ id }) => id === wrapTargetId))) return null;
      const id = freshGraphNodeId(nodes);
      const props: Record<string, unknown> = { entryId };
      const counterId = typeof op.counterId === 'string' ? op.counterId.trim() : '';
      if (counterId) props.counterId = counterId;
      const node = { id, label: 'Entry', props };
      if (wrapTargetId) {
        const targetIndex = nodes.findIndex((value) => value.id === wrapTargetId);
        const incoming = relationships
          .map((relationship, index) => ({ relationship, index }))
          .filter(({ relationship }) => relationship.label === 'branch' && relationship.to === wrapTargetId);
        if (incoming.length > 1) return null;
        nodes.splice(targetIndex, 0, node);
        if (incoming.length === 0) relationships.push({ from: id, to: wrapTargetId, label: 'branch' });
        else {
          const index = incoming[0].index;
          relationships.splice(index, 1,
            { ...relationships[index], to: id },
            { from: id, to: wrapTargetId, label: 'branch' });
        }
      } else {
        nodes.push(node);
        if (parentId) {
          const relationship = { from: parentId, to: id, label: 'branch' };
          const insertAfter = typeof op.insertAfter === 'string' ? op.insertAfter : null;
          const index = insertAfter ? relationships.findIndex((value) =>
            value.label === 'branch' && value.from === parentId && value.to === insertAfter) : -1;
          if (index >= 0) relationships.splice(index + 1, 0, relationship);
          else relationships.push(relationship);
        }
      }
      return { nodes, relationships };
    }
    case 'deleteNode': {
      const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '';
      if (!nodeId || relationships.some((value) => value.label === 'branch' && value.from === nodeId)) return null;
      if (!nodes.some(({ id }) => id === nodeId)) return null;
      nodes = nodes.filter(({ id }) => id !== nodeId);
      relationships = relationships.filter(({ from, to }) => from !== nodeId && to !== nodeId);
      return { nodes, relationships };
    }
    case 'moveSibling': {
      const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '';
      const direction = op.direction === 'up' || op.direction === 'down' ? op.direction : null;
      if (!nodeId || !direction) return null;
      return moveGraphSibling(nodes, relationships, nodeId, direction, op.toEdge === true);
    }
    case 'indent': {
      const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '';
      const parentIndex = relationships.findIndex((value) => value.label === 'branch' && value.to === nodeId);
      if (parentIndex >= 0) {
        const parent = relationships[parentIndex].from;
        const siblings = relationships
          .map((value, index) => ({ value, index }))
          .filter(({ value }) => value.label === 'branch' && value.from === parent);
        const position = siblings.findIndex(({ value }) => value.to === nodeId);
        if (position <= 0) return null;
        relationships[parentIndex] = { ...relationships[parentIndex], from: siblings[position - 1].value.to };
        return { nodes, relationships };
      }
      const nodeIndex = nodes.findIndex(({ id }) => id === nodeId);
      if (nodeIndex <= 0) return null;
      const children = new Set(relationships.filter(({ label }) => label === 'branch').map(({ to }) => to));
      const previousRoot = nodes.slice(0, nodeIndex).reverse().find(({ id }) => !children.has(id));
      if (!previousRoot) return null;
      relationships.push({ from: previousRoot.id, to: nodeId, label: 'branch' });
      return { nodes, relationships };
    }
    case 'outdent': {
      const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '';
      const parentIndex = relationships.findIndex((value) => value.label === 'branch' && value.to === nodeId);
      if (parentIndex < 0) return null;
      const parent = relationships[parentIndex].from;
      const grandIndex = relationships.findIndex((value) => value.label === 'branch' && value.to === parent);
      if (grandIndex < 0) relationships.splice(parentIndex, 1);
      else relationships[parentIndex] = { ...relationships[parentIndex], from: relationships[grandIndex].from };
      return { nodes, relationships };
    }
    case 'updateNodeProps': {
      const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '';
      const index = nodes.findIndex(({ id }) => id === nodeId);
      if (index < 0) return null;
      const props = { ...nodes[index].props };
      const counterId = typeof op.counterId === 'string' ? op.counterId.trim() : '';
      if (counterId) props.counterId = counterId;
      else delete props.counterId;
      nodes[index] = { ...nodes[index], props };
      return { nodes, relationships };
    }
    case 'setNodeEntryId': {
      const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '';
      const entryId = typeof op.entryId === 'string' ? op.entryId.trim() : '';
      const index = nodes.findIndex(({ id }) => id === nodeId);
      if (index < 0 || !entryId) return null;
      const current = typeof nodes[index].props.entryId === 'string' ? nodes[index].props.entryId : null;
      if (current !== (typeof op.expectedEntryId === 'string' ? op.expectedEntryId : null)) return null;
      nodes[index] = { ...nodes[index], props: { ...nodes[index].props, entryId } };
      return { nodes, relationships };
    }
    default:
      return null;
  }
}

interface CounterLocation {
  list: LibraryDraftCounter[];
  index: number;
  parent: LibraryDraftCounter | null;
}
function locateCounter(nodes: LibraryDraftCounter[], id: string, parent: LibraryDraftCounter | null = null): CounterLocation | null {
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index].id === id) return { list: nodes, index, parent };
    const nested = locateCounter(nodes[index].children, id, nodes[index]);
    if (nested) return nested;
  }
  return null;
}
function cloneCounters(nodes: LibraryDraftCounter[]): LibraryDraftCounter[] {
  return nodes.map((node) => ({ ...node, children: cloneCounters(node.children) }));
}
function freshCounterId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `counter-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function counterSeed(raw: unknown): LibraryDraftCounter {
  const seed = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    id: freshCounterId(),
    name: typeof seed.name === 'string' ? seed.name : 'counter',
    numbering: typeof seed.numbering === 'string' ? seed.numbering : '1',
    children: []
  };
}
function insert(list: LibraryDraftCounter[], node: LibraryDraftCounter, after: unknown): void {
  const index = typeof after === 'string' ? list.findIndex(({ id }) => id === after) : -1;
  if (index >= 0) list.splice(index + 1, 0, node);
  else list.push(node);
}

export function applyLibraryCounterDraftOp(
  input: LibraryDraftCounter[],
  op: LibraryDraftOperation
): LibraryDraftCounter[] | null {
  const roots = cloneCounters(input);
  switch (op.op) {
    case 'addRoot': insert(roots, counterSeed(op.seed), op.insertAfter); return roots;
    case 'addChild': {
      const location = locateCounter(roots, typeof op.parentId === 'string' ? op.parentId : '');
      if (!location) return null;
      insert(location.list[location.index].children, counterSeed(op.seed), op.insertAfter);
      return roots;
    }
    case 'wrapParent': {
      const location = locateCounter(roots, typeof op.id === 'string' ? op.id : '');
      if (!location) return null;
      const parent = counterSeed(op.seed);
      parent.children.push(location.list[location.index]);
      location.list.splice(location.index, 1, parent);
      return roots;
    }
    case 'updateFields': {
      const location = locateCounter(roots, typeof op.id === 'string' ? op.id : '');
      if (!location) return null;
      const patch = op.patch && typeof op.patch === 'object' ? op.patch as Record<string, unknown> : {};
      const node = location.list[location.index];
      if (typeof patch.name === 'string') node.name = patch.name;
      if (typeof patch.numbering === 'string') node.numbering = patch.numbering;
      return roots;
    }
    case 'move': {
      const location = locateCounter(roots, typeof op.id === 'string' ? op.id : '');
      const delta = op.direction === 'up' ? -1 : op.direction === 'down' ? 1 : 0;
      if (!location || !delta || location.index + delta < 0 || location.index + delta >= location.list.length) return null;
      [location.list[location.index], location.list[location.index + delta]] =
        [location.list[location.index + delta], location.list[location.index]];
      return roots;
    }
    case 'indent': {
      const location = locateCounter(roots, typeof op.id === 'string' ? op.id : '');
      if (!location || location.index <= 0) return null;
      const previous = location.list[location.index - 1];
      previous.children.push(location.list.splice(location.index, 1)[0]);
      return roots;
    }
    case 'outdent': {
      const location = locateCounter(roots, typeof op.id === 'string' ? op.id : '');
      if (!location?.parent) return null;
      const parentLocation = locateCounter(roots, location.parent.id);
      if (!parentLocation) return null;
      parentLocation.list.splice(parentLocation.index + 1, 0, location.list.splice(location.index, 1)[0]);
      return roots;
    }
    case 'delete': {
      const location = locateCounter(roots, typeof op.id === 'string' ? op.id : '');
      if (!location) return null;
      location.list.splice(location.index, 1);
      return roots;
    }
    default: return null;
  }
}
