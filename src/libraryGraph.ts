/**
 * Pure numbering engine for library graphs (`.SNL_Doc/libraries/<slug>/graph.json`).
 *
 * v2 (2026-07-06) — see docs/library-graph-spec.md. This module has NO
 * vscode dependency so it's smoke-testable in isolation.
 *
 * Schema (radically simplified from v1):
 *   - one node label: "Entry"
 *   - one relationship label: "branch" (parent -> child)
 *   - sibling order = order of `branch` edges in the relationships[] array
 *   - reading order = DFS of branch in that same declaration order
 *   - numbering is derived from EntryKind.numbering of the FIRST child at
 *     each level (cat 2026-07-06: "按第一个 sub-entry 的 entry kind 里
 *     记录的 numbering 格式来")
 */

/** The only node label understood by v2. Anything else is retained as-is but
 *  ignored by the numbering engine. */
export type NodeLabel = 'Entry';

/** The only relationship label understood by v2. Anything else is ignored. */
export type RelLabel = 'branch';

export interface GraphNode {
  id: string;
  label: string; // typed loose so we can detect + warn on unknown labels
  props: {
    entryId?: string;
    [key: string]: unknown;
  };
}

export interface GraphRelationship {
  from: string;
  to: string;
  label: string; // typed loose so we can detect + warn on unknown labels
}

export interface LibraryGraph {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

/** Kind lookup shape needed by numberFor — a thin view of EntryKind. Since
 *  the 2026-07-16 rename, a kind names a Library-scoped counter (by
 *  `counter.name`) rather than carrying a numbering DSL directly. */
export interface KindCounterRef {
  defaultCounterName: string;
}

/** Entry lookup shape needed by numberFor — a thin view of EntryData. */
export interface EntryKindRef {
  kind?: string;
}

/**
 * A library-scoped counter tree node (mirrors `CounterNode` in src/snlDoc.ts;
 * duplicated here so this pure engine stays free of the vscode-importing
 * snlDoc module). Name-lookup picks the first depth-first match — duplicate
 * names are therefore ambiguous (the UI warns on collisions).
 */
export interface CounterNode {
  id: string;
  name: string;
  numbering: string;
  children: CounterNode[];
}

// ---------------------------------------------------------------------------
// §5 Magic-string formatter (unchanged from v1)
// ---------------------------------------------------------------------------

/** The five ordinal-slot characters. First occurrence wins; others literal. */
const SLOT_CHARS = new Set(['1', 'A', 'a', 'I', 'i']);

/**
 * Format ordinal `k` (1-indexed) through a numbering template.
 *
 * Recognises exactly `1 / A / a / I / i` as the ordinal slot; only the FIRST
 * such character in the template is replaced. All other characters, including
 * any subsequent `1/A/a/I/i`, are copied verbatim.
 *
 * Examples:
 *   formatNumbering("1", 3)      → "3"
 *   formatNumbering(".1", 3)     → ".3"
 *   formatNumbering("A", 3)      → "C"
 *   formatNumbering("(1)", 12)   → "(12)"
 *   formatNumbering("Ex. A.", 2) → "Ex. B."
 *   formatNumbering("§I.", 4)    → "§IV."
 *   formatNumbering("Foo", 3)    → "Foo"
 */
export function formatNumbering(template: string, k: number): string {
  if (!Number.isFinite(k) || k < 1) {
    return template;
  }
  const idx = firstSlotIndex(template);
  if (idx < 0) {
    return template;
  }
  const slot = template[idx];
  return template.slice(0, idx) + renderSlot(slot, k) + template.slice(idx + 1);
}

function firstSlotIndex(template: string): number {
  for (let i = 0; i < template.length; i++) {
    if (SLOT_CHARS.has(template[i])) return i;
  }
  return -1;
}

function renderSlot(slot: string, k: number): string {
  switch (slot) {
    case '1':
      return String(k);
    case 'A':
      return toExcelColumn(k, false);
    case 'a':
      return toExcelColumn(k, true);
    case 'I':
      return toRoman(k, false);
    case 'i':
      return toRoman(k, true);
    default:
      return slot; // unreachable
  }
}

/** Bijective base-26 (A, B, ..., Z, AA, AB, ...). 1-indexed. */
function toExcelColumn(k: number, lower: boolean): string {
  const base = lower ? 'a'.charCodeAt(0) : 'A'.charCodeAt(0);
  let n = k;
  let out = '';
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(base + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function toRoman(k: number, lower: boolean): string {
  if (k < 1) return '';
  const pairs: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
  ];
  let n = k;
  let out = '';
  for (const [v, sym] of pairs) {
    while (n >= v) {
      out += sym;
      n -= v;
    }
  }
  return lower ? out.toLowerCase() : out;
}

// ---------------------------------------------------------------------------
// Graph indexing
// ---------------------------------------------------------------------------

/** Precomputed indices used by numberFor / readingOrder. */
export interface LibraryGraphIndex {
  nodesById: Map<string, GraphNode>;
  /** For each node id, the ordered list of its CHILDREN via branch edges in
   *  the order those edges appear in relationships[]. */
  childrenOf: Map<string, string[]>;
  /** For each node id, its (single) branch parent, or undefined for roots. */
  parentOf: Map<string, string>;
  /** Roots in `nodes[]` declaration order (nodes with no incoming branch). */
  roots: string[];
}

export function indexLibraryGraph(graph: LibraryGraph): LibraryGraphIndex {
  const nodesById = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    nodesById.set(n.id, n);
  }
  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const r of graph.relationships) {
    if (r.label !== 'branch') continue;
    const list = childrenOf.get(r.from);
    if (list) {
      list.push(r.to);
    } else {
      childrenOf.set(r.from, [r.to]);
    }
    // First branch parent wins; extra edges are graph-level errors but we
    // don't crash — numberFor prefers the first walk.
    if (!parentOf.has(r.to)) {
      parentOf.set(r.to, r.from);
    }
  }
  const roots: string[] = [];
  for (const n of graph.nodes) {
    if (!parentOf.has(n.id)) {
      roots.push(n.id);
    }
  }
  return { nodesById, childrenOf, parentOf, roots };
}

