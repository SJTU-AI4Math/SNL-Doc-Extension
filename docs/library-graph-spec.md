# Library Graph Spec (`graph.json`)

_2026-07-06 draft — awaiting cat approval before implementation._

## 1. What we're building

Replace `libraries/<slug>/relationships.json` with `libraries/<slug>/graph.json`.

Each library **is** a Neo4j-style property graph:

```json
{
  "nodes": [
    { "id": "...", "label": "...", "props": { ... } }
  ],
  "relationships": [
    { "from": "...", "to": "...", "label": "..." }
  ]
}
```

- `id` is unique **within this library** (per your rule "一个 entry 在 library 里应该只有一个 id").
- `label` on nodes and relationships matches Neo4j's node-label / relationship-type terminology.
- Libraries are independent subgraphs — one entry may appear in many libraries.

## 2. Node labels (this iteration)

Three labels ship in v1:

- `Counter` — numbering rule generator. Props: `{ numbering: string }`
  where `numbering` is a magic-string template (see §5).
- `Section` — a level in the outline (chapter, section, subsection …).
  Props: `{ name: string }`.
- `Entry` — one condensed SNL item.
  Props: `{ entryId: string }` — the UUID of an entry in the shared
  `.SNL_Doc/entries.json` pool. (`entryId` may repeat across libraries;
  the graph-local `id` does not.)

Future labels (Definition, Theorem, Diagram, …) fall under the same
`{id, label, props}` shape so we don't need to touch the file format.

## 3. Relationship labels

Exactly three labels, matching your worked example:

| label | from | to | meaning |
| --- | --- | --- | --- |
| `count` | `Counter` | positioned node | "the counter's numbering seeds this sibling chain here" (chain head) |
| `next` | positioned node | positioned node | linked-list step to the next sibling under the same counter |
| `branch` | positioned node | positioned node | "on the way to the final entry, this parent picks this specific child" |

Positioned node = anything that participates in numbering: `Section` or `Entry`.

### Invariants

- Every positioned node has **exactly one** incoming edge from `{count, next}` in a given numbering chain — that's how we know "which sibling am I".
- Every positioned node has **at most one** outgoing `next` — sibling chains are strict linked lists (matches your "next 指针链表").
- `count`'s target must be the chain head (no incoming `next` from the same counter).
- `branch` connects levels: parent (Section/Entry) → child chain member. Multiple `branch` edges from one parent = the reader can descend into more than one sub-chain, but each `branch` picks exactly one child position at that level.

## 4. Numbering derivation

To number a positioned node **N**:

1. Walk the `branch` edges **backwards** from N to the root. Result:
   `[root, ..., grandparent, parent, N]`.
