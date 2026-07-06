/**
 * Pure numbering engine for library graphs (`.SNL_Doc/libraries/<slug>/graph.json`).
 *
 * No vscode dependency — testable in isolation. See docs/library-graph-spec.md
 * for the full design; this module implements §5 (magic strings) and §4
 * (numbering derivation), plus §7 (reading order).
 */

/** Neo4j-style node labels understood by v1. Unknown labels are read as-is. */
export type NodeLabel = 'Counter' | 'Section' | 'Entry';

/** Relationship labels understood by v1. Unknown labels are ignored. */
export type RelLabel = 'count' | 'next' | 'branch' | 'reading-next';

export interface GraphNode {
  id: string;
  label: NodeLabel;
  props: Record<string, unknown>;
}

export interface GraphRelationship {
  from: string;
  to: string;
  label: RelLabel;
}

export interface LibraryGraph {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

// ---------------------------------------------------------------------------
// §5 Magic-string formatter
// ---------------------------------------------------------------------------

/** The five ordinal-slot characters. First occurrence wins; others literal. */
const SLOT_CHARS = new Set(['1', 'A', 'a', 'I', 'i']);

/**
 * Format ordinal `k` (1-indexed) through a numbering template.
 *
 * Recognises exactly `1 / A / a / I / i` as the ordinal slot; only the FIRST
 * such character in the template is replaced. All other characters, including
 * any subsequent `1/A/a/I/i`, are copied verbatim. See spec §5.
 *
 * Examples:
 *   formatNumbering("1", 3)      → "3"
 *   formatNumbering(".1", 3)     → ".3"
 *   formatNumbering("A", 3)      → "C"
 *   formatNumbering("(1)", 12)   → "(12)"
 *   formatNumbering("Ex. A.", 2) → "Ex. B."
 *   formatNumbering("§I.", 4)    → "§IV."
 *   formatNumbering("Foo", 3)    → "Foo"      (no slot → constant)
 */
export function formatNumbering(template: string, k: number): string {
  if (!Number.isFinite(k) || k < 1) {
    return template;
  }
  const idx = firstSlotIndex(template);
  if (idx < 0) {
    return template; // no ordinal slot → constant template
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

/**
 * 1-indexed Excel-column labels: A, B, ..., Z, AA, AB, ..., ZZ, AAA, ...
 * (Bijective base-26.)
 */
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

/**
 * Roman numerals 1..3999 (spec doesn't say more is needed; beyond 3999 we
 * fall back to overlined-M-free lossy expansion — the ordinal is way beyond
 * any sane document depth). Case per `lower`.
 */
function toRoman(k: number, lower: boolean): string {
  if (k < 1) return '';
  const pairs: Array<[number, string]> = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I']
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
// §4 Numbering derivation
// ---------------------------------------------------------------------------

/** Precomputed edge indices used by numberFor / readingOrder. */
interface GraphIndex {
  nodesById: Map<string, GraphNode>;
  outgoing: Map<string, GraphRelationship[]>;
  incoming: Map<string, GraphRelationship[]>;
}

function indexGraph(graph: LibraryGraph): GraphIndex {
  const nodesById = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    nodesById.set(n.id, n);
  }
  const outgoing = new Map<string, GraphRelationship[]>();
  const incoming = new Map<string, GraphRelationship[]>();
  for (const r of graph.relationships) {
    const outList = outgoing.get(r.from);
    if (outList) {
      outList.push(r);
    } else {
      outgoing.set(r.from, [r]);
    }
    const inList = incoming.get(r.to);
    if (inList) {
      inList.push(r);
    } else {
      incoming.set(r.to, [r]);
    }
  }
  return { nodesById, outgoing, incoming };
}

function edgesInto(idx: GraphIndex, nodeId: string): GraphRelationship[] {
  return idx.incoming.get(nodeId) ?? [];
}

function edgesOutOf(idx: GraphIndex, nodeId: string): GraphRelationship[] {
  return idx.outgoing.get(nodeId) ?? [];
}

/**
 * Compute the full number of a positioned node (Section or Entry), e.g.
 * `"1.3B.5"`. Returns `null` when the node doesn't exist or when its branch
 * chain cannot be traced back to a top-level `count` (i.e. the node is not
 * yet properly positioned).
 *
 * See spec §4. The algorithm:
 *   1. Walk `branch` incoming edges backwards to the root.
 *   2. For each node on that chain, walk `next` incoming edges back to the
 *      chain head (found via `count`), counting hops to derive the ordinal.
 *   3. Format each ordinal through its counter's numbering template and
 *      concatenate.
 */
export function numberFor(graph: LibraryGraph, nodeId: string): string | null {
  const idx = indexGraph(graph);
  if (!idx.nodesById.has(nodeId)) return null;

  // Step 1: walk branch chain back to a node with no incoming branch.
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = nodeId;
  while (cur !== null) {
    if (seen.has(cur)) return null; // cycle guard
    seen.add(cur);
    chain.unshift(cur);
    const branchesIn: GraphRelationship[] = edgesInto(idx, cur).filter(
      (r) => r.label === 'branch'
    );
    if (branchesIn.length === 0) break;
    // Spec §3: each level picks exactly one branch to its child. If a node
    // has multiple incoming branches, that's an editing conflict — pick the
    // first deterministically so we still return something, but this is a
    // graph the editor should surface as inconsistent.
    cur = branchesIn[0].from;
  }

  // Step 2 + 3: number each chain member; concatenate.
  let out = '';
  for (const id of chain) {
    const seg = numberSegment(idx, id);
    if (seg === null) return null; // any level missing → whole number invalid
    out += seg;
  }
  return out;
}

/**
 * Number ONE level: find `nodeId`'s (ordinal, counter) pair by walking `next`
 * back to the chain head, whose incoming `count` names the counter.
 * Format `ordinal` through the counter's `props.numbering`. Returns null if
 * the node is not attached to a counter chain.
 */
function numberSegment(idx: GraphIndex, nodeId: string): string | null {
  let cur = nodeId;
  let ordinal = 1;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(cur)) return null; // cycle guard
    seen.add(cur);
    // First look for a `count` edge into `cur` — that's the chain head.
    const incoming = idx.incoming.get(cur) ?? [];
    const countIn = incoming.find((r) => r.label === 'count');
    if (countIn) {
      const counter = idx.nodesById.get(countIn.from);
      if (!counter || counter.label !== 'Counter') return null;
      const template = readStringProp(counter.props, 'numbering');
      if (template === null) return null;
      return formatNumbering(template, ordinal);
    }
    // Otherwise, walk back one `next` hop.
    const nextIn = incoming.find((r) => r.label === 'next');
    if (!nextIn) return null; // not attached to any chain
    cur = nextIn.from;
    ordinal += 1;
  }
}

function readStringProp(
  props: Record<string, unknown>,
  key: string
): string | null {
  const v = props[key];
  return typeof v === 'string' ? v : null;
}

// ---------------------------------------------------------------------------
// §7 Reading order
// ---------------------------------------------------------------------------

/**
 * Linear reading order over `Entry` nodes: follow the `reading-next` linked
 * list from its head (an Entry with no incoming `reading-next`). Returns the
 * ordered list of graph-local node ids (NOT entryIds — callers wanting UUIDs
 * should look them up via `nodesById[id].props.entryId`).
 *
 * When the graph has no `reading-next` edges, returns `[]` (the graph is
 * un-ordered; the Infoview should surface this as "no reading order yet").
 *
 * When multiple heads exist (partially-authored library), each head's chain
 * is emitted in the graph-declaration order of the head node, then any
 * remaining orphan Entries (no incoming AND no outgoing reading-next) are
 * omitted — orphans are surfaced separately by the caller if desired.
 */
export function readingOrder(graph: LibraryGraph): string[] {
  const idx = indexGraph(graph);
  const entryIds = graph.nodes
    .filter((n) => n.label === 'Entry')
    .map((n) => n.id);

  // Find heads: Entry with no incoming `reading-next`, but at least one
  // outgoing (i.e. participates in the chain).
  const heads: string[] = [];
  for (const id of entryIds) {
    const incoming = (idx.incoming.get(id) ?? []).some(
      (r) => r.label === 'reading-next'
    );
    const outgoing = (idx.outgoing.get(id) ?? []).some(
      (r) => r.label === 'reading-next'
    );
    if (!incoming && outgoing) {
      heads.push(id);
    }
  }

  const out: string[] = [];
  const visited = new Set<string>();
  for (const head of heads) {
    let cur: string | null = head;
    while (cur !== null && !visited.has(cur)) {
      visited.add(cur);
      out.push(cur);
      const step: GraphRelationship | undefined = edgesOutOf(idx, cur).find(
        (r) => r.label === 'reading-next'
      );
      cur = step ? step.to : null;
    }
  }
  return out;
}