// ---------------------------------------------------------------------------
// §3 Numbering
// ---------------------------------------------------------------------------

/**
 * Depth-first find a counter by exact `name` (first match wins). Duplicate
 * names in the tree are ambiguous — this returns the first one encountered in
 * a pre-order walk. The UI warns on duplicate names so authors can
 * disambiguate.
 */
export function findCounterByName(
  counters: CounterNode[],
  name: string
): CounterNode | null {
  const target = name.trim();
  if (!target) return null;
  for (const c of counters) {
    if (c.name === target) return c;
    const found = findCounterByName(c.children, target);
    if (found) return found;
  }
  return null;
}

/** Depth-first find a counter by id. */
function findCounterById(
  counters: CounterNode[],
  id: string
): CounterNode | null {
  for (const c of counters) {
    if (c.id === id) return c;
    const found = findCounterById(c.children, id);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve a node's "active counter" via the three-tier fallback:
 *   1. an explicit `node.props.counterId` that exists in the tree, else
 *   2. name-lookup of `kind.defaultCounterName` (depth-first, first match), else
 *   3. `null` — the node contributes no numbering.
 *
 * A dangling `counterId` (present but not in the tree) is treated as unset and
 * falls through to the name lookup.
 */
export function resolveActiveCounter(
  node: GraphNode,
  kind: KindCounterRef | undefined,
  counters: CounterNode[]
): CounterNode | null {
  const counterId = node.props?.counterId;
  if (typeof counterId === 'string' && counterId) {
    const byId = findCounterById(counters, counterId);
    if (byId) return byId;
  }
  const name = kind?.defaultCounterName;
  if (typeof name === 'string' && name.trim()) {
    return findCounterByName(counters, name);
  }
  return null;
}

/** Resolve the EntryKind view for a node (via its entry's kind), or undefined. */
function kindForNode(
  node: GraphNode,
  entriesById: Map<string, EntryKindRef>,
  kindsById: Map<string, KindCounterRef>
): KindCounterRef | undefined {
  const entryId = node.props?.entryId;
  if (typeof entryId !== 'string' || !entryId) return undefined;
  const entry = entriesById.get(entryId);
  if (!entry || typeof entry.kind !== 'string' || !entry.kind) return undefined;
  return kindsById.get(entry.kind);
}

/** Natural one-dimensional reading order for one Library index. */
function readingOrderIndexed(idx: LibraryGraphIndex): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const dfs = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    out.push(nodeId);
    for (const child of idx.childrenOf.get(nodeId) ?? []) dfs(child);
  };
  for (const root of idx.roots) dfs(root);
  for (const nodeId of idx.nodesById.keys()) dfs(nodeId);
  return out;
}

