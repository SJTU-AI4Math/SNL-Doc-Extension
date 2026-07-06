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

/** Kind lookup shape needed by numberFor — a thin view of EntryKind. */
export interface KindNumbering {
  numbering: string;
}

/** Entry lookup shape needed by numberFor — a thin view of EntryData. */
export interface EntryKindRef {
  kind?: string;
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

/** Fallback template for a level whose first child has no resolvable kind. */
const FALLBACK_LEVEL_NUMBERING = '.1';

/**
 * Compute the full number of a node (e.g. `"1.3B.5"`).
 *
 * `entriesById` maps shared-pool entryId -> EntryData (only `.kind` is
 * consulted). `kindsById` maps kind.id -> EntryKind (only `.numbering` is
 * consulted). Both are typically Maps built from readEntries/readEntryKinds.
 *
 * Returns `null` if the node doesn't exist or its branch chain is broken
 * (cycle, missing parent). Returns "" for a lone root node (roots ARE
 * numbered via §6, using the first-root kind at the root level — see
 * numberRootLevel below).
 */
export function numberFor(
  graph: LibraryGraph,
  nodeId: string,
  entriesById: Map<string, EntryKindRef>,
  kindsById: Map<string, KindNumbering>
): string | null {
  const idx = indexGraph(graph);
  if (!idx.nodesById.has(nodeId)) return null;

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

  // For each non-root node in the chain, compute its per-level segment
  // using its parent's first child's kind. Roots use the "root level"
  // kind — enumerated across ALL roots in nodes[] declaration order.
  const segments: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const cur = chain[i];
    const parent = i === 0 ? null : chain[i - 1];
    const siblings = parent === null ? idx.roots : idx.childrenOf.get(parent) ?? [];
    const position = siblings.indexOf(cur);
    if (position < 0) return null;

    const firstSibling = siblings[0];
    const template = numberingTemplateFor(
      firstSibling,
      idx,
      entriesById,
      kindsById
    );
    segments.push(formatNumbering(template, position + 1));
  }
  return segments.join('');
}

/**
 * Resolve the numbering template for a level, given the FIRST child at
 * that level (whose kind decides). Falls back to `.1` when the kind is
 * unresolvable at any step.
 */
function numberingTemplateFor(
  firstChildId: string,
  idx: GraphIndex,
  entriesById: Map<string, EntryKindRef>,
  kindsById: Map<string, KindNumbering>
): string {
  const node = idx.nodesById.get(firstChildId);
  if (!node) return FALLBACK_LEVEL_NUMBERING;
  const entryId = node.props?.entryId;
  if (typeof entryId !== 'string' || !entryId) {
    return FALLBACK_LEVEL_NUMBERING;
  }
  const entry = entriesById.get(entryId);
  if (!entry || typeof entry.kind !== 'string' || !entry.kind) {
    return FALLBACK_LEVEL_NUMBERING;
  }
  const kind = kindsById.get(entry.kind);
  if (!kind || typeof kind.numbering !== 'string' || !kind.numbering) {
    return FALLBACK_LEVEL_NUMBERING;
  }
  return kind.numbering;
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