2. For each node on that chain (except entries that are pure leaves —
   still numbered, just don't descend further), find its incoming
   `count` OR `next` edge; walk back along `next` edges until you hit
   a `count` edge — this identifies the counter and the ordinal (how
   many `next` hops you took, +1 for the head).
3. Format `ordinal` through the counter's `numbering` magic string
   (see §5). That's one segment.
4. Concatenate segments in order → full number (`"1.3B.5"`).

**Refresh semantics.** Rebuilding numbers = re-running steps 2–4. No
number is persisted; the graph is the source of truth.

## 5. `numbering` magic string

Cat's rule: "识别 1 A a I i，别的字符全部原样照抄".

Grammar (regex-ish):

```
numbering := ( literal | slot )+
slot      := '1' | 'A' | 'a' | 'I' | 'i'
literal   := any other character(s), copied verbatim
```

The **first** slot in the string is the ordinal placeholder; everything
else is literal. Formatting `k` (1-indexed) through the template:

- `'1'` → `"1"`, `"2"`, `"3"`, …
- `'A'` → `"A"`, `"B"`, …, `"Z"`, `"AA"`, `"AB"`, … (Excel-column style)
- `'a'` → same but lowercase
- `'I'` → `"I"`, `"II"`, `"III"`, `"IV"`, … (Roman numerals, uppercase)
- `'i'` → lowercase Roman

Examples of full templates:

| numbering | k=1 | k=2 | k=3 |
| --- | --- | --- | --- |
| `"1"` | `"1"` | `"2"` | `"3"` |
| `".1"` | `".1"` | `".2"` | `".3"` |
| `"A"` | `"A"` | `"B"` | `"C"` |
| `".A"` | `".A"` | `".B"` | `".C"` |
| `"(1)"` | `"(1)"` | `"(2)"` | `"(3)"` |
| `"Ex. A."` | `"Ex. A."` | `"Ex. B."` | `"Ex. C."` |
| `"§I."` | `"§I."` | `"§II."` | `"§III."` |
| `"Foo"` | `"Foo"` | `"Foo"` | `"Foo"` (no slot → constant, useful only if you're weird) |

Two slots in one template: only the **first** is treated as the ordinal
slot; subsequent `1/A/a/I/i` characters are literal. If cat later wants
multi-slot templates we upgrade the grammar; for v1 first-slot wins.

## 6. Worked example (from cat's message)

Target entry number `1.3B.5`. Graph fragment:

Nodes:

```json
[
  { "id": "cSec",      "label": "Counter",  "props": { "numbering": "1" } },
  { "id": "cSubsec",   "label": "Counter",  "props": { "numbering": ".1" } },
  { "id": "cEntry",    "label": "Counter",  "props": { "numbering": "A" } },
  { "id": "cSubentry", "label": "Counter",  "props": { "numbering": ".1" } },

  { "id": "s1",  "label": "Section", "props": { "name": "Chapter 1" } },

  { "id": "s1a", "label": "Section", "props": { "name": "Section 1.1" } },
  { "id": "s1b", "label": "Section", "props": { "name": "Section 1.2" } },
  { "id": "s1c", "label": "Section", "props": { "name": "Section 1.3" } },

  { "id": "eA", "label": "Entry", "props": { "entryId": "uuid-A" } },
  { "id": "eB", "label": "Entry", "props": { "entryId": "uuid-B" } },

  { "id": "eB1", "label": "Entry", "props": { "entryId": "uuid-B1" } },
  { "id": "eB2", "label": "Entry", "props": { "entryId": "uuid-B2" } },
  { "id": "eB3", "label": "Entry", "props": { "entryId": "uuid-B3" } },
  { "id": "eB4", "label": "Entry", "props": { "entryId": "uuid-B4" } },
  { "id": "eB5", "label": "Entry", "props": { "entryId": "uuid-B5" } }
]
```

Relationships (only the ones needed to reach `1.3B.5`):

```json
[
  { "from": "cSec",      "to": "s1",  "label": "count" },

  { "from": "cSubsec",   "to": "s1a", "label": "count" },
  { "from": "s1a",       "to": "s1b", "label": "next"  },
  { "from": "s1b",       "to": "s1c", "label": "next"  },

  { "from": "cEntry",    "to": "eA",  "label": "count" },
  { "from": "eA",        "to": "eB",  "label": "next"  },

  { "from": "cSubentry", "to": "eB1", "label": "count" },
  { "from": "eB1",       "to": "eB2", "label": "next"  },
  { "from": "eB2",       "to": "eB3", "label": "next"  },
  { "from": "eB3",       "to": "eB4", "label": "next"  },
  { "from": "eB4",       "to": "eB5", "label": "next"  },

  { "from": "s1",  "to": "s1c", "label": "branch" },
  { "from": "s1c", "to": "eB",  "label": "branch" },
  { "from": "eB",  "to": "eB5", "label": "branch" }
]
```

Numbering `eB5`:

1. `branch` chain backwards: `[s1, s1c, eB, eB5]`.
2. Per node:
   - `s1`: `count` from `cSec` → ordinal 1, template `"1"` → `"1"`
   - `s1c`: `next` from `s1b`, `next` from `s1a`, `count` from `cSubsec` → ordinal 3, template `".1"` → `".3"`
   - `eB`: `next` from `eA`, `count` from `cEntry` → ordinal 2, template `"A"` → `"B"`
   - `eB5`: 4× `next` back to `eB1`, `count` from `cSubentry` → ordinal 5, template `".1"` → `".5"`
3. Concatenate: `"1" + ".3" + "B" + ".5"` = `"1.3B.5"`. ✓

## 7. Reading order

Cat (2026-07-06): "这个 order 应该是顶层的，编辑 counter 的时候顺带着一起编辑它就行了".

- Reading order is a **top-level** relationship, one more label alongside
  `count/next/branch`: `reading-next`.
- Graph shape: a linked list over `Entry` nodes.
  `{ from: Entry, to: Entry, label: 'reading-next' }`.
- Semantics: `Entry` E has at most one outgoing `reading-next`; walking the
  chain from the head gives the linear reading order over Entries.
- Section nodes do NOT participate in `reading-next` — the order is over
  entries only, sections are just structure.
- **UI invariant**: when a Counter's sibling chain is edited (insert / remove
  / reorder an Entry-labelled member), the editor synchronously patches the
  affected `reading-next` edges to keep the linear reading order consistent
  with the outline. This is a UI/editing invariant, not a file-format
  invariant — `readLibraryGraph` accepts any well-formed graph.
- No requirement that `reading-next` covers every Entry (partially-authored
  libraries are allowed); the Infoview surfaces orphans as such.

## 8. Dangling entryId

`Entry` nodes carry `props.entryId` referencing `.SNL_Doc/entries.json`.
When the referenced UUID is missing:

- **Read** (`readLibraryGraph`): accept the node; return the graph unchanged
  plus a `warnings: string[]` field naming the offending nodeId + entryId.
- **Render** (Infoview): draw a placeholder frame with an explicit
  "entry not found: `<entryId>`" message in the frame body. The node still
  numbers normally so surrounding entries don't shift.

## 9. What this leaves out

- **Editing UI.** How the Dashboard-side editor lets the user build/edit this
  graph is out of scope for this spec. The spec commits only to the file
  format + numbering algorithm. The UI-side reading-order sync invariant
  (§7) is spec'd here so the editor knows what to enforce.

## 10. Migration

None. Cat confirmed there's no on-disk content to migrate:

- `createLibrary` initializes `graph.json` with `{ "nodes": [], "relationships": [] }`.
- Old scaffolds writing `relationships.json` are updated in the same commit;
  no compatibility shim needed.

## 11. TypeScript surface (planned)

```ts
export type NodeLabel = 'Counter' | 'Section' | 'Entry';
export type RelLabel  = 'count' | 'next' | 'branch' | 'reading-next';

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

export interface ReadLibraryGraphResult {
  graph: LibraryGraph;
  warnings: string[]; // dangling entryId etc.
}

// Pure functions (no vscode dep, testable in smoke):
export function formatNumbering(template: string, k: number): string;
export function numberFor(graph: LibraryGraph, nodeId: string): string | null;
export function readingOrder(graph: LibraryGraph): string[]; // Entry ids
```
