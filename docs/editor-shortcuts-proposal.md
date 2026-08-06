# Canvas Editor & Inductive Editor keyboard proposal

Status: design proposal, not yet a compatibility promise.

## Design rules

1. Canvas and Inductive use the same structural vocabulary.
2. Arrow navigation follows the ARIA tree convention instead of overloading `Tab`:
   - `ArrowUp` / `ArrowDown`: previous / next visible node.
   - `ArrowLeft`: parent; on an expanded node, collapse first.
   - `ArrowRight`: first child; on a collapsed node, expand first.
3. `Tab` and `Shift+Tab` remain browser focus traversal. They must not be consumed for tree navigation.
4. No editor shortcut is intercepted while the event originates in Monaco, `input`, `textarea`, `select`, `[contenteditable]`, a combobox/listbox, or an open modal/menu that owns the key.
5. `Ctrl` on Windows/Linux and `Cmd` on macOS are displayed as `Mod`. Implementations must inspect both `ctrlKey` and `metaKey` unless an operation explicitly distinguishes them.
6. Every hidden shortcut has an equivalent visible button/menu action. Disabled operations expose a reason in the tooltip.

## Shared structural commands

| Action | Shortcut | Notes |
| --- | --- | --- |
| Previous / next visible node | `ArrowUp` / `ArrowDown` | Roving focus; no edit. |
| Parent / first child | `ArrowLeft` / `ArrowRight` | ARIA tree semantics. |
| First / last visible node | `Home` / `End` | Standard ARIA tree scope: the whole visible tree, not only siblings. |
| Activate selected control | `Enter` | Opens the node action surface; never silently inserts/deletes. |
| Select / toggle expansion | `Space` | On expandable nodes toggles expansion; otherwise selects. |
| Edit Macro ID | `F2` | Existing Canvas behavior retained. |
| Edit whole subtree as SNL | `Mod+F2` | Canvas only; existing behavior retained. |
| Add | `A` | Opens a discoverable Parent / Child / Sibling menu. Follow-up `P`, `C`, `S` works only while that menu is open. |
| Delete subtree | `Delete` | `Backspace` is not a delete alias; avoids browser navigation and text-edit muscle-memory conflicts. |
| Reorder / change depth | `Shift+Alt+ArrowUp/Down/Left/Right` | Up/down reorder; left outdent; right indent. Only when structural focus owns the key. |
| Undo / redo | `Mod+Z` / `Mod+Shift+Z` | Editor-local history. |
| Cancel / close / deselect | `Escape` | One layer per press: suggestion → input → menu → selection. |
| Shortcut help | `?` | Opens searchable help; does nothing in text inputs. |

## Canvas-specific commands

| Action | Shortcut | Notes |
| --- | --- | --- |
| Search/create a root Macro | `/` | Opens Canvas Macro search only while structural Canvas focus owns the key. `Mod+F` remains VS Code/browser Find. Selected-node mode offers Replace vs Add Root explicitly. |
| Start drag/move mode | `M` | Arrow keys move the root spatially; `Enter` commits; `Escape` restores the original position. Structural moves remain in the add/action menu. |
| Keyboard zoom mode | `Z`, then `ArrowUp` / `ArrowDown` / `0` | Enter zoom mode only while Canvas owns focus; arrows zoom in/out, `0` resets, `Enter` commits, and `Escape` restores the prior zoom. Bare `+`/`-` remain dynamic-Macro arity controls; `Mod++/-` remains VS Code/browser zoom. |
| Pan | `Space` held + pointer drag | Space tap still selects/toggles; do not activate while a text editor owns focus. |
| Context/action menu | `Shift+F10` | Standard keyboard context-menu binding. |

## Inductive-specific commands

| Action | Shortcut | Notes |
| --- | --- | --- |
| Expand/collapse node | `Space` | Mirrors disclosure-button behavior. |
| Open Parent/Child/Sibling menu | `A` | Reuses the existing accessible menu and arrow-key loop. |
| Indent/outdent | `Shift+Alt+ArrowRight/Left` | Same meaning as Canvas. |
| Move among siblings | `Shift+Alt+ArrowUp/Down` | Same meaning as Canvas. |
| Edit node | `F2` | Focuses the primary node field without replacing the whole tree. |

## Mode and conflict policy

- `Enter` in a multiline Macro/SNL input follows the input contract; structural handlers never see it. The existing explicit commit chord may remain `Mod+Enter` where needed.
- `Escape` from an input cancels that input and restores structural focus with `focus({ preventScroll: true })`.
- `Mod+F`, `Mod+Z`, `F2`, delete, zoom, and structural movement are ignored in Monaco and editable controls.
- Do not bind bare letters while a combobox or typeahead is open.
- Do not use `Alt+Left` / `Alt+Right` alone because browsers reserve them for history navigation.
- Do not use `Mod+W`, `Mod+R`, `Mod+P`, or `Mod+Shift+P`; VS Code/browser owns them.

## Discoverability and accessibility

1. Add a `Keyboard shortcuts (?)` item to both editor headers.
2. Show context-sensitive hints in the selected-node action surface, not a permanent wall of keycaps.
3. Add `aria-keyshortcuts` to buttons for stable bindings (`F2`, `Delete`, `Shift+F10`).
4. Use one roving `tabIndex=0` structural target. Preserve normal `Tab` traversal to toolbar/actions.
5. Announce mutation results through a polite live region, for example “Moved node after Lemma”, “Deleted subtree, focus moved to parent”, or “Cannot indent: no previous sibling”.
6. Persist neither transient selection nor move mode in Entry serialization.

## Migration from current Canvas behavior

Current Canvas maps `Tab` to next sibling and `Enter` to first child. Migrate in two releases:

1. Release N: support both old and new arrows, and both `Mod+F` and `/` for Macro search. Display one-time hints that `Tab` will return to normal focus traversal and `Mod+F` will return to VS Code/browser Find.
2. Release N+1: stop consuming `Tab` and `Mod+F`; `Enter` opens/activates the node action surface and `/` opens Macro search. Keep `F2`, `Mod+F2`, delete, undo, dynamic-arity `+`/`-`, and pointer-wheel zoom stable.

Tests must prove that every structural shortcut is ignored in Monaco, `input`, `textarea`, `select`, contenteditable, listbox/combobox, and nested popover/menu surfaces.