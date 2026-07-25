# Dynamic Arity in the Canvas — design (B + C)

Read-only design note. No code changed. Cat decision 2026-07-25: **route B first
(explicit arity control, keyboard `+` / `-` while focused, numpad preferred and
later user-rebindable), then route C (drag-to-append)**.

## 1. Where we are

| | fixed arity | dynamic arity |
|---|---|---|
| slot count comes from | the template (`#0 #1`) | the author |
| is it derivable? | yes, `macroTemplateArity` | no |
| Canvas today | `reconcileCanvasArity` aligns children | `macroArityForName` returns `null` → children untouched, slot machinery inert |
| only way to add a child today | click empty slot | hand-type the whole subtree via Ctrl+F2 |

`webview/src/CreateEntryApp.tsx:1889`

```ts
if (!macro || macro.dynamic_arity === true) return null;
```

That `null` is the whole gap. Everything else (holes, Delete, undo, drag,
eviction) already works and is arity-agnostic.

## 2. Facts established by probing (not assumed)

- **Zero children is legal SNL.** Verified against the real parser:
  - `list()` → ok, `children = 0`
  - `list` → ok, `children = 0`
  - `list(a,)` → **error** "Trailing comma is not allowed"
  - `list(,)` → **error**
  So `n = 0` needs no special casing at the SNL level, and we must never
  serialize a trailing comma — which is exactly what an always-present tail
  `+` slot (route A) would have risked.
- `#*` renders as `children_joined` with the style's `separator`
  (`template.ts`), so **rendering needs no change at any n**.
- `detachFromTree` refuses to detach an existing hole and always substitutes a
  hole in place — correct for fixed arity, but for dynamic arity a detach
  should *remove* the slot, not leave a positional gap. This is the one
  existing behaviour that needs a dynamic-aware branch.

## 3. Why B over A (cat's call, and the probe agrees)

A ("permanent trailing `+` slot") is B minus the minus sign — and `-` is not
optional, since a dynamic node must be able to shrink. A also puts a sentinel
child inside the serialization path forever, so `canPersistCanvasForest` would
have to special-case it and a mis-fire serializes `list(a,)`, which the parser
rejects outright. B keeps the tree always-valid: children are either real nodes
or ordinary empty slots, both of which already exist.

## 4. Design

### 4.1 Core operation

One new pure function in `webview/src/entry-editor/canvasForest.ts`, sibling to
`reconcileCanvasArity` and sharing its eviction contract:

```ts
export function setCanvasDynamicArity(
  forest, rootIndex, path, nextCount, onEvict?
): SnlSyntaxTree[]
```

- `nextCount` clamped to `>= 0` (zero is legal, see §2).
- Growing appends empty slots — never resurrects evicted children, same rule
  as `reconcileCanvasArity`.
- Shrinking drops trailing empty slots first, then evicts real subtrees to the
  forest as their own root blocks via `onEvict` (identity preserved, exactly
  like the fixed-arity path).
- Returns the same array reference when nothing changes, so `applyForestChange`
  keeps its no-op / undo semantics.

Everything downstream (undo, positions, focus invalidation) is reused unchanged.

### 4.2 Keyboard (B)

In `handleCanvasKeyDown`, when `focused` resolves to a node whose Macro has
`dynamic_arity === true`:

- `+` (numpad `NumpadAdd` preferred, main-row `+` / `=` also accepted) → arity + 1
- `-` (numpad `NumpadSubtract`, main-row `-`) → arity - 1
- Both route through `applyForestChange`, so Ctrl+Z undoes them.
- No-op (and no undo entry) on a non-dynamic node or at `n = 0` for `-`.

Key matching should go through a small lookup table keyed by `event.code` first,
falling back to `event.key`, so the numpad/main-row distinction is preserved and
a future "custom keybinding" feature has one place to read from. Cat explicitly
asked for numpad priority + later rebinding, so the table lives in one exported
const rather than inline `if`s.

### 4.3 Inline control (B)

When the focused node is dynamic, render a small `[- n +]` control anchored to
the block (same positioning math as the inline editor: canvas-relative
`left`/`top` from `getBoundingClientRect`). It also appears in the right-click
menu as `Add argument` / `Remove last argument` so the gesture is discoverable
without knowing the shortcut.

### 4.4 Drag-to-append (C)

`findDropTarget` currently only accepts `[data-kind="argPlaceholder"]`. Add a
second acceptance: the tail region of a dynamic node's rendered box. On drop,
append the dragged root as a new last child (arity + 1) instead of filling a
numbered slot. Shares `setCanvasDynamicArity`'s append path; the drop indicator
reuses `.snl-canvas-drop-target`.

