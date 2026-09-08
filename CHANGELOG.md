# Changelog

## 0.1.2 — release candidate (not published)

### Added
- Bidirectional Entry/source navigation with per-Pointer asymmetric context,
  explicit ambiguity handling, dirty-buffer-aware lookup and rebuildable reverse
  index maintenance in Dashboard.
- Optional source snapshots in HTML exports: exact-file preflight, keep/exclude
  rules, whole-file or project scope, dependency-root authorization, immutable
  byte hashes and revalidation before publication.
- Offline read-only Monaco alongside exported documents, including Lean 4
  syntax highlighting, search/copy/folding, file tree, draggable split width,
  source selection, reverse navigation, cursor following and bounded models.
  Single-file and directory exports require no external Monaco service.

### Fixed
- Pin the published `@sjtu-ai4math/snl-basics` dependency to **0.3.5** across
  the host bridge, Webviews and shared React HTML reader.
- Make Ctrl+Alt+J (Cmd+Alt+J on macOS) navigate directly without a candidate
  picker: containing scope, highest Priority, smallest expanded UTF-16 span,
  then locale-independent Entry/Package identity and HTML occurrence identity.
- Preserve the document reading anchor when opening source beside it; finish
  collapsed-target rendering before applying reverse-navigation highlighting.
- Clear stale code and document highlights when a Pointer is unavailable, and
  keep the background watermark from overlapping the split document pane.
- Preserve private render-snapshot identity through locale/theme and popover
  capture; stale dependencies require recapture instead of mixing generations.
- Recheck source state after staging, retain previous output on failure, and
  refuse overwriting directories containing unrelated files.
- Do not count a standalone Entry fallback as an additional outline occurrence.
- Repair current Entry schema markers and use locale-independent package
  membership order; add the existing data-read contract documentation.
- Resolve localized outline accessibility labels and clear the strict TypeScript
  errors in the touched authoring/test surfaces.

### Scope and verification
- UUID identity/schema design is reserved for **0.2.0** and not implemented here.
- Linux VS Code development-host export and Chromium offline directory/single
  HTML reading were exercised, including actual source bytes, light/dark themes,
  source/Entry navigation and reverse Pointer boundaries.
- Windows native junction/path behavior and Windows VS Code release validation
  remain a release gate; Linux evidence does not certify them. Browser and
  filesystem/provider support must not be inferred beyond tested environments.
