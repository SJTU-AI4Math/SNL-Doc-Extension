# SVG Macro editor

The Create/Edit Macro view offers the `svg_template` block preset. Import a UTF-8 SVG file (up to 1 MiB) or paste source, then **Load SVG preview**. Select painted artwork (Shift selects multiple siblings), optionally select its parent group, and replace it with an indexed slot. Exact paint can be mapped to `currentColor` or a paper knockout. Unsafe or unsupported SVG is rejected, not mounted.

Give the asset a safe filename slug and an accessibility label, then **Save SVG Macro Asset**. This publishes an immutable source, sanitized runtime template and operation manifest; **Update/Create Macro is still a separate action** using the existing canonical writer/CAS. A successful asset save does not mean the Macro has been saved. Pending SVG edits disable Macro submission until their assets are saved, so an unrelated Macro update cannot clear uncommitted artwork. Existing body argument ordering, description, tags, localized projections and unknown metadata are retained; new positions are appended only when necessary. Fixed SVG slots cannot be combined with dynamic Macro arity. Cross-language arity validation still applies.

Uncommitted artwork and text fields live in the existing webview draft store, separately per Macro/style/author language. Refresh and full remount retain them; they never enter canonical Macro metadata. The editor verifies the host reply against the complete save snapshot and content digests, ignoring a reply that no longer describes the draft.

## Security and platform boundary

**Asset publication is Linux-only**, on local file-backed workspaces with `/proc/self/fd`, `O_TMPFILE`, and `/bin/ln` supporting descriptor-relative atomic non-overwriting links. Windows, macOS, virtual providers and unsupported filesystems fail closed. There is no path-check-then-write portability fallback. This does not certify a Windows installation.

The host independently parses and validates both source and runtime XML, including namespaces, CSS/URL forms, local IDs/references and empty slot anchors. Limits are 1 MiB per SVG, 256 KiB for the manifest and 500 characters for the label. Path traversal, reserved/unsafe slugs and symlinks are rejected. Publication uses the existing workspace `.data-write.lock`, including pending batch-recovery rejection; Reader/cache/lock implementations are not replaced.

New files are sealed to mode 0400 before publication and the entire resulting asset set is checked by held inode identities, exact bytes and mode before a success reply. Existing content is never overwritten. Failure quarantines only transaction-owned entries; ambiguous entries and cleanup errors remain visible rather than being silently destroyed. The lock remains the current **cooperative-writer** protocol, not a guarantee against a malicious process controlling the entire workspace. Previously published or orphaned immutable assets are not garbage-collected automatically.

The Node XML validator is bundled during `npm run compile` into `out/svgTemplateHostValidation.js`; its parser is the existing lockfile-pinned `saxes` build-time dependency through jsdom. The packaged module needs no runtime saxes installation. The browser uses Web Crypto for SHA-256 rather than adding a dependency. No package version, Basics pin or lockfile is changed.

## Verification

Run all commands under the deployment's resource-admission wrapper where required. Relevant suites are `src/svgMacroAssets.test.ts`, `src/createMacroPanelCreateToEdit.test.ts`, `webview/src/svg-editor/SvgMacroEditor.test.tsx`, and `webview/src/CreateMacroDraft.test.tsx`, with one Vitest worker. Include nearby Macro/i18n/tag/asset-loader/lock tests and TypeScript checks including test files.

After `npm run compile`, build only the production Macro entry with `SNL_WEBVIEW_ENTRY=createMacro node node_modules/vite/bin/vite.js build --config webview/vite.config.ts`. Run `node scripts/test-svg-macro-editor.mjs` with a public `snl` CLI on PATH (or `SNL_CLI`), Chromium (`SNL_CHROMIUM_PATH` if needed) and a fresh external `SNL_SVG_EVIDENCE` directory. The harness executes real production CreateMacro import/edit/preview/reload, calls the actual Linux publisher, saves/reads a Macro through official CLI CAS and checks dangerous SVG, failed save, late success, prior-file preservation and stale CAS. It records a screenshot, command results, immutable asset hashes and process closure. Its HTTP message adapter is **not an installed VS Code Extension Development Host**. Run that additional acceptance before a Marketplace release.

Read-only HTML exports remain readers: no SVG import or workspace write bridge is installed there.
