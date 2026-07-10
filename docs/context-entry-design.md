# Context Entry & bvar `src` Attribute — Design Doc

Status: **Spec (2026-07-09, cat + Iroha).** Stage 1 is landing this session.

---

## Motivation

SNL entries currently host bvar decls (`@x`) only for local use — a `@x`
inside an entry can only be referenced by `x` in the **same tree**. Cat
wants a *Context Entry* concept: certain entries whose top-level bvar
decls can be referenced from OTHER entries, analogous to Lean's
`variable` block inside a `section`.

Rather than making `context` a specially-privileged kind, we generalize:
**any node that "refers to something" can carry a `src` attribute
pointing at an entry id**. bvar `src` picks up cross-entry binder decls;
macro `src` reserves the same mechanism for future macro-provenance
disambiguation. UI and lookup share one code path — hover / navigate /
warn — parameterized by node kind.

## Non-goals

- No AST-level constructor changes today. `src` is an optional field on
  existing SNL syntax nodes (mdata-style), not a new node kind. The
  earlier AST-refactor exploration doc still stands as the future home
  for a proper `ref` constructor.
- No Denote-side handling. Lean `variable`-block translation is out of
  scope for Stage 1.

## Fork decisions (cat 2026-07-09)

- **A. Syntax**: use `@` sigil. `@x` at the start of an identifier
  position = decl (existing). `x@foo` (identifier followed by `@ident`)
  = use with `src=foo`. `Set.union@stdlib` likewise reserves the
  mechanism for macros.
- **B. Context export**: top-level `@x` inside a `context` entry is
  automatically exported. No `@!x` marker; users who want to hide a
  binder simply don't add it to a context entry. Nested `@x` (inside
  a `macro(@x, …)` binder slot) is NOT exported — export is the
  top-level default only.
- **C. `src` is universal.** Any ref-like node may carry it. `src`
  missing OR pointing at a non-existent entry is TOLERATED — renderer
  shows a warning badge + hover message; `snl-lint-*` emits info-level
  `src.dangling` / `src.missing`. Never fails a build. Cat verbatim:
  "对于不写 src 的行为，我们容忍但不鼓励."
- **D. `src` payload = entry id.** Cat's standing preference (repeated
  2026-07-09) is **semantic ids** (`pythagorean-theorem`,
  `context-linalg-vars`) over uuid v4. Since ids are immutable, semantic
  ids give us stable *and* readable references. No alias layer.

## Deliverables (this session)

### Stage 1 — usable minimum

1. **Preset `context` entry kind** in `.SNL_Doc/config.json#entry_kinds`.
   No UI branch on it; just a preset row so users know the pattern.
2. **SNL parser**: recognize `ident @ident` (no space allowed between
   the leading ident and `@`) as `ident` node with `src` mdata field.
   Preserve `@ident` at position start as the decl-binder marker.
3. **Renderer**: read `src` from the parsed node. If set, attach a
   src badge next to the rendered token; on hover show either
   "Bound in `<entryTitle>`" (resolved) or "src `<id>` not in pool"
   (dangling / missing).
4. **CreateEntry UX**: nothing new for bvar today (users edit SNL
   directly). But: demote the CreateEntry "Generate UUID" button to
   secondary, add an inline hint "Semantic ids preferred — reserve UUID
   for when no meaningful name fits" (long-standing cat correction,
   finally acted on).
5. **Toolkit lint rule** `src.dangling` — info level, one row per
   bvar/macro node whose `src` doesn't resolve. Never fails the batch.

### Stage 2 — nice-to-have (defer if we run long)

- Ctrl+click on a bvar with `src` opens the referenced entry in the
  Infoview. Reuse the existing Ctrl-click infra for macro identifiers.
- CreateEntry SNL-editor row inspector: when the cursor is on a bvar,
  offer an EntityIdSearchBox to set `src`.

### Stage 3 — out of scope

- AST refactor to fold `src` into a proper `ref` constructor.
- Denote translation of a context entry to a Lean `variable` block.
- Lint auto-fix that inserts `@src` from a picker.

---

## Storage encoding

Zero migration. New surface syntax composes with existing SNL:

```
%Let% x@context-linalg-vars %be a real number.%
```

Parsed to a bvar token whose mdata carries `src="context-linalg-vars"`.
Old entries with no `@src` render exactly as before.

## Renderer contract

For each token that carries a resolved `src`:

- Wrap in a small badge showing `↗ context-linalg-vars` (or a short
  form). Hover: full entry title + kind + link icon.
- If `src` unresolved: red-tinted badge, hover: "src not in pool".
- If bvar has no `src` AND no local decl in scope: unchanged — falls
  through to free-var rendering, exactly as today.

## Lookup semantics (bvar path)

```
resolveBvar(node, tree, entryPool):
  if node.src:
    let target = entryPool.byId(node.src)
    if target is missing:
      return { status: 'srcDangling', src: node.src }
    let ctxDecl = findTopLevelBinderDecl(target.content.snl, node.name)
    if ctxDecl is missing:
      return { status: 'srcResolvedNoDecl', target }
    return { status: 'ok', binding: ctxDecl, resolvedIn: target }
  # existing behavior
  return existingLocalScopeLookup(node, tree)
```

Renderer maps each status to a visual state. `snl-lint-*` maps
non-`ok` states to warnings.

## Follow-ups

- Once we have real usage of `x@…` in the wild, revisit whether the
  parser should also accept whitespace `x @ ident` for readability.
- Semantic-id encouragement is a UX push; consider a lint rule
  `entry-id.uuid-only` that flags brand-new entries whose id is a
  bare uuid v4 with no reason.

---

*Written 2026-07-09 by Iroha per cat's four-fork decisions. Superseded
only if a full AST refactor lands — see `docs/ast-refactor-exploration.md`
for that longer-horizon plan.*