C is strictly additive and can ship after B.

### 4.5 Detach / Delete on a dynamic child

`deleteCanvasTarget` and `detachCanvasSubtree` must branch on the *parent's*
`dynamic_arity`:

- parent fixed → today's behaviour (collapse to a numbered empty slot, arity
  preserved)
- parent dynamic → **remove the child outright**, arity shrinks by one

Otherwise a dynamic node accumulates permanent empty slots that the author can
never get rid of, and `canPersistCanvasForest` blocks the save forever.

## 5. Async wrinkle worth flagging

`macroArityForName` is `async` (it goes through `macroDataDriver.query_macro`).
`handleCanvasKeyDown` is sync. Two options:

1. Keep a small `Map<macroName, boolean>` of dynamic-arity flags, populated by
   the same query the block rendering already issues, and read it synchronously
   in the key handler.
2. Make the handler fire-and-forget async.

(1) is preferable: it keeps `+`/`-` instantaneous and avoids a race where two
fast keypresses both read the pre-change forest.

## 6. Test plan

Pure (`canvasForest.test.ts`):
- grow / shrink / clamp at 0
- shrink evicts real subtrees, drops trailing empty slots first
- grow never resurrects evicted children (same-node round trip)
- `onEvict` fires per evicted subtree
- no-op returns the identical array reference

Component (`GuiCanvasEditor.test.tsx`):
- `+` / `-` while focused on a dynamic node changes the slot count
- `+` / `-` on a fixed-arity node is a no-op
- numpad `NumpadAdd` and main-row `+` both work
- Ctrl+Z undoes an arity change
- Delete on a dynamic child removes the slot (no leftover placeholder)
- drag onto the tail region appends (route C)

Each guard to be mutation-verified before commit, per the usual rule here.

## 7. Saving with unfilled slots — cat decision 2026-07-25

**An empty slot must NOT block saving.** Today `canPersistCanvasForest` returns
false if any hole exists anywhere, which gates both `canCreate` (the Submit
button) and the Canvas → `content.snl` sync. That has to change.

The blocker: the current hole is not serializable. Probed against the real
parser —

```
createCanvasHole(1).macro_name === "\\mathord{\\htmlClass{snlArgPlaceholder}{1}}"
tryParseSnlSyntaxTree(that)      → ERR  Unexpected character "{" at position 8
tryParseSnlSyntaxTree("f(" + that + ")") → ERR
```

So a hole is a *render-only* node. Serializing a forest containing one produces
SNL that cannot be read back — the Canvas would save something it can never
reopen. Allowing saves therefore requires giving holes a **round-trippable
surface form** first.

Probed candidates for that surface form:

| source | parses? | resulting `macro_name` |
|---|---|---|
| `f(_)` | ok | `"_"` |
| `_` | ok | `"_"` |
| `f(_,b)` | ok | `"_"` |
| `f(_hole)` | ok | `"_hole"` |
| `f(?)` | **err** | — |
| `f(□)` | **err** | — |

`_` is the natural choice: it already parses as an ordinary identifier in every
position, needs no grammar change, and reads like a hole to anyone who has used
Lean. Note the codebase already relies on this identifier class — the Canvas
bootstraps with `_snl_stub`.

### Required changes

1. `createCanvasHole` emits `macro_name: '_'` (keep `mdata` for the index and
   the `argPlaceholder` kind for styling). The existing KaTeX string moves to
   the *view* layer, so it still renders as a numbered box.
2. `isCanvasHole` keeps reading `mdata`, but gains a fallback: a parsed node
   whose `macro_name === '_'` and which has no children **is** a hole. This is
   what makes reopening a saved-with-holes entry work — `mdata` does not
   survive the text round trip.
3. `canPersistCanvasForest` drops the `hasCanvasHole` condition and keeps only
   `forest.length === 1`. Multiple disconnected root blocks still cannot be
   serialized (there is genuinely no single tree to write); a hole now can.
4. The Submit path and the incomplete-state banner change meaning: "unfinished
   slots" becomes an advisory hint, not a gate. Only "more than one root block"
   still blocks.

### Round-trip test to add

`f(_, b)` → parse → `isCanvasHole(children[0])` is true → serialize → `f(_,b)`
→ parse again → still a hole. Plus: an entry saved with a hole reopens with the
slot still visible in the Canvas.

## 8. Resolved

- Zero children: legal, no special casing (§2).
- Unfilled slots may be saved (§7) — requires the `_` surface form first.

