# Library Graph Spec v2 (`graph.json`)

_2026-07-06 — replaces v1 (Neo4j-style 3-label / 4-rel model)._

## 0. What changed vs v1

**Simpler.** Cat 2026-07-06:

- "把 section 并入 entry" → `Section` label gone
- "每个 entry kind 存自己的 counter" → `Counter` node gone
- "按第一个 sub-entry 的 entry kind 里记录的 numbering 格式来" → level-numbering is derived from the first child's kind

v2 has **1 node label** and **1 relationship label**. Numbering is a pure function of the branch tree + shared entry pool + entry kinds. No counter state to maintain, no `count/next/reading-next` bookkeeping — the outline **is** the numbering.

Axiom-across-chapters (globally-numbered entries that live physically inside chapters) is **not supported in v1**; entries follow their branch parent's counter chain. Marked as future work.

## 1. File format

```json
{
  "nodes": [
    {
      "id": "n_local_id",
      "label": "Entry",
      "props": {
        "entryId": "uuid-in-shared-pool"
      }
    }
  ],
  "relationships": [
    { "from": "parent_id", "to": "child_id", "label": "branch" }
  ]
}
```

- Only `label` value is `"Entry"`. Unknown labels are read as-is (warning); they don't affect numbering.
- Only `label` value on relationships is `"branch"`. Unknown labels are ignored (warning).
- `nodes.id` is unique **within this library** — a stable local handle. It is NOT the shared-pool entryId.
- `props.entryId` optionally references the live shared Entry pool (`.SNL_Doc/entries/*.json` in workspace `0.0.6`; legacy workspaces used `.SNL_Doc/entries.json`); unset = a placeholder node (no title / content / kind yet).

## 2. Branch is the outline

