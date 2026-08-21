# Extension UI specifications

This workspace is the authoritative home for behavioral specifications of SNL-Doc-Extension UI components.

## Structure

- `libraries/extension-ui-tour/` is the migrated UI tour and its reading graph.
- `entries/` contains the tour Entries plus provenance Entries required by referenced terminology Macros.
- `packages/extension-ui-spec-*.json` owns the specification Entries.
- `macros/` and the terminology Package manifests contain the exact Macro dependency closure used by those Entries.
- `assets/` contains diagrams and screenshots referenced by image Entries.

The migration intentionally excludes Toolkit-generated HTML exports and unrelated Toolkit Libraries. SNL-Agent-Toolkit is no longer the authority for this UI tour; future specification edits belong here.

## Authoring contract

1. Describe expected component behavior in `content.snl`; do not replace specifications with implementation notes.
2. Put supporting diagrams under `assets/` and reference them through an Entry so graph and rendering dependencies stay explicit.
3. Keep Macro `source.entries`, SNL context postfixes, Package membership, and Library graph references closed inside this workspace.
4. Preserve semantic Entry and Macro IDs when revising content. Use the repository's rename machinery for identity changes.
5. Do not commit generated HTML exports as specification sources.

Run the closure verifier after every change:

```bash
npm run verify:ui-spec
```

## Collaboration

Treat a Library as single-writer across active branches: avoid modifying the same Library from multiple branches at once. The current Relationship pool is aggregate, so branches that both edit Relationships may still need a semantic merge even when their visible Library work differs.

When concurrent edits are unavoidable, merge records by stable Entry, Macro, Relationship, and graph-node identities. Do not resolve structured-data conflicts by blindly choosing `ours`/`theirs` or by using `merge=union`; ask an Agent to perform and validate the semantic merge instead.

Projects that require frequent, high-volume concurrent graph authoring should use a graph database such as Neo4j as the collaboration authority, then import reviewed snapshots into `.SNL_Doc` rather than treating Git JSON files as a multi-writer graph database.
