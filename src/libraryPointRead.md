# Library point-read foundation (not host integration)

This opt-in read-only layer preserves current hashed Package+Entry paths,
Package schema-v2 membership, current supported config metadata, and Macro
payload-v11 validation. It never imports snlDoc at runtime or calls full Entry /
Macro pool readers. Existing callers and writes are unchanged.

## Integration contract

1. Bind `LibraryPointReadProvider.readFile` and `readDirectory` to a single
   `.SNL_Doc` provider URI using the provider's URI join operation. Construct
   `EntryIdentityIndex` with the full unencoded URI as root identity. `allowEnoent`
   is only for a Node-style shim; FileNotFound is recognized by default. Do not
   preflight with a catch-all `exists` adapter. There are no stat calls.
2. Cold `snapshot()` validates config and enumerates **Package metadata only**.
   All manifests, including inactive Entry owners, participate. Duplicate IDs
   fail closed. No orphan-body discovery or aggregate fallback occurs.
3. Create a fresh `createLibraryPointReadSession(index)` for each body request.
   `readEntry(id)` is ID-only; owner metadata is revalidated once per session.
   Misses distinguish unindexed IDs from indexed missing bodies. `readMacro(name)`
   reads every active candidate at its exact path, including missing/shadowed
   candidates, validating each and folding in current Package-file last-wins order.
   Missing active Package metadata is fatal. Absent active config uses all normal
   Packages; `_unpackaged` is excluded from Macro activation like the full reader.
4. Pass graph-normalized seed IDs to `readLibraryRenderClosure`. Its queue is
   serial (one body read at a time) and deduplicates identities. It parses current
   postfix/source fields and Macro source.entries; parse failures propagate.
   Literal environment nodes are not Macro names. Binder names intentionally
   retain the existing frozen-reader's conservative Macro lookup semantics.
   Empty seeds read no dependency bodies (a cold session still reads metadata).
5. Consume requested/missing IDs and names, **all** candidate paths, and
   root/epoch/phase/op/outcome/byte-hash receipts. Unindexed misses have no known
   body path: Package metadata invalidation is essential for their creation.

## Lifetime / invalidation obligations

The index is process-local single-flight state, **not an installed watcher**.
Invalidate it on config or any Package manifest create/delete/change/move,
including events during a build. In-flight stale builds and reads reject rather
than publish. On a root change invalidate/retire the old index and construct a
new root-bound index. Never reuse it after restart without a cold metadata read.
A fresh body session re-reads bodies and missing candidates; reusing a session
memoizes both successes and misses. Dependency-body changes must retire the
session/result even when metadata is unchanged. Hosts must implement their own
body generation guard; this foundation is not a transactional filesystem snapshot.

## Explicitly unimplemented

- Library graph resolution seam, metadata/graph/counter orchestration and Infoview
  wiring: existing readLibraryGraph can still hide a full readEntries call.
- First-paint scheduling, body/global transport patches, global source analysis,
  cache freshness/publication, watcher routing and lifecycle integration.
- Final relation-navigation closure, frozen capture and export revalidation.
  `kind: 'render-context'` deliberately is not a FrozenReaderSnapshot. Full reader
  semantics still include bidirectional relation neighbors and their dependencies.
- Editor read/watch integration. No storage/schema migration or write behavior.

## Verification

Focused cases use temporary native files through the same strict provider seam,
plus explicit provider failures and controlled asynchronous gates. The full native
parser and unchanged frozen closure are differential references. Metadata directory
reads are counted separately; Entry/Macro directory enumeration throws.

After the repository's standard test-artifact preparation, run the three new test
files plus entityStorageIo/entityStorageSchemaIo/sharedReaderSnapshot tests with
Vitest one worker. Host types use `tsc --noEmit`; tests (excluded by the host config)
use `tsc --noEmit -p src/libraryPointRead.test-tsconfig.json`.
Use the deployment's prescribed admission wrapper for all Node/npm commands.