function counterHierarchyPaths(counters: CounterNode[]): Map<CounterNode, readonly CounterNode[]> {
  const paths = new Map<CounterNode, readonly CounterNode[]>();
  const visiting = new Set<CounterNode>();
  const visit = (counter: CounterNode, parentPath: readonly CounterNode[]): void => {
    if (visiting.has(counter) || paths.has(counter)) return;
    visiting.add(counter);
    const path = [...parentPath, counter];
    paths.set(counter, path);
    for (const child of counter.children) visit(child, path);
    visiting.delete(counter);
  };
  for (const counter of counters) visit(counter, []);
  return paths;
}

function resetCounterDescendants(
  counter: CounterNode,
  values: Map<CounterNode, number>,
  seen = new Set<CounterNode>()
): void {
  if (seen.has(counter)) return;
  seen.add(counter);
  for (const child of counter.children) {
    values.delete(child);
    resetCounterDescendants(child, values, seen);
  }
}

/**
 * Number every Entry in one Library operation.
 *
 * Numbering consumes only the Library's natural one-dimensional reading order.
 * Entry branch ancestry never contributes a number. Counter hierarchy supplies
 * the prefix/reset semantics: advancing a counter resets all descendants, and
 * a counter's rendered number is the concatenation of its initialized ancestor
 * segments plus its own segment.
 */
export function numberAllForIndexed(
  idx: LibraryGraphIndex,
  entriesById: Map<string, EntryKindRef>,
  kindsById: Map<string, KindCounterRef>,
  counters: CounterNode[]
): Map<string, string | null> {
  const paths = counterHierarchyPaths(counters);
  const values = new Map<CounterNode, number>();
  const numbers = new Map<string, string | null>();

  for (const nodeId of readingOrderIndexed(idx)) {
    const node = idx.nodesById.get(nodeId);
    if (!node) continue;
    const kind = kindForNode(node, entriesById, kindsById);
    const counter = resolveActiveCounter(node, kind, counters);
    const path = counter ? paths.get(counter) : undefined;
    if (!counter || !path) {
      numbers.set(nodeId, null);
      continue;
    }

    values.set(counter, (values.get(counter) ?? 0) + 1);
    resetCounterDescendants(counter, values);

    const segments: string[] = [];
    let initialized = true;
    for (const level of path) {
      const value = values.get(level);
      if (value === undefined) {
        initialized = false;
        break;
      }
      segments.push(formatNumbering(level.numbering, value));
    }
    numbers.set(nodeId, initialized ? segments.join('') : null);
  }
  return numbers;
}

/** Compute one node's number within its Library-scoped linear sequence. */
export function numberFor(
  graph: LibraryGraph,
  nodeId: string,
  entriesById: Map<string, EntryKindRef>,
  kindsById: Map<string, KindCounterRef>,
  counters: CounterNode[]
): string | null {
  return numberForIndexed(
    indexLibraryGraph(graph), nodeId, entriesById, kindsById, counters
  );
}

/** Compute one node number from a prebuilt graph index. */
export function numberForIndexed(
  idx: LibraryGraphIndex,
  nodeId: string,
  entriesById: Map<string, EntryKindRef>,
  kindsById: Map<string, KindCounterRef>,
  counters: CounterNode[]
): string | null {
  return numberAllForIndexed(idx, entriesById, kindsById, counters).get(nodeId) ?? null;
}

// ---------------------------------------------------------------------------
// §4 Reading order — DFS on branch, root order = nodes[] declaration order
// ---------------------------------------------------------------------------

/**
 * Linear reading order over all Entry nodes: DFS from each root in
 * `nodes[]` declaration order, visiting children in `relationships[]`
 * declaration order. Returns node ids (not entryIds).
 *
 * Nodes not reachable from any root (orphans wrt branch tree) are appended
 * at the end so no entry is silently dropped.
 */
export function readingOrder(graph: LibraryGraph): string[] {
  return readingOrderIndexed(indexLibraryGraph(graph));
}
