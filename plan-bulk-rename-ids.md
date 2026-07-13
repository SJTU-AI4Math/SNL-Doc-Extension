# Plan — Bulk rename entry / macro IDs (Extension feature)

Status: **planning**. Not started.

## Motivation

Entry ids are semantic (`api.iface.snl-syntax-tree-view.prop.tree`), which is great for review but painful to change. Today, renaming one entry requires:

1. Edit `entries.json` id in place.
2. Grep every other entry's `content.snl` for the old id embedded in `%…%` src refs / macro source-entry lists.
3. Update every `libraries/*/graph.json` node's `props.entryId`.
4. Update every macro package's `source.entries[]` array.
5. Update `relationships.json` edges.
6. Update any `.md` prose that quotes the id.
7. Manual sanity check — miss any one of the above and links go dangling silently.

Grows quickly with pool size. For the SNL-Basics catfood pool (~105 entries as of 2026-07-13) each rename is 20+ minutes of careful grep. Real projects (Mathlib-style 10k+ entries) would be prohibitive without tooling.

## Feature request

**Palette command**: `SNL: Rename Entry ID…`

- Input: current id + new id (with validation against `[A-Za-z0-9._]` and uniqueness).
- Preview panel: shows every file + line that will change (like VS Code's default rename).
- Confirm → single atomic write across all affected files.
- Undo: one Ctrl-Z (built on a single `WorkspaceEdit`).

Parallel: **`SNL: Rename Macro Name…`** (same shape, different scope — macro-package files + entries that reference the macro name in `%foo%` leaves).

## Scope of edits (per rename)

For entry id `old` → `new`:

| Where | Match | Replace |
|-------|-------|---------|
| `entries.json` | `{"id": "old", …}` | `{"id": "new", …}` |
| `entries.json` any entry's `content.snl` | src postfix `x@old` | `x@new` |
| `entries.json` any entry's `content.markdown` | literal string `old` (with word boundaries) | `new` |
| `libraries/*/graph.json` | node's `props.entryId == "old"` | `"new"` |
| `libraries/*/graph.json` | edge's source/target entryId | update |
| `term_macros/*.json` | any macro's `source.entries[]` containing `"old"` | replace element |
| `relationships.json` | edges' entry endpoints | update |
| `docs/*.md` (opt-in) | prose mentions | prompt user per hit |

## Non-goals

- Cross-workspace rename. Confined to the current `.SNL_Doc/`.
- Bulk regex rename (fuzzy). This is exact-match by id; regex belongs to a different tool.
- Macro *style tag* rename (much smaller blast radius; author edits inline).

## Implementation sketch

- Extension side: reuse `snlDoc.ts` readers (`readEntries` / `readMacroPackages` / `readLibraryGraph`) to build an in-memory index of every id occurrence — file + JSON path + textual span.
- Preview built on `vscode.window.createTreeView` (grouped by file).
- Apply via a single `vscode.WorkspaceEdit`.
- Optional: emit a lint recheck (`snl-lint-entry`) after apply to catch anything missed.

## Estimated effort

- Palette + input validation: 1h
- Occurrence-index builder: 2h (careful with JSON-path targeting so we don't rewrite unrelated strings)
- Preview tree + Apply: 2h
- Tests (rename with cross-references, undo round-trip): 2h
- Total: ~1 day of focused work.

## Related

- Toolkit's `snl-lint-*` CLIs already report unresolved src references — but they only detect, don't fix. Bulk rename is the fix side.
- Long term: same infra can back "extract entry" (split a macro-heavy entry into a new entry) and "inline entry" (dissolve back).
