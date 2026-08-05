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
- `props.entryId` optionally references the live shared Entry pool (`.SNL_Doc/entries/*.json` in workspace `0.0.5`; legacy workspaces used `.SNL_Doc/entries.json`); unset = a placeholder node (no title / content / kind yet).

## 2. Branch is the outline

`branch` edges form a **tree** (spec doesn't hard-enforce, but the UI does):
- root(s): nodes with no incoming `branch`
- children: nodes reached by outgoing `branch`
- sibling order: **the order the branch edges appear in `relationships[]`**

This is the ONLY ordering source. There is no `next` edge and no `reading-next`. Reading order = **DFS of branch in declaration order**.

## 3. Numbering

`numberFor(graph, entryPool, kinds, nodeId)` → `string | null`.

1. Walk `branch` incoming edges backwards from nodeId to some root. Chain = `[root, …, parent, nodeId]`.
2. For each node `N` on the chain except the root, let `P` be its branch parent. Compute the **level segment** for `N`:
   - Enumerate `P`'s children in `relationships[]` declaration order. Let `k` be `N`'s 1-indexed position.
   - Let `firstChild = P.children[0]`.
   - Look up `firstChild.props.entryId` → its `EntryData.kind` → the matching `EntryKind`.
   - Segment = `formatNumbering(entryKind.numbering, k)` — same magic-string formatter as v1 (`1 / A / a / I / i` + literal).
   - Fallback when first child has no resolvable kind: use `".1"`.
3. Root segment: root itself has no branch parent. Return only its children's segments, no prefix. (I.e. a root node's "number" is empty/null; its **children** are `"1"`, `"2"`, … or `"A"`, `"B"`, … depending on their kind.)
4. Concatenate segments in chain order → full number (e.g. `"1.3B.5"` for a 3-deep entry).

### Root node numbering

Root nodes themselves are un-numbered. In practice a library has ONE root (a Chapter kind entry using numbering `"1"`), and its children pick up `"1.1"`, `"1.2"` from the chapter's own kind numbering. See §6 example.

### Fallback rules

- First child has `entryId` unset → placeholder node → fallback `".1"`.
- First child's `entryId` doesn't resolve in shared pool → fallback `".1"`.
- First child's `kind` doesn't resolve in `entryKinds` → fallback `".1"`.
- Any node in the branch chain missing → return `null`.

## 4. Reading order

`readingOrder(graph)` → `string[]` (node ids in read order).

**Pure DFS on branch**, root(s) first (multiple roots emitted in the order they appear in `nodes[]`), then each root's subtree in branch-declaration order. No separate `reading-next` edges.

Cat 2026-07-06 accepted this as v1 limitation: axiom-across-chapters ("a single global axiom counter embedded in different sections") is not modellable — those entries will just be numbered per their branch parent like everything else.

## 5. Magic-string formatter (unchanged from v1 §5)

`formatNumbering(template: string, k: number)`:
- Recognises `1 / A / a / I / i` as ordinal slot chars (first occurrence wins).
- All other chars are literal.
- Examples: `"1"→"3"`, `".1"→".3"`, `"A"→"C"`, `"(1)"→"(3)"`, `"Ex. A."→"Ex. C."`, `"§I."→"§III."`.
- No slot → template returned verbatim.

`EntryKind.numbering` in v2 stores a **single-level** template like `"1"`, `".1"`, `"A"`, `".A"`. This is a **semantic change** from v0.0.3 where it stored multi-level `"1.1.1"` patterns; migrate on read (see §8).

## 6. Worked example — `1.3B.5`

Same target as v1 spec §6.

**EntryKinds** (in `config.json#entry_kinds`):
- `chapter.numbering = "1"`
- `section.numbering = ".1"`
- `theorem.numbering = "A"` (or any kind whose first child is B-worthy)
- `remark.numbering = ".1"`

**Shared pool** (live `.SNL_Doc/entries/*.json` entities in `0.0.5`; shown here keyed by Entry ID):
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

Branch chain: `[chap1, s1_3, t_B, r_5]`.

- `chap1` is root → segment omitted (unnumbered).
- `s1_3` under `chap1`: chap1's children `[s1_1, s1_2, s1_3]`, first-child = `s1_1`, its kind = `section`, `numbering=".1"`. `s1_3` is 3rd → `formatNumbering(".1", 3)` = `".3"`.
- `t_B` under `s1_3`: children `[t_A, t_B]`, first = `t_A` kind=`theorem`, `numbering="A"`. `t_B` is 2nd → `formatNumbering("A", 2)` = `"B"`.
- `r_5` under `t_B`: children `[r_1..r_5]`, first = `r_1` kind=`remark`, `numbering=".1"`. `r_5` is 5th → `formatNumbering(".1", 5)` = `".5"`.

For chap1 to appear as `"1"`, it needs a PARENT (library-root virtual counter) OR we accept that root chapters are un-prefixed. Design decision (cat 2026-07-06):

**Chapters ARE the roots.** The first chapter is displayed as `"1"` by rendering `formatNumbering(chapter.numbering, 1)` where `chapter.numbering = "1"`. To make this uniform we number roots too:

- Roots segment: enumerate all roots in `nodes[]` order, first-root kind decides root numbering, `formatNumbering(rootKind.numbering, k)`.

So `chap1` alone → `"1"`, and `r_5`'s full number = `"1" + ".3" + "B" + ".5"` = `"1.3B.5"`. ✓

If there are multiple root chapters `chap1, chap2, chap3`, they get `"1"`, `"2"`, `"3"`.

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
