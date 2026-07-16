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
interface GraphIndex {
  nodesById: Map<string, GraphNode>;
  /** For each node id, the ordered list of its CHILDREN via branch edges in
   *  the order those edges appear in relationships[]. */
  childrenOf: Map<string, string[]>;
  /** For each node id, its (single) branch parent, or undefined for roots. */
  parentOf: Map<string, string>;
  /** Roots in `nodes[]` declaration order (nodes with no incoming branch). */
  roots: string[];
}

function indexGraph(graph: LibraryGraph): GraphIndex {
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

/**
 * Compute the full number of a node (e.g. `"1.3B.5"`).
 *
 * `entriesById` maps shared-pool entryId -> EntryData (only `.kind` is
 * consulted). `kindsById` maps kind.id -> EntryKind (only `.defaultCounterName`
 * is consulted). `counters` is the library's counter tree.
 *
 * Numbering rules (2026-07-16):
 *   - Each node's "active counter" is resolved via {@link resolveActiveCounter}.
 *     If the TARGET node resolves to no counter, this returns `null` (the entry
 *     contributes no numbering).
 *   - The template for a level is `counter.numbering` of the FIRST resolved
 *     counter among the siblings at that level. If no sibling resolves, the
 *     level yields no fragment (it is skipped).
 *   - Sibling position (1-indexed) is by outline order, counting ALL siblings
 *     regardless of whether they individually resolve to a counter.
 *
 * TODO(counter-tree reset semantics): the counter tree's parent/child
 * relationship is stored + shown in the UI but the numbering engine uses ONLY
 * each counter's own `numbering` DSL today. Cross-counter reset semantics
 * (sub-counters numerically nesting/resetting under their parent counter) land
 * in a follow-up once Fulcrum specs the reset rules; today the tree is
 * display-only for management purposes.
 *
 * Returns `null` if the node doesn't exist, its branch chain is broken (cycle,
 * missing parent), or the target node resolves to no counter.
 */
export function numberFor(
  graph: LibraryGraph,
  nodeId: string,
  entriesById: Map<string, EntryKindRef>,
  kindsById: Map<string, KindCounterRef>,
  counters: CounterNode[]
): string | null {
  const idx = indexGraph(graph);
  const targetNode = idx.nodesById.get(nodeId);
  if (!targetNode) return null;

  // The target must resolve to a counter, else it gets no numbering label.
  const targetKind = kindForNode(targetNode, entriesById, kindsById);
  if (!resolveActiveCounter(targetNode, targetKind, counters)) return null;

  // Walk branch parents back to a root. Chain = [root, ..., parent, node].
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = nodeId;
  while (cur !== undefined) {
    if (seen.has(cur)) return null; // cycle
    seen.add(cur);
    chain.unshift(cur);
    cur = idx.parentOf.get(cur);
  }
  if (chain.length === 0) return null;

  const segments: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const curId = chain[i];
    const parent = i === 0 ? null : chain[i - 1];
    const siblings = parent === null ? idx.roots : idx.childrenOf.get(parent) ?? [];
    const position = siblings.indexOf(curId);
    if (position < 0) return null;

    const template = levelTemplate(siblings, idx, entriesById, kindsById, counters);
    if (template === null) {
      // No sibling at this level resolves to any counter → skip the level.
      continue;
    }
    segments.push(formatNumbering(template, position + 1));
  }
  return segments.join('');
}

/**
 * Resolve the numbering template for a level: `counter.numbering` of the FIRST
 * sibling at that level that resolves to a counter. Returns `null` when no
 * sibling resolves (the caller skips the level).
 */
function levelTemplate(
  siblings: string[],
  idx: GraphIndex,
  entriesById: Map<string, EntryKindRef>,
  kindsById: Map<string, KindCounterRef>,
  counters: CounterNode[]
): string | null {
  for (const sibId of siblings) {
    const node = idx.nodesById.get(sibId);
    if (!node) continue;
    const kind = kindForNode(node, entriesById, kindsById);
    const counter = resolveActiveCounter(node, kind, counters);
    if (counter) return counter.numbering;
  }
  return null;
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
  const idx = indexGraph(graph);
  const out: string[] = [];
  const visited = new Set<string>();

  const dfs = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    out.push(nodeId);
    const children = idx.childrenOf.get(nodeId) ?? [];
    for (const child of children) {
      dfs(child);
    }
  };

  for (const root of idx.roots) {
    dfs(root);
  }
  // Orphans (had a parent that didn't exist, but branch edges got them in
  // childrenOf via a non-root walk). Append them to the tail in nodes[]
  // declaration order so nothing gets lost.
  for (const n of graph.nodes) {
    if (!visited.has(n.id)) {
      dfs(n.id);
    }
  }
  return out;
}
