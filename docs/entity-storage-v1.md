# Per-entity Package storage (workspace data `0.0.6`)

Workspace data `0.0.5` introduced one JSON file per Entry and Macro, but its Entry filename included mutable Package membership. Workspace data `0.0.6` migrates those Entry files to globally stable, Entry-ID-only hash paths. The legacy `entries.json` and `term_macros/*.json` files remain unchanged as the bounded `0.0.4` backup; current readers never merge them with the entity representation.

## Layout

```text
.SNL_Doc/
├── config.json
├── packages/<PackageId>-<packageHash>.json
├── entries/<entryHash>.json
├── macros/<PackageId>-<macroHash>.json
├── entries.json                 # frozen 0.0.4 backup
└── term_macros/*.json           # frozen 0.0.4 backup
```

New workspaces omit the two legacy backup locations. Existing Entries migrate to the explicit immutable Package ID `_unpackaged`; the migration never guesses a Package from an Entry ID or Library membership.

## Stable path hash

Paths hash logical identity, not mutable JSON content. Editing a title, description, Macro style, or backend therefore does not rename the file.

- Algorithm: SHA-256, lowercase hexadecimal, first 20 hex digits (80 bits).
- Domain-separated input is exact UTF-8 `snl-doc/v1\0<kind>\0<identity...>`, with identity components separated by NUL bytes.
- Inputs:
  - Package: `package`, `packageId`
  - Entry: `entry`, `entry.id` (globally unique; Package membership is mutable metadata)
  - Macro: `macro`, `packageId`, `macro.name`
- Any exact or case-folded target-path collision aborts migration. No collision is resolved by overwrite or suffix guessing.

Package IDs are immutable, at most 64 characters, and Windows-safe ASCII (`[A-Za-z0-9][A-Za-z0-9._-]*`), with `_unpackaged` as the sole reserved system exception. Windows device basenames are rejected. Entry IDs and Macro names may not contain NUL, because NUL separates identity components in the frozen hash input.

Entry Package membership is editable metadata. Moving an Entry does not change its identity-derived filename: globally unique `entry.id` alone determines the path, so Library, relationship, Macro-source, and SNL references can point-read it without knowing or tracking its current Package. A Package cannot be deleted while any Entry still belongs to it; Entries must first be moved, usually to `_unpackaged`.

## JSON envelopes

Package manifest:

```json
{
  "format": "snl-package",
  "version": 1,
  "id": "Logic",
  "name": "Logic",
  "description": "Logical operators"
}
```

Entry entity:

```json
{
  "format": "snl-entry",
  "version": 1,
  "package": "_unpackaged",
  "entry": {
    "id": "Set.sec.set",
    "package": "_unpackaged"
  }
}
```

Macro entity:

```json
{
  "format": "snl-macro",
  "version": 1,
  "package": "Logic",
  "macro": {
    "name": "FOL.implies"
  }
}
```

The complete Entry/Macro record is stored inside its envelope. Package wrapper extension fields survive on the manifest. Readers verify envelope type/version, inner identity, Package agreement, expected path, duplicate identities, and case-folded Package uniqueness.

Package IDs are case-preserved immutable identities. They are 1–64 ASCII letters, digits, `.`, `_`, or `-`, must start with a letter or digit, must not end in `.json`, and must not be a Windows device name. Creation rejects case-fold-equivalent IDs such as `Foo` and `foo`.

## Ordering and Git behavior

Directory enumeration order is never semantic. Entries sort by `(packageId, entry.id)` rather than legacy aggregate insertion order; Macros sort by `(packageId, macro.name)`; Package collision precedence continues to use Package ID/file-name order. Library graph files remain the source of authorial Entry order. There is no tracked global index, so independent entity additions do not touch a shared hotspot. Runtime callers that know an Entry ID compute its hash path and read exactly that file; directory enumeration is reserved for explicit list/search/audit operations.

## Migration and recovery

The published `0.0.4 -> 0.0.5` step remains historically frozen: it creates typed entity envelopes and stores each Entry at the legacy Package-qualified path `entries/<PackageId>-hash(PackageId,entryId).json`. Existing `0.0.5` workspaces therefore require a real adjacent migration; they must not be reinterpreted by rewriting that old step.

The adjacent `0.0.5 -> 0.0.6` step:

1. strictly validates every Entry envelope and accepts only its exact legacy path, its exact new ID-only path (interrupted-run residue), or an identical pair;
2. preflights exact and case-folded target collisions in memory;
3. under the shared writer lock, writes every missing ID-only target before deleting its Package-qualified source;
4. re-reads and validates the complete entity tree, Entry counts and unchanged legacy backups;
5. records `config.json#entity_storage.entry_path_version = 2` and commits `config.json#version = 0.0.6` last;
6. on any failure, restores deleted legacy files and removes only new files whose content still matches the migration output.

The original `0.0.4 -> 0.0.5` migration itself:

1. strictly validates aggregate catalogs, Entry IDs, v7 Macro wrappers, duplicate identities, Package IDs, case-fold collisions, target collisions, and destination state;
2. builds Package manifests and typed entity envelopes in memory;
3. writes all entity payloads under the shared cross-process writer lock;
4. records source identity counts plus semantic SHA-256 digests in `config.json#entity_storage.receipt` and commits its version last.

The original aggregates remain unchanged as the `0.0.4` backup. Current `0.0.6` CRUD does not update them. Ordinary point reads and Library writes require a structurally valid current config, Entry-path v2 metadata, receipt, entity directories, and every active Package manifest; only explicit migration/audit paths enumerate entity directories.
