import { createHash } from 'node:crypto';
import { validatePackageId } from './packageIdValidation';

export const PACKAGE_STORAGE_VERSION = 1 as const;
export const ENTRY_STORAGE_VERSION = 1 as const;
export const MACRO_STORAGE_VERSION = 1 as const;
export const CURRENT_PACKAGE_SCHEMA_VERSION = 2 as const;
export const CURRENT_ENTRY_SCHEMA_VERSION = 1 as const;
export const CURRENT_MACRO_SCHEMA_VERSION = 1 as const;
export const UNPACKAGED_PACKAGE_ID = '_unpackaged' as const;

export type EntityIdentityKind = 'package' | 'entry' | 'macro';

/** Locale-independent ordering for persisted canonical identities. */
export function compareCanonicalIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface PackageManifest {
  [key: string]: unknown;
  format: 'snl-package';
  version: typeof PACKAGE_STORAGE_VERSION;
  schema_version: typeof CURRENT_PACKAGE_SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  /** Stable, sorted membership index for Package-scoped Entry point reads. */
  entry_ids: string[];
}

export interface EntryEnvelope<T extends Record<string, unknown> = Record<string, unknown>> {
  [key: string]: unknown;
  format: 'snl-entry';
  version: typeof ENTRY_STORAGE_VERSION;
  schema_version: typeof CURRENT_ENTRY_SCHEMA_VERSION;
  package: string;
  entry: T;
}

export interface MacroEnvelope<T extends Record<string, unknown> = Record<string, unknown>> {
  [key: string]: unknown;
  format: 'snl-macro';
  version: typeof MACRO_STORAGE_VERSION;
  schema_version: typeof CURRENT_MACRO_SCHEMA_VERSION;
  package: string;
  macro: T;
}

export function assertPackageId(packageId: string): void {
  const validationError = validatePackageId(packageId);
  if (validationError === 'invalid-format') {
    throw new Error(
      `Package id ${JSON.stringify(packageId)} must be 1-64 ASCII letters, digits, dots, underscores, or hyphens, start with a letter or digit, and not end in .json.`
    );
  }
  if (validationError === 'reserved-windows-name') {
    throw new Error(`Package id ${JSON.stringify(packageId)} is a reserved Windows device name.`);
  }
}

export function entityIdentityHash(kind: EntityIdentityKind, ...segments: string[]): string {
  if (segments.some((segment) => segment.includes('\0'))) {
    throw new Error('Entity identities may not contain NUL characters.');
  }
  const serialized = Buffer.from(
    `snl-doc/v1\0${kind}\0${segments.join('\0')}`,
    'utf8'
  );
  return createHash('sha256').update(serialized).digest('hex').slice(0, 20);
}

export function packageManifestPath(packageId: string): string {
  assertPackageId(packageId);
  return `packages/${packageId}-${entityIdentityHash('package', packageId)}.json`;
}

export function entryEntityPath(packageId: string, entryId: string): string {
  assertPackageId(packageId);
  if (!entryId) throw new Error('Entry id must be non-empty.');
  return `entries/${packageId}-${entityIdentityHash('entry', packageId, entryId)}.json`;
}

export function macroEntityPath(packageId: string, macroName: string): string {
  assertPackageId(packageId);
  if (!macroName) throw new Error('Macro name must be non-empty.');
  return `macros/${packageId}-${entityIdentityHash('macro', packageId, macroName)}.json`;
}

export function makePackageManifest(
  id: string,
  name: string,
  description: string,
  entryIds: readonly string[] = []
): PackageManifest {
  assertPackageId(id);
  const normalizedEntryIds = [...entryIds].sort(compareCanonicalIds);
  if (normalizedEntryIds.some((entryId) => typeof entryId !== 'string' || !entryId || entryId !== entryId.trim()) ||
      new Set(normalizedEntryIds).size !== normalizedEntryIds.length) {
    throw new Error('Package entry_ids must contain unique, non-empty canonical Entry ids.');
  }
  return {
    format: 'snl-package',
    version: PACKAGE_STORAGE_VERSION,
    schema_version: CURRENT_PACKAGE_SCHEMA_VERSION,
    id,
    name,
    description,
    entry_ids: normalizedEntryIds
  };
}

export function makeEntryEnvelope<T extends Record<string, unknown>>(
  packageId: string,
  entry: T
): EntryEnvelope<T> {
  assertPackageId(packageId);
  return {
    format: 'snl-entry',
    version: ENTRY_STORAGE_VERSION,
    schema_version: CURRENT_ENTRY_SCHEMA_VERSION,
    package: packageId,
    entry
  };
}

export function makeMacroEnvelope<T extends Record<string, unknown>>(
  packageId: string,
  macro: T
): MacroEnvelope<T> {
  assertPackageId(packageId);
  return {
    format: 'snl-macro',
    version: MACRO_STORAGE_VERSION,
    schema_version: CURRENT_MACRO_SCHEMA_VERSION,
    package: packageId,
    macro
  };
}

function upgradeSchemaMarker<T extends Record<string, unknown>, V extends number>(
  value: T,
  current: V,
  label: string
): T & { schema_version: V } {
  if (!Object.hasOwn(value, 'schema_version')) {
    const { format, version, ...rest } = structuredClone(value);
    return { format, version, schema_version: current, ...rest } as unknown as T & { schema_version: V };
  }
  if (!Number.isInteger(value.schema_version) || (value.schema_version as number) < 1) {
    throw new Error(`${label} schema_version must be a positive integer.`);
  }
  if ((value.schema_version as number) > current) {
    throw new Error(
      `${label} schema version ${String(value.schema_version)} is newer than this Extension supports (${current}).`
    );
  }
  if ((value.schema_version as number) < current) {
    throw new Error(
      `${label} schema_version ${String(value.schema_version)} has no registered migration to ${current}.`
    );
  }
  return { ...structuredClone(value), schema_version: current } as T & { schema_version: V };
}

export function upgradePackageManifestSchema<T extends Record<string, unknown>>(
  value: T
): T & { schema_version: typeof CURRENT_PACKAGE_SCHEMA_VERSION } {
  return upgradeSchemaMarker(value, CURRENT_PACKAGE_SCHEMA_VERSION, 'Package manifest');
}

export function upgradeEntryEnvelopeSchema<T extends Record<string, unknown>>(
  value: T
): T & { schema_version: typeof CURRENT_ENTRY_SCHEMA_VERSION } {
  return upgradeSchemaMarker(value, CURRENT_ENTRY_SCHEMA_VERSION, 'Entry envelope');
}

export function upgradeMacroEnvelopeSchema<T extends Record<string, unknown>>(
  value: T
): T & { schema_version: typeof CURRENT_MACRO_SCHEMA_VERSION } {
  return upgradeSchemaMarker(value, CURRENT_MACRO_SCHEMA_VERSION, 'Macro envelope');
}
