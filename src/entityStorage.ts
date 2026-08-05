import { createHash } from 'node:crypto';

export const PACKAGE_STORAGE_VERSION = 1 as const;
export const ENTRY_STORAGE_VERSION = 1 as const;
export const MACRO_STORAGE_VERSION = 1 as const;
export const UNPACKAGED_PACKAGE_ID = '_unpackaged' as const;

export type EntityIdentityKind = 'package' | 'entry' | 'macro';

export interface PackageManifest {
  [key: string]: unknown;
  format: 'snl-package';
  version: typeof PACKAGE_STORAGE_VERSION;
  id: string;
  name: string;
  description: string;
}

export interface EntryEnvelope<T extends Record<string, unknown> = Record<string, unknown>> {
  format: 'snl-entry';
  version: typeof ENTRY_STORAGE_VERSION;
  package: string;
  entry: T;
}

export interface MacroEnvelope<T extends Record<string, unknown> = Record<string, unknown>> {
  format: 'snl-macro';
  version: typeof MACRO_STORAGE_VERSION;
  package: string;
  macro: T;
}

const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function assertPackageId(packageId: string): void {
  if (packageId !== UNPACKAGED_PACKAGE_ID &&
      (!PACKAGE_ID_RE.test(packageId) || packageId.toLowerCase().endsWith('.json'))) {
    throw new Error(
      `Package id ${JSON.stringify(packageId)} must be 1-64 ASCII letters, digits, dots, underscores, or hyphens, start with a letter or digit, and not end in .json.`
    );
  }
  if (WINDOWS_DEVICE_RE.test(packageId)) {
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
  description: string
): PackageManifest {
  assertPackageId(id);
  return { format: 'snl-package', version: PACKAGE_STORAGE_VERSION, id, name, description };
}

export function makeEntryEnvelope<T extends Record<string, unknown>>(
  packageId: string,
  entry: T
): EntryEnvelope<T> {
  assertPackageId(packageId);
  return { format: 'snl-entry', version: ENTRY_STORAGE_VERSION, package: packageId, entry };
}

export function makeMacroEnvelope<T extends Record<string, unknown>>(
  packageId: string,
  macro: T
): MacroEnvelope<T> {
  assertPackageId(packageId);
  return { format: 'snl-macro', version: MACRO_STORAGE_VERSION, package: packageId, macro };
}