`branch` edges form a **tree** (spec doesn't hard-enforce, but the UI does):
- root(s): nodes with no incoming `branch`
- children: nodes reached by outgoing `branch`
- sibling order: **the order the branch edges appear in `relationships[]`**

This is the ONLY ordering source. There is no `next` edge and no `reading-next`. Reading order = **DFS of branch in declaration order**.

## 3. Numbering

Numbering is scoped to one Library and consumes that Library's natural one-dimensional reading order. It does **not** inspect an Entry node's `branch` ancestors or siblings.

1. Flatten the Library to `readingOrder(graph)`.
2. Resolve each Entry's active Counter from explicit `node.props.counterId`, falling back to its Entry Kind's `defaultCounterName`.
3. Process Entries in that linear order. An Entry with no active Counter remains unnumbered and does not mutate Counter state.
4. Advancing a Counter increments only that Counter and resets all of its descendant Counters.
5. Render the Entry's label by concatenating the initialized Counter segments from the Counter-tree root through the active Counter. Each segment uses that Counter's own `numbering` DSL.

Example for Counter hierarchy `chapter("1") → section(".1") → theorem("A")`:

```text
chapter, section, theorem, section, theorem, chapter, section, theorem
1        1.1      1.1A     1.2      1.2A     2        2.1      2.1A
```

Two Entry trees that produce the same Library linear order therefore produce identical numbers. Entry tree shape controls outline presentation; Counter hierarchy controls numbering/reset semantics.

### Fallback rules

- Missing/dangling explicit `counterId` falls back to the Entry Kind's `defaultCounterName`.
- Missing Entry, Entry Kind, or resolvable Counter → `null` for that Entry.
- A child Counter encountered before its hierarchy ancestors have been initialized → `null`; no synthetic zero prefix is invented.
- Duplicate Counter names remain ambiguous and resolve to the first depth-first match, with UI validation responsible for warning authors.

## 4. Reading order

`readingOrder(graph)` → `string[]` (node ids in read order).

The current Library natural order is DFS on `branch`: roots in `nodes[]` declaration order, then each subtree in branch-edge declaration order; unreachable/orphan nodes are appended in `nodes[]` order. Numbering receives only this flattened sequence and never uses branch depth.

## 5. Magic-string formatter (unchanged from v1 §5)

`formatNumbering(template: string, k: number)`:
- Recognises `1 / A / a / I / i` as ordinal slot chars (first occurrence wins).
- All other chars are literal.
- Examples: `"1"→"3"`, `".1"→".3"`, `"A"→"C"`, `"(1)"→"(3)"`, `"Ex. A."→"Ex. C."`, `"§I."→"§III."`.
- No slot → template returned verbatim.

`EntryKind.numbering` in v2 stores a **single-level** template like `"1"`, `".1"`, `"A"`, `".A"`. This is a **semantic change** from v0.0.3 where it stored multi-level `"1.1.1"` patterns; migrate on read (see §8).

## 6. Worked example — `1.3B.5`

Same target as v1 spec §6.

**Counter hierarchy** (in `libraries/<slug>/counters.json`):
- `chapter.numbering = "1"`
  - `section.numbering = ".1"`
    - `theorem.numbering = "A"`
      - `remark.numbering = ".1"`

The matching Entry Kinds select these Counters through `defaultCounterName`.

**Shared pool** (live `.SNL_Doc/entries/*.json` entities in `0.0.6`; shown here keyed by Entry ID):
- `uuid-chap1: { title: "Chapter 1", kind: "chapter" }`
- `uuid-1_1: { title: "…", kind: "section" }`
- `uuid-1_2: { title: "…", kind: "section" }`
- `uuid-1_3: { title: "Continuity", kind: "section" }`
- `uuid-1_3_A: { title: "…", kind: "theorem" }`
- `uuid-1_3_B: { title: "Some theorem", kind: "theorem" }`
- `uuid-1_3_B_1..5: { kind: "remark" }`

**Graph:**
```json
{
  "nodes": [
    { "id": "chap1", "label": "Entry", "props": { "entryId": "uuid-chap1" } },
    { "id": "s1_1",  "label": "Entry", "props": { "entryId": "uuid-1_1" } },
    { "id": "s1_2",  "label": "Entry", "props": { "entryId": "uuid-1_2" } },
    { "id": "s1_3",  "label": "Entry", "props": { "entryId": "uuid-1_3" } },
    { "id": "t_A",   "label": "Entry", "props": { "entryId": "uuid-1_3_A" } },
    { "id": "t_B",   "label": "Entry", "props": { "entryId": "uuid-1_3_B" } },
    { "id": "r_1",   "label": "Entry", "props": { "entryId": "uuid-1_3_B_1" } },
    { "id": "r_2",   "label": "Entry", "props": { "entryId": "uuid-1_3_B_2" } },
    { "id": "r_3",   "label": "Entry", "props": { "entryId": "uuid-1_3_B_3" } },
    { "id": "r_4",   "label": "Entry", "props": { "entryId": "uuid-1_3_B_4" } },
    { "id": "r_5",   "label": "Entry", "props": { "entryId": "uuid-1_3_B_5" } }
  ],
  "relationships": [
    { "from": "chap1", "to": "s1_1", "label": "branch" },
    { "from": "chap1", "to": "s1_2", "label": "branch" },
    { "from": "chap1", "to": "s1_3", "label": "branch" },

    { "from": "s1_3", "to": "t_A", "label": "branch" },
    { "from": "s1_3", "to": "t_B", "label": "branch" },

    { "from": "t_B", "to": "r_1", "label": "branch" },
    { "from": "t_B", "to": "r_2", "label": "branch" },
    { "from": "t_B", "to": "r_3", "label": "branch" },
    { "from": "t_B", "to": "r_4", "label": "branch" },
    { "from": "t_B", "to": "r_5", "label": "branch" }
  ]
}
```

**Compute `numberFor(r_5)`:**

The Library linear sequence advances Counters as follows:

- `chap1` advances chapter → `1` and resets all descendants.
- `s1_1`, `s1_2`, `s1_3` advance section → `1.1`, `1.2`, `1.3`; each section advance resets theorem/remark.
- `t_A`, `t_B` advance theorem → `1.3A`, `1.3B`; each theorem advance resets remark.
- `r_1..r_5` advance remark → `1.3B.1` through `1.3B.5`.

Therefore `r_5` is `"1.3B.5"`. The same linear Counter sequence yields this number even if the Entry branch tree is regrouped without changing the Library's natural linear order.

## 7. TypeScript surface

```ts
export type NodeLabel = 'Entry';
export type RelLabel = 'branch';

export interface GraphNode {
  id: string;
  label: NodeLabel;
  props: { entryId?: string };
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

// Pure functions:
export function formatNumbering(template: string, k: number): string;

// Numbering requires kind lookup, so it needs the entry pool + kinds.
export function numberFor(
  graph: LibraryGraph,
  nodeId: string,
  entriesById: Map<string, { kind?: string }>,
  kindsById: Map<string, { numbering: string }>
): string | null;

export function readingOrder(graph: LibraryGraph): string[];  // DFS branch
```

## 8. Migration

- `Counter` / `Section` label nodes on disk (from v1 graphs, if any exist) → dropped with a warning at read time. **We have no on-disk v1 graphs** (cat 2026-07-06: 无存量), so this is defensive.
- `count / next / reading-next` relationships → dropped with a warning.
- `EntryKind.numbering` old shape (multi-level e.g. `"1.1.1"`) → **kept as-is on disk** but the numbering engine only looks at the *first slot* per §5 (first-slot-wins), which naturally makes `"1.1.1"` numberable as `"1"` for chapter-level. Not a hard migration: users who want per-level `".1"` need to update their preset (or `applyEntryKindsPreset` handler writes fresh v2 shape).

## 9. Editor UI

Cat 2026-07-06: outline editor goes in the Edit Library panel (below the meta-fields row), no drag-and-drop for v1. Row layout: `[expand] [computed-number] [title or "(untitled)"] [kind-badge] [add-child | add-sibling | delete | move-up | move-down]`. Empty content is displayed with a placeholder — no error state. See §UI implementation notes in `src/createLibraryPanel.ts` (once written).
