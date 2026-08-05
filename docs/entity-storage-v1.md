# Per-entity Package storage (workspace data `0.0.5`)

Workspace data `0.0.5` replaces aggregate Entry and Macro writes with one stable-identity JSON file per entity. The legacy `entries.json` and `term_macros/*.json` files remain unchanged as the bounded `0.0.4` backup; `0.0.5` readers never merge them with the new representation.

## Layout

```text
.SNL_Doc/
├── config.json
├── packages/<PackageId>-<packageHash>.json
├── entries/<PackageId>-<entryHash>.json
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
  - Entry: `entry`, `packageId`, `entry.id`
  - Macro: `macro`, `packageId`, `macro.name`
- Any exact or case-folded target-path collision aborts migration. No collision is resolved by overwrite or suffix guessing.

Package IDs are immutable, at most 64 characters, and Windows-safe ASCII (`[A-Za-z0-9][A-Za-z0-9._-]*`), with `_unpackaged` as the sole reserved system exception. Windows device basenames are rejected. Entry IDs and Macro names may not contain NUL, because NUL separates identity components in the frozen hash input.

Entry Package membership is editable. Moving an Entry changes its identity-derived filename but not `entry.id`, so Library, relationship, Macro-source, and SNL references remain stable. A Package cannot be deleted while any Entry still belongs to it; Entries must first be moved, usually to `_unpackaged`.

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

Directory enumeration order is never semantic. Entries sort by `(packageId, entry.id)` rather than legacy aggregate insertion order; Macros sort by `(packageId, macro.name)`; Package collision precedence continues to use Package ID/file-name order. Library graph files remain the source of authorial Entry order. There is no tracked global index, so independent entity additions do not touch a shared hotspot.

## Migration and recovery

The adjacent `0.0.4 -> 0.0.5` step:

1. strictly validates aggregate catalogs, Entry IDs, v7 Macro wrappers, duplicate identities, Package IDs, case-fold collisions, target collisions, and destination state; a matching subset left by an interrupted run is resumed, while any extra or conflicting residue aborts;
2. builds Package manifests and typed entity envelopes in memory;
3. writes all entity payloads under the shared cross-process writer lock;
4. re-reads every generated file, validates the complete entity tree and identity counts, and revalidates every unchanged legacy source immediately before commit;
5. records source identity counts plus semantic SHA-256 digests in `config.json#entity_storage.receipt`, then commits `config.json#version = 0.0.5` last; current-version inspection requires this receipt to match the frozen backups;
6. guarded rollback deletes only files whose content still matches the migration output and restores only files whose current content still matches the failed write.

The original aggregates are intentionally retained unchanged as the `0.0.4` backup. A future adjacent migration may remove them after the compatibility period; ordinary `0.0.5` CRUD does not update them.
