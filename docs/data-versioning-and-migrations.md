# Data versioning and migrations

## Version domains

SNL Doc has intentionally separate version domains:

- **Extension release**: `package.json#version` (currently `0.1.0`). This is the VS Code Marketplace/package release and never drives workspace migration.
- **Workspace topology schema**: `.SNL_Doc/config.json#version`, a strict `major.minor.patch` SemVer string. The current version is `0.1.0`; it plans coordinated cross-file migrations.
- **Split-file payload schema**: every `snl-package`, `snl-entry`, and `snl-macro` file carries a numeric `schema_version` independent of its envelope `version`. The current Package generation is `2`; Entry and Macro remain at generation `1`. Files created before `0.0.10` have no marker and are the unique implicit legacy generation. Package schema `2` adds the authoritative, exact `entry_ids` membership index and is reached only through the coordinated workspace `0.0.10 -> 0.0.11` migration, not by an isolated lazy Package-file rewrite.
- **Macro package format**: each Macro package's `version` (currently string generation `"11"`). This is a subordinate file-format generation. A workspace migration may rewrite it, but it is not compared with the workspace SemVer.
- **Relationships file format**: `relationships.json#version` (currently numeric generation `1`). It is likewise subordinate to the workspace data version.
- Library `meta.json`, `graph.json`, `counters.json`, and the legacy aggregate `entries.json` currently have no independent version field. Their supported shapes are determined by the workspace data version.

Before `0.0.4`, these domains were not consistently governed: config used SemVer-like strings, Macro packages used string generations, relationships used a number, and several schema changes only normalized in memory without bumping config. Version `0.0.4` establishes the workspace-wide convention and persists those deferred repairs.

## Workspace SemVer policy

While the workspace schema is pre-`1.0`, every adjacent `0.0.x` increment may carry a coordinated, migration-required topology change. The explicit migration registry, not SemVer compatibility inference, governs support. After `1.0.0`, the intended policy is:

- **PATCH**: compatible field/schema repair or canonicalization that does not change entity identity or storage topology.
- **MINOR**: storage topology, identity, or reference changes that require coordinated reader/writer migration.
- **MAJOR**: a deliberately unsupported compatibility break.

Every persisted workspace format change must:

1. choose a new workspace data version;
2. register exactly one explicit `from -> to` migration;
3. preserve a contiguous path from every supported historical version;
4. add tests for the individual step and multi-step chaining;
5. update new-workspace scaffolding to the new current version.

The registry is intentionally explicit; SemVer arithmetic does not invent missing migrations.

## Current chain

- `0.0.1 -> 0.0.2`: materialize Entry/Macro kind catalogs.
- `0.0.2 -> 0.0.3`: normalize kind coloring and legacy numbering shapes.
- `0.0.3 -> 0.0.4`: persist `defaultCounterName`, current kind records, and canonical Macro package v7 data.
- `0.0.4 -> 0.0.5`: validate canonical Macro v7 input, canonicalize plain-string packages to v8, and add `default_style.en`. Localized Macro templates block automatic migration because splitting them would silently change explicit `[style]` source semantics.
- `0.0.5 -> 0.0.6`: validate canonical Macro v8 input, then split aggregate Entries and Macros into stable per-entity Package storage; legacy aggregates remain frozen backups at `0.0.5`.
- `0.0.6 -> 0.0.9`: migrate published Macro schema v8 directly to v11, preserving every explicit Style while replacing language-to-Style defaults with one atomically localized complete TemplateSpec; also apply themed Kind colors.
- `0.0.7 -> 0.0.9`: migrate Macro schema v9 directly to v11 and apply themed Kind colors.
- `0.0.8 -> 0.0.9`: migrate Macro schema v10 directly to v11 and apply themed Kind colors. Missing kinds become `const`, persisted `partial` becomes `sub`, and all other consumer-defined kind strings are preserved.
- `0.0.9 -> 0.0.10`: enable per-file payload schema migration without eagerly rewriting existing split files. An absent `schema_version` remains readable as the single legacy generation.
- `0.0.10 -> 0.0.11`: derive exact Entry ownership from all Entry envelopes, publish sorted `entry_ids` in every Package manifest, and advance Package payload schema `1 -> 2`. This is a cross-file membership migration: Package manifests and Entry envelopes are validated together before the workspace version is committed.
- `0.0.11 -> 0.1.0`: align the workspace topology version with Extension `0.1.0`. Payload schemas remain unchanged; the migration advances only `config.json#version` after the existing current-schema validation gates pass.

All three direct edges compose every transformation omitted between their source
and `0.0.9`. Macro v11 localizes a complete TemplateSpec rather than only a text
body. The Kind-color step splits each pair into explicit `light` and `dark`
stroke/background variants; legacy pairs are duplicated exactly, while a
one-sided themed compatibility record copies its surviving side before commit.

Unknown future versions are rejected by migration and treated as read-only by ordinary data writers, preventing an older Extension from rewriting a newer schema.

Entry and Macro split-file reads validate and migrate the single implicit legacy generation into their current in-memory schema without writing it. A later modification rewrites that complete file with the current `schema_version`, preserves unknown envelope extensions, and compares against the exact pre-migration disk snapshot; unmodified files remain byte-identical. Package schema `2` is deliberately outside that lazy boundary because `entry_ids` is cross-file membership metadata: a `0.0.10` Package schema `1` manifest must be upgraded by the registered workspace migration that inspects the complete Entry set. Cross-file identity, topology, receipt, membership, and reference changes must continue to use a workspace migration rather than independent lazy file rewrites.

## Commands

- **SNL: Check Data Version** inspects only; it does not write.
- **SNL: Repair / Migrate Data** presents the exact chain, asks for confirmation, then executes every step in order.

Before writing, migrations run a strict preflight over catalogs and every Macro package; malformed records and duplicate identities are rejected rather than normalized to empty data. Payload files are atomically replaced before `config.json` receives the new committed version. A local, exclusive `.SNL_Doc/.data-write.lock` serializes migrations with every Extension data write/delete across Extension Host processes. The lock contains owner metadata; a dead-process lock is reported for explicit removal after the user confirms that no writer remains, rather than being auto-unlinked through a racy pathname check. Read-modify-write operations carry their original JSON snapshot into the critical section and reject stale writes if the file changed before lock acquisition. Each migration replacement additionally verifies that the file still matches the snapshot loaded by the migrator. If a write fails, completed writes are rolled back, with the same snapshot guard preventing rollback from overwriting a later edit. The process-local re-entry guard remains for immediate duplicate-command feedback.

The current atomic replacement implementation is enabled only for local `file:` workspaces. VS Code virtual/remote providers do not promise atomic overwrite semantics, so migration refuses those schemes until a persistent provider-independent journal/recovery protocol exists. The Dashboard exposes both commands, displays detected and target versions, disables operations while one is active, and discards stale refresh results.
