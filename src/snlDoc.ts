import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import * as vscode from 'vscode';
import { invariantHostText } from './hostI18n';
import { read_extension_preferences } from './preferences';
import { formatMacroConflict } from './macroOutputI18n';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  analyzeLatexTemplatePlaceholders,
  isSnlIdentifier,
  migrateMacroV7toV8,
  type Localized
} from './snlBasicsHostCompat';
import {
  is_valid_macro_i18n_string,
  normalize_entry_content,
  normalize_entry_title,
  normalize_kind_label,
  normalize_macro_template
} from './localizedContent';
import { slugify } from './slug';
import { CURRENT_DATA_VERSION, compareDataVersions } from './dataMigrationCore';
import {
  assertThemedKindCatalogs,
  fillKindColoringDefaults,
  mergeThemedKindColoring,
  normalizeKindColoring,
  requireThemedKindColoring,
  type ThemedKindColoring
} from './kindColoring';
import {
  updateRawLibraryGraphNodeEntryId,
  wrapRawLibraryGraphNodeWithParent
} from './libraryGraph';
import {
  UNPACKAGED_PACKAGE_ID,
  assertPackageId,
  entryEntityPath,
  macroEntityPath,
  makeEntryEnvelope,
  makeMacroEnvelope,
  makePackageManifest,
  packageManifestPath,
  type MacroEnvelope
} from './entityStorage';
import {
  normalizeEntryContributor,
  normalizeUpdatedEntryContributor
} from './entryContributor';
import {
  assertCurrentEntityFile,
  readEntryEntityRecordWithOwner,
  readEntryEntityRecords,
  readIndexedPackageEntryRecords,
  readMacroEntityRecords,
  readPackageManifestRecord,
  readPackageManifestRecords,
  entityFileRewriteChanges,
  rewriteEntryEntityRecord,
  rewriteMacroEntityRecord,
  rewritePackageManifestRecord,
  rewritePackageEntryMembership,
  packageManifestEntryIds,
  type PackageManifestRecord,
  type EntryEntityRecord,
  type EntityStorageSnapshot,
  type EntityReadStorage
} from './entityStorageIo';
import {
  assertCanonicalMacroPackage,
  assertJsonSnapshotUnchanged,
  assertWorkspaceDataVersionNotRegressed,
  assertWorkspaceDataWritable,
  makeEntityStorageReceipt
} from './dataMigrations';
import {
  inspectStoredWorkspaceData,
  type StoredWorkspaceDataReadSnapshot
} from './workspaceDataMigration';
import { withWorkspaceDataLock } from './workspaceDataLock';
import { stripJsonExt } from './macroPackageName';
import { loadKindPresetPackages, type KindPresetPackage } from './kindPresets';
import { prepareKindPresetApplication } from './kindPresetApplication';
import {
  normalizeSupportedLanguage,
  supportedLanguagesFromConfig,
  type SupportedLanguageDescriptor
} from './workspaceLanguages';

/**
 * Filesystem helpers for the `.SNL_Doc/` tree.
 *
 * All operations go through `vscode.workspace.fs` so they keep working in
 * remote / virtual filesystems. The module is intentionally panel-free so
 * panels (`createLibraryPanel`, `dashboardPanel`) and any future MCP / CLI
 * surface can reuse the same primitives.
 *
 * Layout produced (see Plan.md §"实装项目时的文件结构"):
 *
 *   .SNL_Doc/
 *   ├── config.json            { version, entry_kinds: [], macro_kinds: [] }
 *   ├── entries.json           shared entry pool (top-level, sibling of libraries/)
 *   ├── term_macros/<pkg>.json macro packages (one file = one package)
 *   └── libraries/<slug>/      one dir per library (source of truth)
 *       ├── meta.json           { title, description? }
 *       ├── graph.json          Neo4j-style { nodes, relationships }
 *       └── documents/{Typst,LaTeX,Markdown}/
 */

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8');

function jsonBytes(value: unknown): Uint8Array {
  return ENCODER.encode(JSON.stringify(value, null, 2) + '\n');
}

function setOwnRecordValue<Value>(
  record: Record<string, Value>,
  key: string,
  value: Value
): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

export function entityRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function macroPackageMetadataRevision(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return entityRevision(raw);
  const { macros: _macros, ...metadata } = raw as Record<string, unknown>;
  return entityRevision(metadata);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(uri: vscode.Uri): Promise<T> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return JSON.parse(DECODER.decode(bytes)) as T;
}

async function assertWorkspaceWritableOnDisk(
  workspaceRoot: vscode.Uri,
  validateTopology = true,
  allowPendingMigration = false
): Promise<unknown> {
  let rawConfig: unknown;
  try {
    rawConfig = await readJson<unknown>(configUri(workspaceRoot));
  } catch (error) {
    throw new Error(
      `Workspace data is not writable: config.json could not be read (${error instanceof Error ? error.message : String(error)}).`
    );
  }
  assertWorkspaceDataWritable(rawConfig, { allowPendingMigration });
  if (
    rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) &&
    (rawConfig as Record<string, unknown>).version === CURRENT_DATA_VERSION
  ) {
    try {
      assertThemedKindCatalogs(rawConfig);
    } catch (error) {
      throw new Error(`Workspace data is not writable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (
    validateTopology &&
    rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) &&
    (rawConfig as Record<string, unknown>).version === CURRENT_DATA_VERSION
  ) {
    const topology = await inspectStoredWorkspaceData(entityReadStorage(workspaceRoot));
    if (topology.status !== 'current') {
      throw new Error(`Workspace data is not writable: ${topology.message}`);
    }
  }
  return rawConfig;
}

interface HeldInProcessWriterContext {
  active: boolean;
}

const heldWriterIdentities = new AsyncLocalStorage<
  ReadonlyMap<string, HeldInProcessWriterContext>
>();
const writerTails = new Map<string, Promise<void>>();

function workspaceWriterIdentity(workspaceRoot: vscode.Uri): string {
  // Uri#toString includes scheme + authority. fsPath alone does not: two
  // remote authorities can legitimately expose the same path.
  return workspaceRoot.toString(true);
}

async function withInProcessWriterLock<T>(
  workspaceRoot: vscode.Uri,
  task: () => Promise<T>
): Promise<T> {
  const identity = workspaceWriterIdentity(workspaceRoot);
  const held = heldWriterIdentities.getStore();
  if (held?.get(identity)?.active) return task();

  const previous = writerTails.get(identity) ?? Promise.resolve();
  let release!: () => void;
  const marker = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => marker);
  writerTails.set(identity, tail);
  await previous.catch(() => undefined);

  const lockContext: HeldInProcessWriterContext = { active: true };
  const nextHeld = new Map(held ?? []);
  nextHeld.set(identity, lockContext);
  try {
    return await heldWriterIdentities.run(nextHeld, task);
  } finally {
    lockContext.active = false;
    release();
    if (writerTails.get(identity) === tail) writerTails.delete(identity);
  }
}

async function withExtensionWriterLock<T>(
  workspaceRoot: vscode.Uri,
  purpose: string,
  task: () => Promise<T>
): Promise<T> {
  const held = heldWriterIdentities.getStore();
  if (held?.get(workspaceWriterIdentity(workspaceRoot))?.active) return task();
  return withInProcessWriterLock(workspaceRoot, () =>
    workspaceRoot.scheme === 'file'
      ? withWorkspaceDataLock(workspaceRoot, purpose, task)
      : task()
  );
}

const NO_EXPECTED_SNAPSHOT = Symbol('no-expected-snapshot');

async function assertRealDirectory(uri: vscode.Uri, label: string): Promise<void> {
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(uri);
  } catch (error) {
    throw new Error(`${label} does not exist: ${error instanceof Error ? error.message : String(error)}`);
  }
  if ((stat.type & vscode.FileType.SymbolicLink) !== 0 || stat.type !== vscode.FileType.Directory) {
    throw new Error(`${label} must be a real directory, not a symlink or special entry.`);
  }
}

async function assertOwnedLibraryRoot(workspaceRoot: vscode.Uri): Promise<void> {
  await assertRealDirectory(snlRootUri(workspaceRoot), '.SNL_Doc');
  await assertRealDirectory(librariesDirUri(workspaceRoot), '.SNL_Doc/libraries');
}

async function ensureOwnedLibraryRootForCreate(workspaceRoot: vscode.Uri): Promise<void> {
  await assertRealDirectory(snlRootUri(workspaceRoot), '.SNL_Doc');
  const libraries = librariesDirUri(workspaceRoot);
  try {
    await vscode.workspace.fs.stat(libraries);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code !== 'FileNotFound' && code !== 'ENOENT') throw error;
    await vscode.workspace.fs.createDirectory(libraries);
  }
  await assertRealDirectory(libraries, '.SNL_Doc/libraries');
}

async function assertOwnedLibraryPath(
  workspaceRoot: vscode.Uri,
  target: vscode.Uri
): Promise<void> {
  await assertOwnedLibraryRoot(workspaceRoot);
  const root = librariesDirUri(workspaceRoot);
  const rootPath = root.path.replace(/\/+$/, '');
  if (!target.path.startsWith(`${rootPath}/`)) {
    throw new Error('Library write target is outside the owned libraries root.');
  }
  const segments = target.path.slice(rootPath.length).split('/').filter(Boolean);
  const slug = segments[0] ?? '';
  libraryDirUri(workspaceRoot, slug);
  for (let index = 0; index < segments.length; index += 1) {
    const current = vscode.Uri.joinPath(root, ...segments.slice(0, index + 1));
    const final = index === segments.length - 1;
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(current);
    } catch (error) {
      if (final) continue;
      throw new Error(
        `Library path component ${JSON.stringify(segments[index])} does not exist: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
      throw new Error(`Library path component ${JSON.stringify(segments[index])} is a symlink.`);
    }
    if (!final && stat.type !== vscode.FileType.Directory) {
      throw new Error(`Library path component ${JSON.stringify(segments[index])} is not a directory.`);
    }
  }
}

async function writeWorkspaceFile(
  workspaceRoot: vscode.Uri,
  uri: vscode.Uri,
  bytes: Uint8Array,
  expectedOriginal: unknown | typeof NO_EXPECTED_SNAPSHOT = NO_EXPECTED_SNAPSHOT,
  validateTopology = true,
  validateEntityOutput = true
): Promise<void> {
  await withExtensionWriterLock(workspaceRoot, `write ${uri.fsPath}`, async () => {
    const librariesPath = librariesDirUri(workspaceRoot).path.replace(/\/+$/, '');
    const libraryWrite = uri.path === librariesPath || uri.path.startsWith(`${librariesPath}/`);
    if (libraryWrite) {
      await assertOwnedLibraryPath(workspaceRoot, uri);
    }
    const currentConfig = await assertWorkspaceWritableOnDisk(
      workspaceRoot,
      validateTopology,
      libraryWrite
    );
    const writingConfig = uri.fsPath === configUri(workspaceRoot).fsPath;
    if (expectedOriginal !== NO_EXPECTED_SNAPSHOT) {
      const currentTarget = writingConfig
        ? currentConfig
        : (await exists(uri) ? await readJson<unknown>(uri) : null);
      assertJsonSnapshotUnchanged(expectedOriginal, currentTarget, uri.fsPath);
    }
    if (writingConfig) {
      let nextConfig: unknown;
      try {
        nextConfig = JSON.parse(DECODER.decode(bytes));
      } catch (error) {
        throw new Error(
          `Refusing to write invalid config JSON: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      assertWorkspaceDataVersionNotRegressed(currentConfig, nextConfig);
    }
    if (validateEntityOutput) {
      const snlPath = snlRootUri(workspaceRoot).path.replace(/\/+$/, '');
      const relative = uri.path.startsWith(`${snlPath}/`)
        ? uri.path.slice(snlPath.length + 1)
        : '';
      if (/^(packages|entries|macros)\/[^/]+\.json$/.test(relative)) {
        let nextEntity: unknown;
        try {
          nextEntity = JSON.parse(DECODER.decode(bytes));
        } catch (error) {
          throw new Error(
            `Refusing to write invalid entity JSON: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        assertCurrentEntityFile(relative, nextEntity);
      }
    }
    await vscode.workspace.fs.writeFile(uri, bytes);
  });
}

async function deleteWorkspaceJsonFile(
  workspaceRoot: vscode.Uri,
  uri: vscode.Uri,
  expectedOriginal: unknown,
  validateTopology = true
): Promise<void> {
  await withExtensionWriterLock(workspaceRoot, `delete ${uri.fsPath}`, async () => {
    await assertWorkspaceWritableOnDisk(workspaceRoot, validateTopology);
    const current = await readJson<unknown>(uri);
    assertJsonSnapshotUnchanged(expectedOriginal, current, uri.fsPath);
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
  });
}

interface JsonFileWriteOperation {
  kind: 'write';
  uri: vscode.Uri;
  value: unknown;
  expected: unknown;
}

interface JsonFileDeleteOperation {
  kind: 'delete';
  uri: vscode.Uri;
  expected: unknown;
}

type JsonFileOperation = JsonFileWriteOperation | JsonFileDeleteOperation;

async function applyJsonFileOperations(
  workspaceRoot: vscode.Uri,
  purpose: string,
  operations: readonly JsonFileOperation[]
): Promise<void> {
  await withExtensionWriterLock(workspaceRoot, purpose, async () => {
    await assertWorkspaceWritableOnDisk(workspaceRoot);
    const completed: JsonFileOperation[] = [];
    try {
      for (const operation of operations) {
        if (operation.kind === 'write') {
          await writeWorkspaceFile(
            workspaceRoot,
            operation.uri,
            jsonBytes(operation.value),
            operation.expected,
            false
          );
        } else {
          await deleteWorkspaceJsonFile(
            workspaceRoot,
            operation.uri,
            operation.expected,
            false
          );
        }
        completed.push(operation);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const operation of completed.reverse()) {
        try {
          if (operation.kind === 'write') {
            if (operation.expected === null) {
              await deleteWorkspaceJsonFile(
                workspaceRoot,
                operation.uri,
                operation.value,
                false
              );
            } else {
              await writeWorkspaceFile(
                workspaceRoot,
                operation.uri,
                jsonBytes(operation.expected),
                operation.value,
                false,
                false
              );
            }
          } else {
            await writeWorkspaceFile(
              workspaceRoot,
              operation.uri,
              jsonBytes(operation.expected),
              null,
              false,
              false
            );
          }
        } catch (rollbackError) {
          rollbackErrors.push(
            `${operation.uri.fsPath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          );
        }
      }
      if (rollbackErrors.length > 0) {
        const original = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${original}; transaction rollback was incomplete and workspace data may be inconsistent: ` +
          rollbackErrors.join('; ')
        );
      }
      throw error;
    }
  });
}

/**
 * Lazily-created "SNL Macros" output channel. Mirrors InfoviewPanel's lazy
 * accessor pattern. Guarded so non-VS-Code hosts (the Node smoke shim, which
 * has no `vscode.window`) degrade to a no-op instead of throwing.
 */
let snlMacrosOutput: vscode.OutputChannel | null = null;
function macroOutputLanguage(): string {
  let language = vscode.env?.language ?? 'en';
  try {
    language = read_extension_preferences().language;
  } catch {
    // Core tests and non-extension hosts may not provide workspace configuration.
  }
  return language;
}

function macrosOutput(): vscode.OutputChannel | null {
  if (snlMacrosOutput) {
    return snlMacrosOutput;
  }
  try {
    const win = (vscode as { window?: typeof vscode.window }).window;
    if (win && typeof win.createOutputChannel === 'function') {
      snlMacrosOutput = win.createOutputChannel(invariantHostText('SNL Macros', 'output-channel'));
      return snlMacrosOutput;
    }
  } catch {
    // Fall through to no-op.
  }
  return null;
}

export function disposeSnlDocResources(): void {
  snlMacrosOutput?.dispose();
  snlMacrosOutput = null;
}

/** Path helpers (all relative to a workspace root). */
export function snlRootUri(workspaceRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(workspaceRoot, '.SNL_Doc');
}

export function configUri(workspaceRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(snlRootUri(workspaceRoot), 'config.json');
}

export function entriesUri(workspaceRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(snlRootUri(workspaceRoot), 'entries.json');
}

/**
 * Pool-wide semantic relationships between entries (cat 2026-07-10).
 * Sibling of `entries.json`. A library's on-disk `graph.json` remains its
 * outline/branch structure; the relationship graph is GLOBAL and a library
 * view of relationships is the *induced subgraph* over the library's entry
 * set. See §"Relationships" in docs (TBD).
 *
 * File shape: `{ version, relationships: RelationshipData[] }`.
 */
export function relationshipsUri(workspaceRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(snlRootUri(workspaceRoot), 'relationships.json');
}

export function termMacrosDirUri(workspaceRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(snlRootUri(workspaceRoot), 'term_macros');
}

export function packageManifestsDirUri(workspaceRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(snlRootUri(workspaceRoot), 'packages');
}

export function entryEntitiesDirUri(workspaceRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(snlRootUri(workspaceRoot), 'entries');
}

export function macroEntitiesDirUri(workspaceRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(snlRootUri(workspaceRoot), 'macros');
}

function snlRelativeUri(workspaceRoot: vscode.Uri, path: string): vscode.Uri {
  return vscode.Uri.joinPath(snlRootUri(workspaceRoot), ...path.split('/'));
}

function entityReadStorage(workspaceRoot: vscode.Uri): EntityReadStorage {
  return {
    async directoryExists(directory): Promise<boolean> {
      return exists(snlRelativeUri(workspaceRoot, directory));
    },
    async listJsonFiles(directory): Promise<string[]> {
      const uri = snlRelativeUri(workspaceRoot, directory);
      if (!(await exists(uri))) return [];
      return (await vscode.workspace.fs.readDirectory(uri))
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
        .map(([name]) => name)
        .sort((left, right) => left.localeCompare(right));
    },
    async readJson(path): Promise<unknown | null> {
      const uri = snlRelativeUri(workspaceRoot, path);
      return await exists(uri) ? readJson<unknown>(uri) : null;
    }
  };
}

function entityStorageModeFromConfig(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config.json must be a JSON object.');
  }
  const version = (raw as Record<string, unknown>).version;
  if (typeof version !== 'string') throw new Error('config.json#version must be a string.');
  const relation = compareDataVersions(version, CURRENT_DATA_VERSION);
  if (relation > 0) {
    throw new Error(`Workspace data ${version} is newer than this Extension supports.`);
  }
  return relation === 0;
}

async function usesEntityStorage(workspaceRoot: vscode.Uri): Promise<boolean> {
  const uri = configUri(workspaceRoot);
  if (!(await exists(uri))) return false;
  let raw: unknown;
  try {
    raw = await readJson<unknown>(uri);
  } catch (error) {
    throw new Error(`Could not read config.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  return entityStorageModeFromConfig(raw);
}

export function librariesDirUri(workspaceRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(snlRootUri(workspaceRoot), 'libraries');
}

export function libraryDirUri(
  workspaceRoot: vscode.Uri,
  slug: string
): vscode.Uri {
  const canonical = (slug ?? '').trim();
  if (!canonical || canonical !== slug || slugify(canonical) !== canonical) {
    throw new Error('Library slug must be one canonical path segment.');
  }
  const librariesRoot = librariesDirUri(workspaceRoot);
  const target = vscode.Uri.joinPath(librariesRoot, canonical);
  if (dirname(resolve(target.fsPath)) !== resolve(librariesRoot.fsPath)) {
    throw new Error('Library slug escapes the Library directory.');
  }
  return target;
}

export function libraryGraphUri(
  workspaceRoot: vscode.Uri,
  slug: string
): vscode.Uri {
  return vscode.Uri.joinPath(
    libraryDirUri(workspaceRoot, slug),
    'graph.json'
  );
}

export function libraryMetaUri(
  workspaceRoot: vscode.Uri,
  slug: string
): vscode.Uri {
  return vscode.Uri.joinPath(
    libraryDirUri(workspaceRoot, slug),
    'meta.json'
  );
}

export function libraryCountersUri(
  workspaceRoot: vscode.Uri,
  slug: string
): vscode.Uri {
  return vscode.Uri.joinPath(
    libraryDirUri(workspaceRoot, slug),
    'counters.json'
  );
}

/**
 * Entry-kind metadata. One element per *category* of Entry the user defines
 * (e.g. "Definition", "Theorem", "Example"). Schema (v0.0.3):
 *
 *  - `id`: stable identifier used in cross-references.
 *  - `name`: display name (any language).
 *  - `coloring.light` / `coloring.dark`: theme-specific CSS stroke/background
 *    pairs used by previews and Entry rendering.
 *  - `defaultCounterName`: name of a Library-scoped counter (matched by
 *    `counter.name`). Empty string = no default counter (entry contributes
 *    no numbering unless the outline ref pins one). Renamed 2026-07-16 from
 *    the former `numbering` DSL field — see {@link normalizeEntryKind} for
 *    the on-read migration (legacy DSL values do NOT carry over as names).
 *  - `style`: free-form tag (e.g. `"remark"`, `"proof"`, `"problem"`) the
 *    renderer maps to a visual variant. Empty string = default box.
 *
 * The interface is intentionally open — extra fields on disk survive
 * round-trips via `JSON.stringify`. See `normalizeEntryKind` for the
 * forward-compat path from the v0.0.2 `color` + object-`numbering` shape.
 */
export interface EntryKind {
  id: string;
  name: Localized<string, string>;
  description?: Localized<string, string>;
  coloring: ThemedKindColoring;
  defaultCounterName: string;
  style: string;
}

/**
 * A single node in a Library-scoped counter tree
 * (`libraries/<slug>/counters.json`). Counters are tree entities managed in
 * the Library Edit panel with the same tree UI as the entry outline.
 *
 *  - `id`: `crypto.randomUUID()` at creation. Stable across renames.
 *  - `name`: human-facing label; also the name that
 *    {@link EntryKind.defaultCounterName} matches on. Uniqueness within a
 *    library is NOT enforced by the schema — name-lookup (see
 *    `findCounterByName` in `src/libraryGraph.ts`) picks the FIRST
 *    depth-first match, so the UI SHOULD warn on duplicate names.
 *  - `numbering`: a Typst-inspired DSL string (e.g. `"1.1.1"`, `"Ex. A"`,
 *    `"§I."`) — the same magic-string format the numbering engine formats.
 *  - `children`: ordered sub-counters.
 */
export interface CounterNode {
  id: string;
  name: string;
  numbering: string;
  children: CounterNode[];
}

/** On-disk shape of `libraries/<slug>/counters.json`. Empty / missing /
 *  malformed → treat as `{ counters: [] }`. */
export interface LibraryCountersFile {
  counters: CounterNode[];
}

/**
 * A macro kind — the semantic category a macro declares via its top-level
 * `kind` field. Unlike {@link EntryKind}, macro kinds carry no
 * numbering / style: they only drive the color palette (stroke/background)
 * used when rendering the macro's subtree in the SNL syntax-tree view.
 *
 *  - `id`: stable identifier referenced by a macro's `kind` (e.g. `rule`).
 *  - `name`: display name shown in dropdowns / dashboard (e.g. `Rule`).
 *  - `description`: short blurb shown next to the kind.
 *  - `coloring.light` / `coloring.dark`: theme-specific CSS stroke/background
 *    pairs used by swatches and the rendered KindPalette.
 *
 * Stored under `config.json#macro_kinds` (sibling of `entry_kinds`). Extra
 * on-disk fields survive round-trips; see {@link normalizeMacroKind}.
 */
export interface MacroKind {
  id: string;
  name: string;
  description: string;
  coloring: ThemedKindColoring;
}

/** Persisted shapes. Kept minimal and forward-compatible. */
export interface SnlConfig {
  version: string;
  /**
   * DEPRECATED (2026-07-06): the libraries list is now derived from the
   * on-disk `libraries/<slug>/meta.json` tree by {@link listLibraries} —
   * not from config. Kept as a nullable field so older configs still load
   * without warnings, but new code MUST NOT write it. Callers should treat
   * it as historical noise; the source of truth is the filesystem.
   */
  libraries?: Array<{ slug: string; title: string }>;
  /** Entry-kind catalog. May be missing in pre-v0.0.2 configs (see
   *  `normalizeConfig`). */
  entry_kinds?: EntryKind[];
  /** Macro-kind catalog. May be missing in older configs. */
  macro_kinds?: MacroKind[];
  /**
   * Bare filenames (no `.json`) of macro packages currently active in
   * this workspace. Only active packages contribute macros to
   * readAllMacros(). Missing = treat every package on disk as active
   * (backwards-compat auto-migration).
   */
  active_macro_packages?: string[];
  entity_storage?: {
    version: 1;
    legacy_backup_version: '0.0.5';
    entry_default_package: typeof UNPACKAGED_PACKAGE_ID;
    receipt: ReturnType<typeof makeEntityStorageReceipt>;
  };
}

/**
 * On-disk shape of `libraries/<slug>/meta.json` — small sidecar carrying
 * human-facing metadata (title, description). Kept separate from
 * `graph.json` so pasting a folder in and dropping this one file is enough
 * to "import a library" (per cat 2026-07-06). Both files are optional at
 * read time; `listLibraries` falls back to the slug when meta.json is
 * missing.
 */
export interface LibraryMetaFile {
  title?: string;
  description?: string;
}

/**
 * On-disk shape of `libraries/<slug>/graph.json` — a Neo4j-style property
 * graph. See `docs/library-graph-spec.md` for the full spec and
 * `src/libraryGraph.ts` for the pure numbering / reading-order engine that
 * consumes this file.
 *
 * Field-level types are kept `unknown[]` here so a malformed on-disk file
 * doesn't reject the whole read; the graph-engine layer validates shapes
 * lazily and surfaces per-node warnings via `readLibraryGraph`.
 */
export interface LibraryGraphFile {
  nodes: unknown[];
  relationships: unknown[];
}

/** Init / Create results returned to panels for UI feedback. */
export type InitResult = { status: 'created' } | { status: 'exists' };

const initializationInFlight = new Map<string, Promise<InitResult>>();

export type CreateLibraryResult =
  | { status: 'created'; slug: string; title: string }
  | { status: 'noSnlDoc' }
  | { status: 'duplicate'; slug: string };

/**
 * Forward-compat helper: read a config and fill in any missing fields with
 * sensible defaults. Older `.SNL_Doc/` directories created before
 * `entry_kinds` existed should still load cleanly. Any `entry_kinds`
 * entries in the pre-v0.0.3 shape (flat `color` + `numbering.pattern`) are
 * migrated in-memory via {@link normalizeEntryKind} so the Dashboard sees
 * the current schema regardless of what's on disk.
 */
function normalizeConfig(raw: unknown): SnlConfig {
  const cfg = (raw ?? {}) as Partial<SnlConfig> & {
    entry_kinds?: unknown;
    macro_kinds?: unknown;
    active_macro_packages?: unknown;
  };
  const hasEntryKindsField = !!raw && typeof raw === 'object' && !Array.isArray(raw) &&
    Object.prototype.hasOwnProperty.call(raw, 'entry_kinds');
  const hasMacroKindsField = !!raw && typeof raw === 'object' && !Array.isArray(raw) &&
    Object.prototype.hasOwnProperty.call(raw, 'macro_kinds');
  if (hasEntryKindsField && !Array.isArray(cfg.entry_kinds)) {
    throw new Error('config.json#entry_kinds must be an array.');
  }
  if (hasMacroKindsField && !Array.isArray(cfg.macro_kinds)) {
    throw new Error('config.json#macro_kinds must be an array.');
  }
  const rawKinds = Array.isArray(cfg.entry_kinds) ? cfg.entry_kinds : [];
  const rawMacroKinds = Array.isArray(cfg.macro_kinds) ? cfg.macro_kinds : [];
  if (cfg.version === CURRENT_DATA_VERSION) {
    assertThemedKindCatalogs(raw);
  }
  for (const [field, records] of [
    ['entry_kinds', rawKinds],
    ['macro_kinds', rawMacroKinds]
  ] as const) {
    const ids = new Set<string>();
    for (const record of records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error(`config.json#${field} must contain JSON objects.`);
      }
      const id = (record as { id?: unknown }).id;
      if (typeof id !== 'string' || !id || id.trim() !== id) {
        throw new Error(`config.json#${field} records require canonical non-empty string ids.`);
      }
      if (ids.has(id)) throw new Error(`config.json#${field} contains duplicate id ${JSON.stringify(id)}.`);
      ids.add(id);
      const managed = record as unknown as Record<string, unknown>;
      if ('name' in managed) {
        if (field === 'entry_kinds') normalize_kind_label(managed.name, 'Entry Kind name', true);
        else if (typeof managed.name !== 'string') {
          throw new Error(`config.json#${field}[${JSON.stringify(id)}].name must be a string.`);
        }
      }
      if (cfg.version === CURRENT_DATA_VERSION) {
        requireThemedKindColoring(
          managed.coloring,
          `config.json#${field}[${JSON.stringify(id)}].coloring`
        );
      } else if ('coloring' in managed) {
        const coloring = managed.coloring;
        const themed = !!coloring && typeof coloring === 'object' && !Array.isArray(coloring) &&
          ('light' in coloring || 'dark' in coloring);
        if (themed) {
          try {
            normalizeKindColoring(coloring);
          } catch (error) {
            throw new Error(
              `config.json#${field}[${JSON.stringify(id)}].coloring is invalid: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        } else {
          const legacy = coloring as Record<string, unknown> | null;
          if (!legacy || typeof legacy !== 'object' ||
              typeof legacy.stroke !== 'string' || typeof legacy.background !== 'string') {
            throw new Error(
              `config.json#${field}[${JSON.stringify(id)}].coloring must contain string stroke and background.`
            );
          }
        }
      }
      if ('color' in managed && typeof managed.color !== 'string') {
        throw new Error(`config.json#${field}[${JSON.stringify(id)}].color must be a string.`);
      }
      if (field === 'entry_kinds') {
        if ('description' in managed) normalize_kind_label(managed.description, 'Entry Kind description', false);
        if ('defaultCounterName' in managed && typeof managed.defaultCounterName !== 'string') {
          throw new Error(`config.json#entry_kinds[${JSON.stringify(id)}].defaultCounterName must be a string.`);
        }
        if ('style' in managed && typeof managed.style !== 'string') {
          throw new Error(`config.json#entry_kinds[${JSON.stringify(id)}].style must be a string.`);
        }
        if ('numbering' in managed) {
          const numbering = managed.numbering;
          if (typeof numbering !== 'string' &&
              (!numbering || typeof numbering !== 'object' || Array.isArray(numbering))) {
            throw new Error(`config.json#entry_kinds[${JSON.stringify(id)}].numbering must be a legacy string or object.`);
          }
        }
      } else if ('description' in managed && typeof managed.description !== 'string') {
        throw new Error(`config.json#macro_kinds[${JSON.stringify(id)}].description must be a string.`);
      }
    }
  }
  // Migration note (2026-07-16): flag legacy `entry_kinds[i].numbering`
  // fields (the pre-rename DSL) exactly once per read. The value is NOT
  // carried into `defaultCounterName` (a DSL is not a counter name); it is
  // left on disk untouched and dropped the next time `writeConfig` runs.
  const legacyNumbering = rawKinds.some((k) => {
    const o = k as unknown as Record<string, unknown>;
    return !!o && typeof o === 'object' &&
      'numbering' in o && !('defaultCounterName' in o);
  });
  if (legacyNumbering) {
    console.warn(
      '[snlDoc] config.json has legacy entry_kinds[].numbering fields; ' +
        'coercing defaultCounterName="" on read (legacy DSL ignored, ' +
        'dropped on next write).'
    );
  }
  const rawActive = cfg.active_macro_packages;
  const hasActiveField = !!raw && typeof raw === 'object' && !Array.isArray(raw) &&
    Object.prototype.hasOwnProperty.call(raw, 'active_macro_packages');
  if (
    hasActiveField &&
    (!Array.isArray(rawActive) || !rawActive.every((value) => typeof value === 'string'))
  ) {
    throw new Error('config.json#active_macro_packages must be an array of Package ID strings.');
  }
  if (Array.isArray(rawActive)) {
    for (const packageId of rawActive as string[]) assertPackageId(packageId);
  }
  const activeMacroPackages = Array.isArray(rawActive)
    ? rawActive as string[]
    : undefined;
  const out: SnlConfig = {
    version: typeof cfg.version === 'string' ? cfg.version : '0.0.1',
    entry_kinds: rawKinds.map(normalizeEntryKind),
    macro_kinds: rawMacroKinds.map(normalizeMacroKind)
  };
  // Legacy `libraries` array is READ for backwards compat (older code paths
  // may still inspect it in-memory), but its authoritative replacement is the
  // on-disk `libraries/*/meta.json` tree. New writers do NOT populate it.
  if (Array.isArray(cfg.libraries)) {
    out.libraries = cfg.libraries;
  }
  if (activeMacroPackages !== undefined) {
    out.active_macro_packages = activeMacroPackages;
  }
  return out;
}

/**
 * Coerce a persisted macro-kind record into the current {@link MacroKind}
 * shape. Never throws — bad fields fall back to safe defaults so the
 * Dashboard always renders something.
 */
function normalizeMacroKind(raw: unknown): MacroKind {
  const obj = (raw ?? {}) as Record<string, unknown>;

  const id = typeof obj.id === 'string' ? obj.id : '';
  const name = typeof obj.name === 'string' ? obj.name : id;
  const description =
    typeof obj.description === 'string' ? obj.description : '';

  const coloring = normalizeKindColoring(
    obj.coloring ?? (typeof obj.color === 'string'
      ? { stroke: obj.color, background: obj.color }
      : undefined)
  );

  const {
    id: _id,
    name: _name,
    description: _description,
    coloring: _coloring,
    color: _legacyColor,
    ...extensions
  } = obj;
  return {
    ...extensions,
    id,
    name,
    description,
    coloring
  };
}

/**
 * Coerce a validated persisted entry-kind record (possibly from an older
 * schema) into the current {@link EntryKind} shape. Compatibility omissions
 * use deterministic fallbacks; malformed managed themed fields are rejected
 * by config validation instead of being silently replaced.
 *
 * Migrations handled:
 *  - v0.0.2 `color: string` → the same stroke/background value in both
 *    themes, preserving the only authored color exactly;
 *  - 2026-07-16 rename: `numbering` (a DSL string) → `defaultCounterName`
 *    (a counter NAME). These are semantically different, so a legacy
 *    `numbering` value is NOT copied into `defaultCounterName` — the field
 *    coerces to `''` (no default counter). A pre-existing string
 *    `defaultCounterName` on disk is preferred and passed through verbatim.
 *  - Missing `style` → `""` (default box).
 */
function normalizeEntryKind(raw: unknown): EntryKind {
  const obj = (raw ?? {}) as Record<string, unknown>;

  const id = typeof obj.id === 'string' ? obj.id : '';
  const name = normalize_kind_label(obj.name ?? id, 'Entry Kind name', true);
  const description = obj.description === undefined
    ? undefined
    : normalize_kind_label(obj.description, 'Entry Kind description', false);

  // coloring: accept legacy `{stroke, background}` while old workspaces are
  // waiting for migration; current writes always use explicit theme variants.
  const coloring = normalizeKindColoring(
    obj.coloring ?? (typeof obj.color === 'string'
      ? { stroke: obj.color, background: obj.color }
      : undefined)
  );

  // defaultCounterName: prefer the new plain-string name. A legacy
  // `numbering` (string or v0.0.2 `{pattern}` object) is deliberately NOT
  // reinterpreted as a name — it coerces to '' (see block comment above).
  const defaultCounterName =
    typeof obj.defaultCounterName === 'string' ? obj.defaultCounterName : '';

  const style = typeof obj.style === 'string' ? obj.style : '';

  const {
    id: _id,
    name: _name,
    description: _description,
    coloring: _coloring,
    color: _legacyColor,
    numbering: _legacyNumbering,
    defaultCounterName: _defaultCounterName,
    style: _style,
    ...extensions
  } = obj;
  return {
    ...extensions,
    id,
    name,
    ...(description === undefined ? {} : { description }),
    coloring,
    defaultCounterName,
    style
  };
}

/**
 * Scaffold an EMPTY `.SNL_Doc/` skeleton — no libraries inside.
 *
 * Use {@link createLibrary} afterwards to add the first library. If the
 * skeleton already exists it does NOT overwrite and returns
 * `{ status: 'exists' }`.
 */
export async function initSnlDoc(
  workspaceRoot: vscode.Uri
): Promise<InitResult> {
  const key = workspaceWriterIdentity(workspaceRoot);
  const active = initializationInFlight.get(key);
  if (active) return active;
  const pending = initializeSnlDocSkeleton(workspaceRoot);
  initializationInFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    if (initializationInFlight.get(key) === pending) initializationInFlight.delete(key);
  }
}

async function initializeSnlDocSkeleton(workspaceRoot: vscode.Uri): Promise<InitResult> {
  const fsApi = vscode.workspace.fs;
  const root = snlRootUri(workspaceRoot);
  const configTarget = configUri(workspaceRoot);
  await fsApi.createDirectory(root);

  return withExtensionWriterLock(workspaceRoot, 'initialize SNL Doc', async () => {
    if (await exists(configTarget)) {
      await assertWorkspaceWritableOnDisk(workspaceRoot);
      return { status: 'exists' };
    }
    const packageDir = packageManifestsDirUri(workspaceRoot);
    const entryDir = entryEntitiesDirUri(workspaceRoot);
    const macroDir = macroEntitiesDirUri(workspaceRoot);
    const librariesDir = librariesDirUri(workspaceRoot);
    const unpackagedPath = packageManifestPath(UNPACKAGED_PACKAGE_ID);
    const unpackagedUri = snlRelativeUri(workspaceRoot, unpackagedPath);
    // Fail closed before the first repair write. Existing schema-owned data
    // without config.json may belong to another/legacy topology.
    for (const [directory, allowed] of [
      [entryDir, new Set<string>()],
      [macroDir, new Set<string>()],
      [packageDir, new Set([unpackagedPath.split('/').at(-1)!])]
    ] as const) {
      if (!(await exists(directory))) continue;
      for (const [name, type] of await fsApi.readDirectory(directory)) {
        if (type === vscode.FileType.File && name.toLowerCase().endsWith('.json') && !allowed.has(name)) {
          throw new Error(`Cannot initialize: config.json is missing but ${name} already exists.`);
        }
      }
    }
    const libraryItems = await exists(librariesDir)
      ? (await fsApi.readDirectory(librariesDir)).filter(([name]) => name !== '.gitkeep')
      : [];
    if (libraryItems.length > 0 || await exists(entriesUri(workspaceRoot)) || await exists(termMacrosDirUri(workspaceRoot))) {
      throw new Error('Cannot initialize over legacy or unrelated data without config.json.');
    }

    const unpackagedManifest = makePackageManifest(
      UNPACKAGED_PACKAGE_ID,
      'Unpackaged',
      'Entries without an assigned package.'
    );
    const exactJsonObject = (actual: unknown, expected: Record<string, unknown>): boolean => {
      if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
      const record = actual as Record<string, unknown>;
      const keys = Object.keys(record);
      return keys.length === Object.keys(expected).length &&
        Object.entries(expected).every(([key, value]) =>
          Object.hasOwn(record, key) && JSON.stringify(record[key]) === JSON.stringify(value)
        );
    };
    const unpackagedMatchesCurrent = async (): Promise<boolean> =>
      exactJsonObject(await readJson<unknown>(unpackagedUri), unpackagedManifest);
    const unpackagedExists = await exists(unpackagedUri);
    if (unpackagedExists) {
      const rawManifest = await readJson<unknown>(unpackagedUri);
      const {
        schema_version: _predecessorSchemaVersion,
        entry_ids: _predecessorEntryIds,
        ...predecessorManifest
      } = unpackagedManifest;
      if (exactJsonObject(rawManifest, predecessorManifest)) {
        assertCurrentEntityFile(unpackagedPath, unpackagedManifest);
        assertJsonSnapshotUnchanged(
          rawManifest,
          await readJson<unknown>(unpackagedUri),
          unpackagedUri.fsPath
        );
        await fsApi.writeFile(unpackagedUri, jsonBytes(unpackagedManifest));
      } else if (!exactJsonObject(rawManifest, unpackagedManifest)) {
        throw new Error('Cannot retry initialization: the existing _unpackaged manifest conflicts.');
      }
    }

    await fsApi.createDirectory(packageDir);
    await fsApi.createDirectory(entryDir);
    await fsApi.createDirectory(macroDir);
    await fsApi.createDirectory(librariesDir);

    if (!unpackagedExists) {
      const manifestTemporary = vscode.Uri.joinPath(
        packageDir,
        `.${UNPACKAGED_PACKAGE_ID}.init-${process.pid}-${Date.now()}.tmp`
      );
      try {
        await fsApi.writeFile(manifestTemporary, jsonBytes(unpackagedManifest));
        await fsApi.rename(manifestTemporary, unpackagedUri, { overwrite: false });
      } catch (error) {
        try {
          if (await exists(manifestTemporary)) {
            await fsApi.delete(manifestTemporary, { recursive: false, useTrash: false });
          }
        } catch { /* preserve the publish error */ }
        if (await exists(unpackagedUri) && await unpackagedMatchesCurrent()) {
          // An external initializer published the identical immutable manifest.
        } else {
          throw error;
        }
      }
    }

    const gitkeep = ENCODER.encode('');
    for (const directory of [entryDir, macroDir, librariesDir]) {
      const placeholder = vscode.Uri.joinPath(directory, '.gitkeep');
      if (!(await exists(placeholder))) await fsApi.writeFile(placeholder, gitkeep);
    }

    const config: SnlConfig = {
      version: CURRENT_DATA_VERSION,
      entry_kinds: [],
      macro_kinds: [],
      entity_storage: {
        version: 1,
        legacy_backup_version: '0.0.5',
        entry_default_package: UNPACKAGED_PACKAGE_ID,
        receipt: makeEntityStorageReceipt([], new Map(), false)
      }
    };
    const configTemporary = vscode.Uri.joinPath(root, `.config.init-${process.pid}-${Date.now()}.tmp`);
    try {
      await fsApi.writeFile(configTemporary, jsonBytes(config));
      await fsApi.rename(configTemporary, configTarget, { overwrite: false });
    } catch (error) {
      try {
        if (await exists(configTemporary)) {
          await fsApi.delete(configTemporary, { recursive: false, useTrash: false });
        }
      } catch {
        // Preserve the original initialization failure; retry residue is safe.
      }
      throw error;
    }
    return { status: 'created' };
  });
}

/**
 * Add a new library to an EXISTING `.SNL_Doc/`.
 *
 * Fails (without writing anything) when:
 *  - `.SNL_Doc/` does not exist (`noSnlDoc`);
 *  - a library directory with the same slug already exists (`duplicate`).
 *
 * On success creates:
 *
 *   libraries/<slug>/
 *     meta.json     { title }
 *     graph.json    { nodes: [], relationships: [] }
 *     documents/{Typst,LaTeX,Markdown}/
 *
 * Does NOT touch `config.json` — the on-disk `libraries/` tree is the
 * source of truth for what libraries exist (per cat 2026-07-06). Pasting a
 * `<slug>/meta.json` folder in from another workspace is enough to import.
 */
export async function createLibrary(
  workspaceRoot: vscode.Uri,
  title: string
): Promise<CreateLibraryResult> {
  const fsApi = vscode.workspace.fs;
  const trimmedTitle = (title ?? '').trim();
  const slug = slugify(trimmedTitle);

  return withExtensionWriterLock(workspaceRoot, `create Library ${slug}`, async () => {
    const root = snlRootUri(workspaceRoot);
    if (!(await exists(root))) {
      return { status: 'noSnlDoc' } as const;
    }
    await assertWorkspaceWritableOnDisk(workspaceRoot, true, true);
    await ensureOwnedLibraryRootForCreate(workspaceRoot);

    const libDir = libraryDirUri(workspaceRoot, slug);
    if (await exists(libDir)) {
      return { status: 'duplicate', slug } as const;
    }

    const stagingDir = vscode.Uri.joinPath(
      librariesDirUri(workspaceRoot),
      `.creating-${slug}-${randomUUID()}`
    );
    const documentsDir = vscode.Uri.joinPath(stagingDir, 'documents');
    const typstDir = vscode.Uri.joinPath(documentsDir, 'Typst');
    const latexDir = vscode.Uri.joinPath(documentsDir, 'LaTeX');
    const markdownDir = vscode.Uri.joinPath(documentsDir, 'Markdown');
    try {
      for (const directory of [stagingDir, documentsDir, typstDir, latexDir, markdownDir]) {
        await fsApi.createDirectory(directory);
      }
      await fsApi.writeFile(
        vscode.Uri.joinPath(stagingDir, 'meta.json'),
        jsonBytes({ title: trimmedTitle } satisfies LibraryMetaFile)
      );
      await fsApi.writeFile(
        vscode.Uri.joinPath(stagingDir, 'graph.json'),
        jsonBytes({ nodes: [], relationships: [] } satisfies LibraryGraphFile)
      );
      await fsApi.writeFile(
        vscode.Uri.joinPath(stagingDir, 'counters.json'),
        jsonBytes({ counters: [] } satisfies LibraryCountersFile)
      );
      const gitkeep = ENCODER.encode('');
      await fsApi.writeFile(vscode.Uri.joinPath(typstDir, '.gitkeep'), gitkeep);
      await fsApi.writeFile(vscode.Uri.joinPath(latexDir, '.gitkeep'), gitkeep);
      await fsApi.writeFile(vscode.Uri.joinPath(markdownDir, '.gitkeep'), gitkeep);
      await assertWorkspaceWritableOnDisk(workspaceRoot, true, true);
      await assertOwnedLibraryRoot(workspaceRoot);
      await assertRealDirectory(stagingDir, 'private Library staging directory');
      await fsApi.rename(stagingDir, libDir, { overwrite: false });
    } catch (error) {
      try {
        if (await exists(stagingDir)) {
          await assertOwnedLibraryRoot(workspaceRoot);
          await assertRealDirectory(stagingDir, 'private Library staging directory');
          await fsApi.delete(stagingDir, { recursive: true, useTrash: false });
        }
      } catch (rollbackError) {
        throw new Error(
          `Library creation failed and rollback also failed: ${String(error)}; rollback: ${String(rollbackError)}`
        );
      }
      throw error;
    }

    return { status: 'created', slug, title: trimmedTitle } as const;
  });
}

/**
 * Best-effort macro count inside a single term-macro package file.
 *
 * Handles both the canonical v6 shape and the older v5 shape (see
 * `readMacroPackage` for the on-read migration path):
 *  - v6: `{ version, name, description?, macros: { key: entry, ... } }`
 *        → `Object.keys(macros).length`
 *  - v5: `{ macros: [ ... ] }`                                → array length
 *  - Bare array of macros (legacy)                            → array length
 *  - Bare `{ uuid: macroDef }` object with no `macros` field  → own-key count
 *    minus known metadata keys (last-ditch fallback for hand-authored files
 *    predating the wrapped-object schema).
 * Anything else → `null` (Dashboard renders "—").
 */
function inferMacroCount(raw: unknown): number | null {
  if (Array.isArray(raw)) {
    return raw.length;
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const inner = obj.macros;
    // v6 canonical shape: macros is a keyed object.
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return Object.keys(inner).length;
    }
    // v5 legacy shape: macros is an array.
    if (Array.isArray(inner)) {
      return inner.length;
    }
    // Last-ditch fallback: top-level `{ uuid: macroDef }` — subtract known
    // metadata keys so a hand-authored file without a `macros` wrapper still
    // reports something sensible.
    const reservedKeys = new Set(['version', 'name', 'description', 'macros']);
    const keys = Object.keys(obj).filter((k) => !reservedKeys.has(k));
    return keys.length;
  }
  return null;
}

export interface MacroPackageSummary {
  /** File name, e.g. `mathlib_basic.json`. */
  file: string;
  /** Best-effort macro count, or `null` when schema is unrecognized. */
  macroCount: number | null;
  /**
   * Whether this package is currently in `config.json#active_macro_packages`
   * (only active packages contribute to `readAllMacros`). Populated by
   * `readOverview`; `readMacroPackages` leaves it undefined.
   */
  active?: boolean;
}

/**
 * Enumerate `.SNL_Doc/term_macros/*.json` and return one summary per file.
 * Hidden files (e.g. `.gitkeep`) and non-`.json` files are skipped.
 * Unreadable files yield a summary with `macroCount: null` instead of
 * propagating the error.
 */
export async function readMacroPackages(
  workspaceRoot: vscode.Uri,
  includeSystemPackages = false
): Promise<MacroPackageSummary[]> {
  if (await usesEntityStorage(workspaceRoot)) {
    try {
      const storage = entityReadStorage(workspaceRoot);
      const [packages, macros] = await Promise.all([
        readPackageManifestRecords(storage),
        readMacroEntityRecords(storage)
      ]);
      const counts = new Map<string, number>();
      for (const { envelope } of macros) {
        counts.set(envelope.package, (counts.get(envelope.package) ?? 0) + 1);
      }
      return packages
        .filter(({ manifest }) => includeSystemPackages || manifest.id !== UNPACKAGED_PACKAGE_ID)
        .map(({ manifest }) => ({
          file: `${manifest.id}.json`,
          macroCount: counts.get(manifest.id) ?? 0
        }))
        .sort((left, right) => left.file.localeCompare(right.file));
    } catch (error) {
      throw new Error(
        `Could not read per-entity Package storage: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const fsApi = vscode.workspace.fs;
  const dir = termMacrosDirUri(workspaceRoot);
  if (!(await exists(dir))) {
    return [];
  }

  let entries: [string, vscode.FileType][];
  try {
    entries = await fsApi.readDirectory(dir);
  } catch {
    return [];
  }

  const candidates = entries
    .filter(([name, type]) =>
      // Files only, json only, no dotfiles.
      type === vscode.FileType.File &&
      name.toLowerCase().endsWith('.json') &&
      !name.startsWith('.')
    )
    .map(([name]) => name);

  // Read concurrently: these are independent files, and the serial await in
  // a loop was pure latency on every panel open (this listing is the first
  // thing several panels do). Cat 2026-07-25: "各个 Panel 开起来都非常慢".
  const out: MacroPackageSummary[] = await Promise.all(
    candidates.map(async (name) => {
      const summary: MacroPackageSummary = { file: name, macroCount: null };
      try {
        summary.macroCount = inferMacroCount(
          await readJson<unknown>(vscode.Uri.joinPath(dir, name))
        );
      } catch {
        // Leave macroCount null.
      }
      return summary;
    })
  );
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

// ---------------------------------------------------------------------------
// Macro packages: canonical read/write ops
// ---------------------------------------------------------------------------

/**
 * Extended, on-disk macro shape — a superset of `@sjtu-ai4math/snl-basics`'s
 * render-only `SnlMacro` (0.4.0). It additionally carries the consumer-owned
 * output backends (typst / latex / markdown / text) that this extension writes
 * to disk. Renamed from `SnlMacro` to signal it is NOT the library type.
 *
 * We keep a local copy so the extension host (which cannot import the React/ESM
 * package cleanly in a CommonJS `out/` build) and the smoke test share one
 * canonical shape. The webviews import the real render type from
 * `@sjtu-ai4math/snl-basics` for previews and keep their own extended copy for saves.
 */
/** Historical v7–v10 direct-field style used only at migration boundaries. */
interface LegacyMacroPackageStyleBase {
  style_name: string;
  separator?: string;
  tags: string[];
  typst?: { built_in: string; synthesis: { mode: 'formula' | 'text'; macro: string } };
  latex?: { built_in: string; synthesis: { mode: 'formula' | 'text'; macro: string } };
  markdown?: string;
  text?: string;
}
interface LegacyInvariantMacroPackageStyle extends LegacyMacroPackageStyleBase {
  mode: 'formula_inline' | 'formula_display' | 'block';
  template: string;
  block_template_name?: string;
}
interface LegacyTextMacroPackageStyle extends LegacyMacroPackageStyleBase {
  mode: 'text';
  template: Localized<string, string>;
  block_template_name?: never;
}
type LegacyMacroPackageStyle =
  | LegacyInvariantMacroPackageStyle
  | LegacyTextMacroPackageStyle;

interface LegacyMacroPackageEntry {
  name: string;
  description: string;
  source: { entries: string[]; urls: string[] };
  kind: string;
  dynamic_arity: boolean;
  default_style?: Record<string, string>;
  styles: LegacyMacroPackageStyle[];
  tags: string[];
}

interface MacroTemplateBackends {
  typst?: { built_in: string; synthesis: { mode: 'formula' | 'text'; macro: string } };
  latex?: { built_in: string; synthesis: { mode: 'formula' | 'text'; macro: string } };
  markdown?: string;
  text?: string;
}
export type MacroPackageTemplate = ({
  mode: 'formula_inline' | 'formula_display' | 'text';
  body: string;
  separator?: string;
  block_template_name?: never;
} | {
  mode: 'block';
  body: string;
  separator?: string;
  block_template_name?: string;
}) & MacroTemplateBackends & Record<string, unknown>;

export interface MacroPackageStyle {
  style_name: string;
  tags: string[];
  template: Localized<string, MacroPackageTemplate>;
}

export interface MacroPackageEntry {
  name: string;
  description: string;
  source: { entries: string[]; urls: string[] };
  kind: string;
  dynamic_arity: boolean;
  styles: MacroPackageStyle[];
  tags: string[];
}

/** MacroPackageEntry without redundant `name` (the name is the package-map key). */
export type MacroPackageEntryWithoutName = Omit<MacroPackageEntry, 'name'>;

/** Full canonical shape of a macro package file. */
export interface MacroPackageFile {
  version: string;
  name: string;
  description?: string;
  /** key = macro.name */
  macros: Record<string, MacroPackageEntryWithoutName>;
}

/** Bare filename regex for a macro package (no path, no extension). */
const MACRO_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MACRO_PACKAGE_VERSION = '11';

/** URI of a package file given a bare-or-suffixed filename. */
function macroPackageUri(
  workspaceRoot: vscode.Uri,
  bareOrSuffixed: string
): vscode.Uri {
  const bare = stripJsonExt(bareOrSuffixed);
  return vscode.Uri.joinPath(termMacrosDirUri(workspaceRoot), `${bare}.json`);
}

/**
 * On-load migration for a single macro: normalize the legacy on-disk shape to
 * the 0.4.0 naming. Mutates a shallow copy and returns it. Idempotent.
 *  - `katex_react.mode === 'math'` → `'formula'`
 *  - `typst.synthesis.output_type` → `typst.synthesis.mode` (delete old key)
 *  - `latex.synthesis.output_type` → `latex.synthesis.mode` (delete old key)
 * Write-back on the next save uses the new shape; there is no forced disk
 * migration — old packages keep working, normalized in-memory on read.
 */
function migrateLegacyMacro(input: unknown): Record<string, unknown> {
  const macro = { ...(input as Record<string, unknown>) } as Record<string, unknown>;

  const kr = macro.katex_react as { mode?: unknown } | undefined;
  if (kr && kr.mode === 'math') {
    macro.katex_react = { ...kr, mode: 'formula' };
  }

  for (const field of ['typst', 'latex'] as const) {
    const backend = macro[field] as
      | { synthesis?: { output_type?: unknown; mode?: unknown } & Record<string, unknown> }
      | undefined;
    const synthesis = backend?.synthesis;
    if (synthesis && 'output_type' in synthesis && !('mode' in synthesis)) {
      const { output_type, ...rest } = synthesis;
      macro[field] = { ...backend, synthesis: { ...rest, mode: output_type } };
    }
  }

  return macro;
}

/** True when a macro is already in the 0.7.0 v5 shape (styles is an array). */
function isV5Macro(m: Record<string, unknown>): boolean {
  return Array.isArray(m.styles);
}

/** True when a macro is in the 0.6.0 v4 shape (styles is a keyed object). */
function isV4StylesMacro(m: Record<string, unknown>): boolean {
  return (
    typeof m.styles === 'object' &&
    m.styles !== null &&
    !Array.isArray(m.styles) &&
    !('katex_react' in m) &&
    typeof m.defaultStyle === 'string'
  );
}

/**
 * Split a dotted macro name into a base name + style tag. If the name has more
 * than one segment, the last segment is the style tag; otherwise the style is
 * `'default'`. e.g. `Add.add.infix` → `{ base: 'Add.add', style: 'infix' }`,
 * `pmatrix` → `{ base: 'pmatrix', style: 'default' }`.
 */
function splitBaseStyle(name: string): { base: string; style: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return { base: name, style: 'default' };
  }
  return { base: name.slice(0, dot), style: name.slice(dot + 1) };
}

/**
 * Build a per-style entry in **v5 shape** from a legacy (pre-v4) macro's
 * `katex_react` + backends. This function DELIBERATELY returns v5 (with
 * separate `mode: 'formula' | 'text' | 'block'` + optional `display`) — the
 * final v5→v6 collapse happens in {@link v5MacroToV6} after grouping. Using
 * v5 here lets the v4→v5 grouping logic stay unchanged.
 */
function legacyMacroToStyle(
  macro: Record<string, unknown>,
  tag: string,
  mode: 'formula' | 'text' | 'block',
  display: 'inline' | 'block' | undefined
): Record<string, unknown> {
  const kr = (macro.katex_react ?? {}) as Record<string, unknown>;
  const style: Record<string, unknown> = {
    tag,
    mode,
    template: typeof kr.template === 'string' ? kr.template : ''
  };
  if (mode === 'formula' && display) {
    style.display = display;
  }
  if (kr.variadic_join !== undefined) {
    style.variadic_join = kr.variadic_join as string;
  }
  if (kr.react_renderer_key !== undefined) {
    style.react_renderer_key = kr.react_renderer_key as string;
  }
  if (macro.typst !== undefined) {
    style.typst = macro.typst;
  }
  if (macro.latex !== undefined) {
    style.latex = macro.latex;
  }
  if (macro.markdown !== undefined) {
    style.markdown = macro.markdown as string;
  }
  if (macro.text !== undefined) {
    style.text = macro.text as string;
  }
  return style;
}

/**
 * Migrate a v4 macro (styles keyed object + top-level mode/display/defaultStyle)
 * to a v5-shape intermediate (styles array with per-style mode/display,
 * `arity` still on the macro). The final v5→v6 collapse happens in
 * {@link v5MacroToV6} after grouping.
 */
function v4MacroToV5(macro: Record<string, unknown>): Record<string, unknown> {
  const {
    mode: macroMode = 'formula',
    display: macroDisplay,
    defaultStyle,
    styles: stylesMap = {},
    ...rest
  } = macro as {
    mode?: 'formula' | 'text' | 'block';
    display?: 'inline' | 'block';
    defaultStyle?: string;
    styles?: Record<string, Record<string, unknown>>;
  } & Record<string, unknown>;

  const map = (stylesMap as Record<string, Record<string, unknown>>) ?? {};
  const tags = Object.keys(map);
  const orderedTags: string[] = [];
  if (defaultStyle && tags.includes(defaultStyle)) {
    orderedTags.push(defaultStyle);
  }
  for (const t of tags) {
    if (!orderedTags.includes(t)) {
      orderedTags.push(t);
    }
  }

  const styles: Array<Record<string, unknown>> = orderedTags.map((tag) => {
    const raw = map[tag] ?? {};
    const s: Record<string, unknown> = {
      tag,
      mode: macroMode ?? 'formula',
      template: typeof raw.template === 'string' ? (raw.template as string) : ''
    };
    if (s.mode === 'formula' && macroDisplay) {
      s.display = macroDisplay;
    }
    if (raw.variadic_join !== undefined) {
      s.variadic_join = raw.variadic_join as string;
    }
    if (raw.react_renderer_key !== undefined) {
      s.react_renderer_key = raw.react_renderer_key as string;
    }
    if (raw.typst !== undefined) {
      s.typst = raw.typst;
    }
    if (raw.latex !== undefined) {
      s.latex = raw.latex;
    }
    if (raw.markdown !== undefined) {
      s.markdown = raw.markdown as string;
    }
    if (raw.text !== undefined) {
      s.text = raw.text as string;
    }
    return s;
  });

  return { ...rest, styles };
}

/** v5 → v6 intermediate migration. */
function v5MacroToV6(entry: Record<string, unknown>): Record<string, unknown> {
  const out = { ...entry };
  if (typeof out.dynamic_arity !== 'boolean') {
    out.dynamic_arity = (out.arity as string | undefined) === 'variadic';
    delete out.arity;
  }
  if (Array.isArray(out.styles)) {
    out.styles = out.styles.map((value) => {
      const style = { ...(value as Record<string, unknown>) };
      const legacyMode = style.mode as string | undefined;
      const legacyDisplay = style.display as string | undefined;
      if (legacyMode === 'formula' || legacyMode === undefined) {
        style.mode = legacyDisplay === 'block' ? 'formula_display' : 'formula_inline';
      } else if (
        legacyMode !== 'formula_inline' && legacyMode !== 'formula_display' &&
        legacyMode !== 'text' && legacyMode !== 'block'
      ) {
        style.mode = 'formula_inline';
      }
      delete style.display;
      return style;
    });
  }
  return out;
}

/** v7/v8 → v9: preserve localized text templates and remove language-selected styles safely. */
function v7MacroToV9(input: Record<string, unknown>): LegacyMacroPackageEntry {
  const rawStyles = Array.isArray(input.styles)
    ? input.styles.map((style) => ({ ...(style as Record<string, unknown>) }))
    : [];
  const styles: LegacyMacroPackageStyle[] = [];

  rawStyles.forEach((style, styleIndex) => {
    const styleName = typeof style.style_name === 'string' ? style.style_name : `style${styleIndex}`;
    const mode = style.mode as 'formula_inline' | 'formula_display' | 'text' | 'block';
    styles.push({
      ...style,
      style_name: styleName,
      template: mode === 'text' && is_valid_macro_i18n_string(style.template)
        ? style.template
        : normalize_macro_template(mode, style.template)
    } as LegacyMacroPackageStyle);
  });

  const source = input.source && typeof input.source === 'object' && !Array.isArray(input.source)
    ? input.source as Record<string, unknown>
    : {};
  const { default_style: legacyDefaultStyle, ...current } = input;
  const normalized = {
    ...current,
    name: typeof input.name === 'string' ? input.name : '',
    description: typeof input.description === 'string' ? input.description : '',
    source: {
      ...source,
      entries: Array.isArray(source.entries) ? source.entries as string[] : [],
      urls: Array.isArray(source.urls) ? source.urls as string[] : []
    },
    dynamic_arity: input.dynamic_arity === true,
    styles,
    tags: Array.isArray(input.tags) && input.tags.every((tag) => typeof tag === 'string')
      ? input.tags as string[] : []
  } as LegacyMacroPackageEntry;
  if (legacyDefaultStyle === undefined) return normalized;
  return {
    ...normalized,
    default_style: legacyDefaultStyle as Record<string, string>
  };
}

/** v9 → v10: materialize canonical kind while preserving custom kind ids. */
function v9MacroToV10(input: LegacyMacroPackageEntry): LegacyMacroPackageEntry {
  return {
    ...input,
    kind: input.kind === 'partial'
      ? 'sub'
      : typeof input.kind === 'string' && input.kind.length > 0
        ? input.kind
        : 'const'
  };
}

/** v10 → v11: move every render/backend field into one atomically localized TemplateSpec. */
function legacyStyleExtensions(style: LegacyMacroPackageStyle): Record<string, unknown> {
  const {
    style_name: _styleName,
    tags: _tags,
    mode: _mode,
    template: _template,
    separator: _separator,
    block_template_name: _blockTemplateName,
    typst: _typst,
    latex: _latex,
    markdown: _markdown,
    text: _text,
    ...extensions
  } = style as LegacyMacroPackageStyle & Record<string, unknown>;
  for (const reserved of ['body', 'type']) {
    if (Object.hasOwn(extensions, reserved)) {
      throw new Error(`legacy Style extension ${JSON.stringify(reserved)} collides with TemplateSpec`);
    }
  }
  return extensions;
}

function legacyStyleProjection(
  style: LegacyMacroPackageStyle,
  language: string
): MacroPackageTemplate {
  const body = typeof style.template === 'string'
    ? style.template
    : (() => {
        const values = style.template.values;
        return values[language] ?? values[style.template.default_language] ?? '';
      })();
  const projection: MacroPackageTemplate = {
    ...legacyStyleExtensions(style),
    mode: style.mode,
    body,
    ...(typeof style.separator === 'string' ? { separator: style.separator } : {}),
    ...(style.mode === 'block' && typeof style.block_template_name === 'string'
      ? { block_template_name: style.block_template_name }
      : {}),
    ...(style.typst !== undefined ? { typst: style.typst } : {}),
    ...(style.latex !== undefined ? { latex: style.latex } : {}),
    ...(style.markdown !== undefined ? { markdown: style.markdown } : {}),
    ...(style.text !== undefined ? { text: style.text } : {})
  } as MacroPackageTemplate;
  return projection;
}

function legacyStyleToV11(style: LegacyMacroPackageStyle): MacroPackageStyle {
  const { style_name, tags, template: legacyTemplate } = style;
  const template: Localized<string, MacroPackageTemplate> = typeof legacyTemplate === 'string'
    ? legacyStyleProjection(style, 'en')
    : {
        ...legacyTemplate,
        values: Object.fromEntries(Object.keys(legacyTemplate.values).map((language) => [
          language,
          legacyStyleProjection(style, language)
        ]))
      };
  return { style_name, tags, template };
}

function uniqueLocalizedDefaultName(styles: readonly LegacyMacroPackageStyle[]): string {
  const names = new Set(styles.map((style) => style.style_name));
  let candidate = 'localized-default';
  let suffix = 2;
  while (names.has(candidate)) candidate = `localized-default-${suffix++}`;
  return candidate;
}

function v10MacroToV11(input: LegacyMacroPackageEntry): MacroPackageEntry {
  const originalStyles = input.styles;
  const migratedStyles = originalStyles.map(legacyStyleToV11);
  const defaultMap = input.default_style;
  let styles = migratedStyles;
  if (defaultMap && Object.keys(defaultMap).length > 0) {
    const byName = new Map(originalStyles.map((style) => [style.style_name, style] as const));
    const first = originalStyles[0];
    if (!first) throw new Error(`macro "${input.name}" has no styles`);
    const selected = Object.entries(defaultMap).map(([language, styleName]) => {
      const style = byName.get(styleName);
      if (!style) {
        throw new Error(`macro "${input.name}" default_style.${language} references missing style "${styleName}"`);
      }
      return [language, style] as const;
    });
    const allFirst = selected.every(([, style]) => style.style_name === first.style_name);
    if (!allFirst) {
      const defaultLanguage = Object.hasOwn(defaultMap, 'en') ? 'en' : 'en';
      const fallback = byName.get(defaultMap.en ?? '') ?? first;
      const projectionStyles = [fallback, ...selected.map(([, style]) => style)];
      const invariantTags = projectionStyles[0].tags;
      if (!projectionStyles.every((style) =>
        JSON.stringify(style.tags) === JSON.stringify(invariantTags))) {
        throw new Error(`macro "${input.name}" has a legacy default_style map whose selected Style tags cannot be localized`);
      }
      const values = Object.fromEntries([
        ['en', legacyStyleProjection(fallback, 'en')],
        ...selected.map(([language, style]) => [
          language, legacyStyleProjection(style, language)
        ] as const)
      ]) as Record<string, MacroPackageTemplate>;
      styles = [{
        style_name: uniqueLocalizedDefaultName(originalStyles),
        tags: [...invariantTags],
        template: { type: 'i18n', default_language: defaultLanguage, values }
      }, ...migratedStyles];
    }
  }
  const { default_style: _defaultStyle, ...current } = input;
  return { ...current, styles };
}

/**
 * Explicit Macro v6 → v7 input migration. Legacy names are confined to this
 * boundary; callers may then apply the explicit v7 → v8 migration.
 * Unknown extension fields and consumer-owned output backends survive the shallow copies.
 */
function v6MacroToV7(input: Record<string, unknown>): Record<string, unknown> {
  const rawStyles = Array.isArray(input.styles) ? input.styles : [];
  const styles = rawStyles.map((value, index): LegacyMacroPackageStyle => {
    const raw = { ...(value as Record<string, unknown>) };
    const legacyTag = raw.tag;
    const legacyLeft = raw.variadic_left;
    const legacyJoin = raw.variadic_join;
    const legacyRight = raw.variadic_right;
    const legacyRenderer = raw.react_renderer_key;
    const hasLegacyDynamic =
      'variadic_left' in raw || 'variadic_join' in raw || 'variadic_right' in raw;
    delete raw.tag;
    delete raw.variadic_left;
    delete raw.variadic_join;
    delete raw.variadic_right;
    delete raw.react_renderer_key;

    const mode =
      raw.mode === 'formula_inline' || raw.mode === 'formula_display' ||
      raw.mode === 'text' || raw.mode === 'block'
        ? raw.mode
        : 'formula_inline';
    const styleBase = {
      ...raw,
      style_name:
        typeof raw.style_name === 'string'
          ? raw.style_name
          : typeof legacyTag === 'string' ? legacyTag : `style${index}`,
      tags: Array.isArray(raw.tags) && raw.tags.every((tag) => typeof tag === 'string')
        ? raw.tags as string[]
        : []
    };
    const dynamicTemplate = hasLegacyDynamic
      ? `${typeof legacyLeft === 'string' ? legacyLeft : ''}#*${typeof legacyRight === 'string' ? legacyRight : ''}`
      : undefined;
    const style: LegacyMacroPackageStyle = mode === 'text'
      ? {
          ...styleBase,
          mode,
          template: dynamicTemplate ?? (
            is_valid_macro_i18n_string(raw.template)
              ? raw.template
              : normalize_macro_template('text', raw.template)
          )
        } as unknown as LegacyMacroPackageStyle
      : {
          ...styleBase,
          mode,
          template: dynamicTemplate ?? normalize_macro_template(
            mode as 'formula_inline' | 'formula_display' | 'block',
            raw.template
          )
        };
    if (hasLegacyDynamic && typeof legacyJoin === 'string') {
      style.separator = legacyJoin;
    }
    const blockTemplateName =
      typeof raw.block_template_name === 'string'
        ? raw.block_template_name
        : typeof legacyRenderer === 'string' ? legacyRenderer : undefined;
    if (mode === 'block' && blockTemplateName) {
      style.block_template_name = blockTemplateName;
    } else if (mode !== 'block') {
      delete style.block_template_name;
    }
    return style;
  });

  return {
    ...input,
    name: typeof input.name === 'string' ? input.name : '',
    description: typeof input.description === 'string' ? input.description : '',
    source: {
      ...(input.source && typeof input.source === 'object' && !Array.isArray(input.source)
        ? input.source as Record<string, unknown>
        : {}),
      entries: Array.isArray((input.source as { entries?: unknown } | undefined)?.entries)
        ? (input.source as { entries: string[] }).entries
        : [],
      urls: Array.isArray((input.source as { urls?: unknown } | undefined)?.urls)
        ? (input.source as { urls: string[] }).urls
        : []
    },
    dynamic_arity: input.dynamic_arity === true,
    styles,
    tags: Array.isArray(input.tags) && input.tags.every((tag) => typeof tag === 'string')
      ? input.tags as string[]
      : []
  };
}

/**
 * Group a flat list of named macros into the v5 styles-array shape. Handles
 * three input flavours in one pass:
 *   - v5-shape macros (styles is an array): pass through untouched;
 *   - v4-shape macros (styles is a keyed object + defaultStyle): converted
 *     via {@link v4MacroToV5};
 *   - legacy macros (with `katex_react` and dotted name → style tag): grouped
 *     by base name (last dotted segment becomes the style tag), with mode/
 *     display lifted from the first legacy sibling of that base.
 * Best-effort: if any legacy macro can't be grouped cleanly, a warning is
 * logged and original entries are returned as-is.
 */
/**
 * Group a flat list of named macros into a v6-shape `MacroPackageEntry[]`.
 * Legacy shapes are first grouped as v5-shape intermediates
 * (Record<string, unknown> with `arity` + `mode` + `display`), then the whole
 * batch is passed through {@link v5MacroToV6} to collapse to v6.
 *
 * Three input flavours handled in one pass:
 *   - v5 or v6 macros (styles is an array): pass through — v5MacroToV6 is
 *     idempotent on v6-shape input.
 *   - v4 macros (styles is a keyed object + defaultStyle): converted via
 *     {@link v4MacroToV5}.
 *   - legacy macros (with `katex_react` and dotted name → style tag):
 *     grouped by base name (last dotted segment becomes the style tag).
 * Best-effort: if any legacy macro can't be grouped cleanly, a warning is
 * logged and original entries are returned as-is.
 */
function groupMacrosToStyles(
  collected: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  try {
    // Intermediate map holds v5-shape records (or already-v6 pass-throughs).
    // We only cast to MacroPackageEntry at the end, after v5MacroToV6.
    const groups = new Map<string, Record<string, unknown>>();
    const order: string[] = [];
    for (const raw of collected) {
      if (isV5Macro(raw)) {
        const name = (raw.name as string) ?? '';
        if (!groups.has(name)) {
          order.push(name);
        }
        groups.set(name, raw);
        continue;
      }
      if (isV4StylesMacro(raw)) {
        const converted = v4MacroToV5(raw);
        const name = (converted.name as string) ?? '';
        if (!groups.has(name)) {
          order.push(name);
        }
        groups.set(name, converted);
        continue;
      }
      const kr = raw.katex_react as Record<string, unknown> | undefined;
      if (!kr) {
        throw new Error(
          `macro "${String(raw.name)}" has neither v5 styles array, v4 styles map, nor legacy katex_react`
        );
      }
      const { base, style } = splitBaseStyle((raw.name as string) ?? '');
      let entry = groups.get(base);
      const legacyMode = (kr.mode as 'formula' | 'text' | 'block' | undefined) ?? 'formula';
      const legacyDisplay = kr.display as 'inline' | 'block' | undefined;
      if (!entry) {
        entry = {
          name: base,
          description: (raw.description as string) ?? '',
          source: raw.source ?? { entries: [], urls: [] },
          arity: (kr.arity as string) ?? 'fixed',
          styles: []
        };
        if (kr.kind !== undefined) {
          entry.kind = kr.kind;
        }
        groups.set(base, entry);
        order.push(base);
      }
      (entry.styles as Array<Record<string, unknown>>).push(
        legacyMacroToStyle(raw, style, legacyMode, legacyDisplay)
      );
    }
    // Finish both explicit boundaries before exposing runtime values.
    return order.map((n) => {
      const g = groups.get(n) as Record<string, unknown>;
      return v6MacroToV7(v5MacroToV6(g));
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[snlDoc] normalizeMacros: could not migrate legacy macros to the ` +
        `canonical styles array (${reason}); normalizing entries independently`
    );
    return collected.map((entry) => v6MacroToV7(v5MacroToV6(entry)));
  }
}

/**
 * Normalize any of the legacy on-disk shapes to a canonical
 * `MacroPackageEntry[]` (0.6.0 styles shape):
 *  - bare array of macros                        → as-is
 *  - `{ macros: [ ... ] }` (array)               → macros
 *  - `{ macros: { name: macroWithoutName } }`    → canonical keyed map
 *  - top-level `{ name: macroDef }` (legacy)     → keyed map minus meta keys
 * Each element is passed through {@link migrateLegacyMacro} (0.4.0 field
 * renames) then grouped into the styles shape by {@link groupMacrosToStyles}.
 */
function normalizeMacrosV7(raw: unknown): Array<Record<string, unknown>> {
  const collected: Array<Record<string, unknown>> = [];
  const pushKeyed = (map: Record<string, unknown>): void => {
    for (const [key, val] of Object.entries(map)) {
      if (val && typeof val === 'object') {
        const macro = migrateLegacyMacro(val);
        collected.push({ ...macro, name: macro.name ?? key });
      }
    }
  };

  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (m && typeof m === 'object' && typeof (m as { name?: unknown }).name === 'string') {
        collected.push(migrateLegacyMacro(m));
      }
    }
    return groupMacrosToStyles(collected);
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.macros)) {
      for (const m of obj.macros) {
        if (
          m &&
          typeof m === 'object' &&
          typeof (m as { name?: unknown }).name === 'string'
        ) {
          collected.push(migrateLegacyMacro(m));
        }
      }
      return groupMacrosToStyles(collected);
    }
    if (obj.macros && typeof obj.macros === 'object') {
      pushKeyed(obj.macros as Record<string, unknown>);
      return groupMacrosToStyles(collected);
    }
    // Legacy top-level keyed shape — skip reserved metadata keys.
    const reserved = new Set(['version', 'name', 'description']);
    const trimmed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!reserved.has(k)) {
        setOwnRecordValue(trimmed, k, v);
      }
    }
    pushKeyed(trimmed);
    return groupMacrosToStyles(collected);
  }
  return [];
}

function normalizeLegacyMacros(
  raw: unknown,
  targetVersion: '9' | '10'
): LegacyMacroPackageEntry[] {
  const v9 = normalizeMacrosV7(raw).map((macro) => v7MacroToV9(macro));
  return targetVersion === '10' ? v9.map(v9MacroToV10) : v9;
}

function normalizeCurrentMacros(raw: unknown): MacroPackageEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Macro v11 package must be an object.');
  }
  const macros = (raw as Record<string, unknown>).macros;
  if (!macros || typeof macros !== 'object' || Array.isArray(macros)) {
    throw new Error('Macro v11 package must contain a keyed macros object.');
  }
  return Object.entries(macros as Record<string, unknown>).map(([name, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`macro ${JSON.stringify(name)} must be an object`);
    }
    const macro = { ...(value as Record<string, unknown>), name } as MacroPackageEntry;
    const error = validateMacro(macro);
    if (error) throw new Error(error);
    return macro;
  });
}

const SUPPORTED_MACRO_PACKAGE_VERSIONS = new Set([
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'
]);

function assertSupportedMacroPackageVersion(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const version = (raw as Record<string, unknown>).version;
  if (version !== undefined &&
      (typeof version !== 'string' || !SUPPORTED_MACRO_PACKAGE_VERSIONS.has(version))) {
    throw new Error(`Unsupported Macro package version ${JSON.stringify(version)}.`);
  }
}

function normalizeMacros(raw: unknown): MacroPackageEntry[] {
  assertSupportedMacroPackageVersion(raw);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const version = (raw as Record<string, unknown>).version;
    if (version === '11') return normalizeCurrentMacros(raw);
  }
  return normalizeLegacyMacros(raw, '10').map(v10MacroToV11);
}

/**
 * Create an EMPTY macro package. Fails when the file already exists.
 *
 * `file` is the bare filename (no path, no `.json`), e.g. "mathlib_basic";
 * `.json` is appended automatically. The written shape is always canonical
 * (see {@link MacroPackageFile}).
 */
export async function createMacroPackage(
  workspaceRoot: vscode.Uri,
  file: string,
  displayName: string,
  description?: string
): Promise<
  | { status: 'ok'; file: string }
  | { status: 'noSnlDoc' }
  | { status: 'duplicate'; file: string }
  | { status: 'invalid'; reason: string }
  | { status: 'error'; message: string }
> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  return withExtensionWriterLock(workspaceRoot, 'create Macro package', async () => {
    const bare = typeof file === 'string' ? file.trim() : '';
  if (!MACRO_FILE_RE.test(bare)) {
    return {
      status: 'invalid',
      reason: 'file must be a Windows-safe Package ID ([A-Za-z0-9][A-Za-z0-9._-]*)'
    };
  }
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (!name) {
    return { status: 'invalid', reason: 'displayName is required' };
  }

  const entityMode = await usesEntityStorage(workspaceRoot);
  let legacyActive: string[] = [];
  let legacyConfigRaw: unknown;
  if (!entityMode) {
    try {
      const [onDisk, configRaw] = await Promise.all([
        listMacroPackageNames(workspaceRoot, false),
        readJson<unknown>(configUri(workspaceRoot))
      ]);
      legacyConfigRaw = configRaw;
      legacyActive = resolveActiveFromConfig(onDisk, normalizeConfig(configRaw));
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }
  if (entityMode) {
    try {
      const manifests = await readPackageManifestRecords(entityReadStorage(workspaceRoot));
      const collision = manifests.find(({ manifest }) =>
        manifest.id.toLowerCase() === bare.toLowerCase()
      );
      if (collision) return { status: 'duplicate', file: `${collision.manifest.id}.json` };
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }
  let manifestPath: string;
  try {
    manifestPath = packageManifestPath(bare);
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
  const target = entityMode
    ? snlRelativeUri(workspaceRoot, manifestPath)
    : macroPackageUri(workspaceRoot, bare);
  if (await exists(target)) {
    return { status: 'duplicate', file: `${bare}.json` };
  }

  const pkg: MacroPackageFile = {
    version: MACRO_PACKAGE_VERSION,
    name,
    macros: {}
  };
  const desc = typeof description === 'string' ? description.trim() : '';
  if (desc) {
    pkg.description = desc;
  }

  try {
    await assertWorkspaceWritableOnDisk(workspaceRoot);
    if (entityMode) {
      const configRaw = await readJson<unknown>(configUri(workspaceRoot));
      if (!configRaw || typeof configRaw !== 'object' || Array.isArray(configRaw)) {
        throw new Error('config.json must be an object');
      }
      const manifests = await readPackageManifestRecords(entityReadStorage(workspaceRoot));
      const active = new Set(resolveActiveFromConfig(
        manifests
          .map(({ manifest }) => manifest.id)
          .filter((id) => id !== UNPACKAGED_PACKAGE_ID),
        normalizeConfig(configRaw)
      ));
      active.add(bare);
      const nextConfig = {
        ...configRaw,
        active_macro_packages: [...active].sort((left, right) => left.localeCompare(right))
      };
      await applyJsonFileOperations(workspaceRoot, `create Package ${bare}`, [
        {
          kind: 'write',
          uri: target,
          value: makePackageManifest(bare, name, desc),
          expected: null
        },
        {
          kind: 'write',
          uri: configUri(workspaceRoot),
          value: nextConfig,
          expected: configRaw
        }
      ]);
      return { status: 'ok', file: `${bare}.json` } as const;
    } else {
      if (!legacyConfigRaw || typeof legacyConfigRaw !== 'object' || Array.isArray(legacyConfigRaw)) {
        throw new Error('config.json must be an object');
      }
      const active = new Set(legacyActive);
      active.add(bare);
      const nextConfig = {
        ...(legacyConfigRaw as Record<string, unknown>),
        active_macro_packages: [...active].sort((left, right) => left.localeCompare(right))
      };
      await applyJsonFileOperations(workspaceRoot, `create Package ${bare}`, [
        { kind: 'write', uri: target, value: pkg, expected: null },
        {
          kind: 'write',
          uri: configUri(workspaceRoot),
          value: nextConfig,
          expected: legacyConfigRaw
        }
      ]);
      return { status: 'ok', file: `${bare}.json` } as const;
    }
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
    return { status: 'ok', file: `${bare}.json` };
  });
}

/** Create the shared Package manifest from the Entry Package workflow. */
export async function createEntryPackage(
  workspaceRoot: vscode.Uri,
  packageId: string,
  displayName: string,
  description?: string
): ReturnType<typeof createMacroPackage> {
  return createMacroPackage(workspaceRoot, packageId, displayName, description);
}

/** Point-read whether one shared Package manifest exists. */
export async function entryPackageExists(
  workspaceRoot: vscode.Uri,
  packageId: string
): Promise<boolean> {
  if (packageId === UNPACKAGED_PACKAGE_ID) return true;
  if (!(await usesEntityStorage(workspaceRoot))) {
    return (await readMacroPackage(workspaceRoot, packageId)).status === 'ok';
  }
  return (await readPackageManifestRecord(entityReadStorage(workspaceRoot), packageId)) !== null;
}

/**
 * Point-read an Entry under its expected Package owner. This is used at
 * package-bound UI command boundaries so crafted messages cannot target an
 * Entry displayed by a different Package panel.
 */
export async function entryBelongsToPackage(
  workspaceRoot: vscode.Uri,
  packageId: string,
  entryId: string
): Promise<boolean> {
  if (!(await usesEntityStorage(workspaceRoot))) {
    const entry = (await readEntries(workspaceRoot, false)).find(({ id }) => id === entryId);
    return Boolean(entry && (entry.package ?? UNPACKAGED_PACKAGE_ID) === packageId);
  }
  return (await readEntryEntityRecordWithOwner(
    entityReadStorage(workspaceRoot), packageId, entryId
  )) !== null;
}

/**
 * Read a macro package file, normalizing any legacy shape to a canonical
 * `MacroPackageEntry[]`. Missing file → `noFile`. Corrupt JSON → `error`.
 *
 * `file` may be a bare filename or carry the `.json` suffix.
 */
export async function readMacroPackage(
  workspaceRoot: vscode.Uri,
  file: string
): Promise<
  | { status: 'ok'; pkg: MacroPackageFile; macros: MacroPackageEntry[]; raw: unknown }
  | { status: 'noFile' }
  | { status: 'error'; message: string }
> {
  const bare = typeof file === 'string' ? stripJsonExt(file) : '';
  if (await usesEntityStorage(workspaceRoot)) {
    try {
      const storage = entityReadStorage(workspaceRoot);
      const [packages, macroRecords] = await Promise.all([
        readPackageManifestRecords(storage),
        readMacroEntityRecords(storage)
      ]);
      const packageRecord = packages.find(({ manifest }) => manifest.id === bare);
      if (!packageRecord) return { status: 'noFile' };
      const {
        format: _format,
        version: _version,
        schema_version: _schemaVersion,
        id: _id,
        name,
        description,
        ...extensions
      } = packageRecord.manifest;
      const macros: Record<string, unknown> = {};
      for (const record of macroRecords.filter(({ envelope }) => envelope.package === bare)) {
        const { name: macroName, ...macro } = record.macro;
        setOwnRecordValue(macros, macroName, macro);
      }
      const raw: Record<string, unknown> = {
        ...extensions,
        version: MACRO_PACKAGE_VERSION,
        name,
        macros
      };
      if (description) raw.description = description;
      const result = buildMacroPackageResult(bare, raw);
      return result.status === 'ok' ? { ...result, raw } : result;
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }
  const target = macroPackageUri(workspaceRoot, bare);
  if (!(await exists(target))) {
    return { status: 'noFile' };
  }

  let raw: unknown;
  try {
    raw = await readJson<unknown>(target);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }

  const result = buildMacroPackageResult(bare, raw);
  return result.status === 'ok' ? { ...result, raw } : result;
}

/**
 * Pure tail of {@link readMacroPackage}: turn already-read raw JSON into the
 * normalized `{pkg, macros}` result. Split out so callers that need BOTH the
 * raw-shaped `macroCount` and the normalized macro rows (the Dashboard) can
 * read each package file exactly once instead of twice.
 */
function buildMacroPackageResult(
  bare: string,
  raw: unknown,
  targetVersion: '11' = MACRO_PACKAGE_VERSION
):
  | { status: 'ok'; pkg: MacroPackageFile; macros: MacroPackageEntry[] }
  | { status: 'error'; message: string } {
  let macros: MacroPackageEntry[];
  try {
    macros = normalizeMacros(raw);
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error)
    };
  }

  // Recover the package metadata (name/description/version) best-effort.
  let pkgName = bare;
  let pkgDescription: string | undefined;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.name === 'string' && obj.name.trim()) {
      pkgName = obj.name;
    }

    if (typeof obj.description === 'string' && obj.description.trim()) {
      pkgDescription = obj.description;
    }
  }

  const macroEntries: Array<[string, MacroPackageEntryWithoutName]> = [];
  for (const m of macros) {
    const { name, ...rest } = m;
    macroEntries.push([name, rest]);
  }
  const macrosMap = Object.fromEntries(macroEntries);

  const wrapperExtensions = Object.create(null) as Record<string, unknown>;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) &&
      'macros' in (raw as Record<string, unknown>)) {
    const {
      version: _version,
      name: _name,
      description: _description,
      macros: _macros,
      ...extensions
    } = raw as Record<string, unknown>;
    Object.assign(wrapperExtensions, extensions);
  }
  const pkg: MacroPackageFile = {
    ...wrapperExtensions,
    version: targetVersion,
    name: pkgName,
    macros: macrosMap
  };
  if (pkgDescription) {
    pkg.description = pkgDescription;
  }

  return { status: 'ok', pkg, macros };
}

export interface PackageMacroSnapshot {
  readonly selected:
    | { readonly status: 'ok'; readonly pkg: MacroPackageFile; readonly macros: readonly MacroPackageEntry[] }
    | { readonly status: 'noFile' }
    | { readonly status: 'error'; readonly message: string };
  readonly workspaceMacros: Readonly<Record<string, MacroPackageEntry>>;
  readonly macroOrigins: Readonly<Record<string, string>>;
  readonly activePackages: readonly {
    readonly file: string;
    readonly name: string;
    readonly macros: readonly MacroPackageEntry[];
  }[];
  readonly macroKinds: readonly MacroKind[];
  readonly active: readonly string[];
  readonly otherPackages: readonly { readonly file: string; readonly name: string }[];
}

/** PackagePanel consumes the same generalized Package/Macro snapshot. */
export type PackagePanelSnapshot = PackageMacroSnapshot;

const PACKAGE_SNAPSHOT_READ_CONCURRENCY = 8;

async function mapPackageSnapshotReads<T, U>(
  values: readonly T[],
  read: (value: T) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await read(values[index]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(PACKAGE_SNAPSHOT_READ_CONCURRENCY, values.length) },
      () => worker()
    )
  );
  return results;
}

/**
 * Capture all Package/Macro state needed by one PackagePanel refresh.
 *
 * The snapshot is operation-local: current entity directories are listed once
 * and every manifest/Macro entity is read once; legacy package files are
 * likewise listed and read once. All derived products are folded only after
 * those bounded reads settle, preserving file-name collision ordering.
 */
export async function readPackageMacroSnapshot(
  workspaceRoot: vscode.Uri,
  selectedFile = ''
): Promise<PackageMacroSnapshot> {
  const selectedBare = stripJsonExt(selectedFile);
  let configRaw: unknown;
  try {
    configRaw = await readJson<unknown>(configUri(workspaceRoot));
  } catch (error) {
    throw new Error(`Could not read config.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entityMode = entityStorageModeFromConfig(configRaw);
  const config = normalizeConfig(configRaw);
  const rawByPackage = new Map<string, unknown>();
  let packageNames: string[];

  if (entityMode) {
    try {
      // Keep the two bounded directory walks sequential so their worker pools
      // cannot multiply into a wider fan-out at this call site.
      const storage = entityReadStorage(workspaceRoot);
      const packageRecords = await readPackageManifestRecords(storage);
      const macroRecords = await readMacroEntityRecords(storage);
      const packageIds = new Set(packageRecords.map(({ manifest }) => manifest.id));
      if (Array.isArray(config.active_macro_packages)) {
        for (const packageId of config.active_macro_packages) {
          if (!packageIds.has(packageId)) {
            throw new Error(`Active Macro Package ${JSON.stringify(packageId)} has no Package manifest.`);
          }
        }
      }
      for (const { envelope } of macroRecords) {
        if (!packageIds.has(envelope.package)) {
          throw new Error(`Macro entity references missing Package ${envelope.package}.`);
        }
      }
      packageNames = packageRecords
        .map(({ manifest }) => manifest.id)
        .filter((id) => id !== UNPACKAGED_PACKAGE_ID)
        .sort((left, right) => left.localeCompare(right));
      const macrosByPackage = new Map<string, Record<string, unknown>>();
      for (const { envelope, macro } of macroRecords) {
        const packageMacros = macrosByPackage.get(envelope.package) ?? {};
        const { name, ...body } = macro;
        setOwnRecordValue(packageMacros, name, body);
        macrosByPackage.set(envelope.package, packageMacros);
      }
      for (const { manifest } of packageRecords) {
        if (manifest.id === UNPACKAGED_PACKAGE_ID) continue;
        const {
          format: _format,
          version: _version,
          schema_version: _schemaVersion,
          id: _id,
          name,
          description,
          ...extensions
        } = manifest;
        rawByPackage.set(manifest.id, {
          ...extensions,
          version: MACRO_PACKAGE_VERSION,
          name,
          ...(description ? { description } : {}),
          macros: macrosByPackage.get(manifest.id) ?? {}
        });
      }
    } catch (error) {
      throw new Error(
        `Could not read per-entity Package/Macro snapshot: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    const dir = termMacrosDirUri(workspaceRoot);
    if (!(await exists(dir))) {
      packageNames = [];
    } else {
      const files = (await vscode.workspace.fs.readDirectory(dir))
        .filter(([name, type]) =>
          type === vscode.FileType.File && name.toLowerCase().endsWith('.json') && !name.startsWith('.')
        )
        .map(([name]) => name)
        .sort((left, right) => left.localeCompare(right));
      const raws = await mapPackageSnapshotReads(files, async (file) =>
        readJson<unknown>(vscode.Uri.joinPath(dir, file))
      );
      packageNames = files.map(stripJsonExt);
      files.forEach((file, index) => rawByPackage.set(stripJsonExt(file), raws[index]));
    }
  }

  const active = resolveActiveFromConfig(packageNames, config);
  const activeSet = new Set(active);
  const normalized = new Map<string, ReturnType<typeof buildMacroPackageResult>>();
  const normalizePackage = (bare: string): ReturnType<typeof buildMacroPackageResult> | undefined => {
    const raw = rawByPackage.get(bare);
    if (raw === undefined) return undefined;
    let result = normalized.get(bare);
    if (!result) {
      result = buildMacroPackageResult(bare, raw);
      normalized.set(bare, result);
    }
    return result;
  };

  const selectedResult = normalizePackage(selectedBare);
  const selected: PackagePanelSnapshot['selected'] = selectedResult === undefined
    ? Object.freeze({ status: 'noFile' as const })
    : selectedResult.status === 'error'
      ? Object.freeze({ status: 'error' as const, message: selectedResult.message })
      : Object.freeze({
          status: 'ok' as const,
          pkg: Object.freeze(selectedResult.pkg),
          macros: Object.freeze(selectedResult.macros)
        });

  const workspaceMacros: Record<string, MacroPackageEntry> = {};
  const origin: Record<string, string> = {};
  const activeInFileOrder = packageNames
    .filter((bare) => activeSet.has(bare))
    .sort((left, right) => `${left}.json`.localeCompare(`${right}.json`));
  for (const bare of activeInFileOrder) {
    const result = normalizePackage(bare);
    if (!result || result.status === 'error') {
      throw new Error(
        result?.status === 'error'
          ? `Could not read Macro Package ${JSON.stringify(bare)}: ${result.message}`
          : `Macro Package ${JSON.stringify(bare)} disappeared while loading Macros.`
      );
    }
    for (const macro of result.macros) {
      if (Object.prototype.hasOwnProperty.call(workspaceMacros, macro.name)) {
        macrosOutput()?.appendLine(formatMacroConflict(
          macroOutputLanguage(), macro.name, origin[macro.name], bare
        ));
      }
      setOwnRecordValue(workspaceMacros, macro.name, macro);
      setOwnRecordValue(origin, macro.name, bare);
    }
  }

  const activePackages = activeInFileOrder.map((bare) => {
    const result = normalizePackage(bare);
    if (!result || result.status === 'error') {
      throw new Error(
        result?.status === 'error'
          ? `Could not read Macro Package ${JSON.stringify(bare)}: ${result.message}`
          : `Macro Package ${JSON.stringify(bare)} disappeared while loading Macros.`
      );
    }
    return Object.freeze({
      file: bare,
      name: result.pkg.name,
      macros: Object.freeze(result.macros)
    });
  });

  const otherPackages = active
    .filter((bare) => bare !== selectedBare)
    .map((bare) => {
      const result = normalizePackage(bare);
      if (!result || result.status === 'error') return { file: bare, name: bare };
      return { file: bare, name: result.pkg.name };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.file.localeCompare(right.file));

  return Object.freeze({
    selected,
    workspaceMacros: Object.freeze(workspaceMacros),
    macroOrigins: Object.freeze(origin),
    activePackages: Object.freeze(activePackages),
    macroKinds: Object.freeze(config.macro_kinds ?? []),
    active: Object.freeze(active),
    otherPackages: Object.freeze(
      otherPackages.map((entry) => Object.freeze(entry))
    )
  });
}

/** PackagePanel-specific view over the shared operation-local snapshot. */
export async function readPackagePanelSnapshot(
  workspaceRoot: vscode.Uri,
  selectedFile: string
): Promise<PackagePanelSnapshot> {
  return readPackageMacroSnapshot(workspaceRoot, selectedFile);
}

/**
 * Canonicalize any supported historical Macro package shape to the requested
 * wrapper schema while preserving wrapper-level extension fields. Used by explicit
 * workspace data migrations; ordinary reads remain non-mutating.
 */
export function canonicalizeMacroPackageData(
  file: string,
  raw: unknown,
  targetVersion: '7' | '8' | '9' | '10' | '11' = '11'
): Record<string, unknown> {
  assertSupportedMacroPackageVersion(raw);
  const bare = stripJsonExt(file);
  const wrapper = raw && typeof raw === 'object' && !Array.isArray(raw) &&
    'macros' in (raw as Record<string, unknown>)
    ? raw as Record<string, unknown>
    : {};

  if (targetVersion === '7') {
    const macros = normalizeMacrosV7(raw);
    const macroEntries: Array<[string, unknown]> = [];
    for (const macro of macros) {
      const name = typeof macro.name === 'string' ? macro.name : '';
      const { name: _drop, ...rest } = macro;
      macroEntries.push([name, rest]);
    }
    const macrosMap = Object.fromEntries(macroEntries);
    const rawObject = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    return {
      ...wrapper,
      version: '7',
      name: typeof rawObject.name === 'string' && rawObject.name.trim() ? rawObject.name : bare,
      ...(typeof rawObject.description === 'string' && rawObject.description.trim()
        ? { description: rawObject.description }
        : {}),
      macros: macrosMap
    };
  }

  if (targetVersion === '8') {
    const macroEntries: Array<[string, unknown]> = [];
    for (const macro of normalizeMacrosV7(raw)) {
      const migrated = migrateMacroV7toV8(
        macro as unknown as Parameters<typeof migrateMacroV7toV8>[0]
      );
      const { name: _drop, ...rest } = migrated;
      macroEntries.push([migrated.name, rest]);
    }
    const macrosMap = Object.fromEntries(macroEntries);
    const rawObject = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    return {
      ...wrapper,
      version: '8',
      name: typeof rawObject.name === 'string' && rawObject.name.trim() ? rawObject.name : bare,
      ...(typeof rawObject.description === 'string' && rawObject.description.trim()
        ? { description: rawObject.description }
        : {}),
      macros: macrosMap
    };
  }

  if (targetVersion === '9' || targetVersion === '10') {
    const macros = normalizeLegacyMacros(raw, targetVersion);
    const macrosMap = Object.fromEntries(macros.map((macro) => {
      const { name, ...rest } = macro;
      return [name, rest];
    }));
    const rawObject = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    return {
      ...wrapper,
      version: targetVersion,
      name: typeof rawObject.name === 'string' && rawObject.name.trim() ? rawObject.name : bare,
      ...(typeof rawObject.description === 'string' && rawObject.description.trim()
        ? { description: rawObject.description }
        : {}),
      macros: macrosMap
    };
  }

  const result = buildMacroPackageResult(bare, raw, targetVersion);
  if (result.status === 'error') {
    throw new Error(`${file}: ${result.message}`);
  }
  return {
    ...wrapper,
    ...result.pkg
  };
}

async function buildMacroPackageOperations(
  workspaceRoot: vscode.Uri,
  bare: string,
  next: MacroPackageFile,
  expectedRaw: unknown,
  fallbackEnvelopes: ReadonlyMap<string, MacroEnvelope> = new Map()
): Promise<JsonFileOperation[]> {
  const current = await readMacroPackage(workspaceRoot, bare);
  if (current.status !== 'ok') throw new Error(`Macro package ${bare} disappeared.`);
  assertJsonSnapshotUnchanged(expectedRaw, current.raw, `${bare}.json`);

  const storage = entityReadStorage(workspaceRoot);
  const [packages, macroRecords] = await Promise.all([
    readPackageManifestRecords(storage),
    readMacroEntityRecords(storage)
  ]);
  const packageRecord = packages.find(({ manifest }) => manifest.id === bare);
  if (!packageRecord) throw new Error(`Macro package ${bare} manifest disappeared.`);
  const currentMacros = new Map(
    macroRecords
      .filter(({ envelope }) => envelope.package === bare)
      .map((record) => [record.macro.name, record])
  );
  const operations: JsonFileOperation[] = [];
  for (const [macroName, macroValue] of Object.entries(next.macros)) {
    const existing = currentMacros.get(macroName);
    const macro = {
      ...(macroValue as unknown as Record<string, unknown>),
      name: macroName
    };
    const rewrite = existing
      ? rewriteMacroEntityRecord(existing, bare, macro)
      : {
          value: {
            ...(fallbackEnvelopes.get(macroName) ?? {}),
            ...makeMacroEnvelope(bare, macro)
          },
          expected: null
        };
    // Compare normalized semantic content rather than raw legacy bytes. A
    // Package edit must not stamp every untouched Macro in that Package.
    if (!existing || entityFileRewriteChanges(rewrite, existing.envelope)) {
      operations.push({
        kind: 'write',
        uri: snlRelativeUri(workspaceRoot, macroEntityPath(bare, macroName)),
        value: rewrite.value,
        expected: rewrite.expected
      });
    }
    currentMacros.delete(macroName);
  }
  for (const record of currentMacros.values()) {
    operations.push({
      kind: 'delete',
      uri: snlRelativeUri(workspaceRoot, record.path),
      expected: record.rawEnvelope
    });
  }

  const manifestRewrite = rewritePackageManifestRecord(
    packageRecord,
    next.name || bare,
    typeof next.description === 'string' ? next.description : ''
  );
  // The Package manifest is independent from its Macro children. Rewrite it
  // only when its own normalized content changed.
  if (entityFileRewriteChanges(manifestRewrite, packageRecord.manifest)) {
    operations.push({
      kind: 'write',
      uri: snlRelativeUri(workspaceRoot, packageRecord.path),
      value: manifestRewrite.value,
      expected: manifestRewrite.expected
    });
  }
  return operations;
}

async function persistMacroPackage(
  workspaceRoot: vscode.Uri,
  bare: string,
  next: MacroPackageFile,
  expectedRaw: unknown
): Promise<void> {
  if (!(await usesEntityStorage(workspaceRoot))) {
    await writeWorkspaceFile(
      workspaceRoot,
      macroPackageUri(workspaceRoot, bare),
      jsonBytes(next),
      expectedRaw
    );
    return;
  }

  await withExtensionWriterLock(workspaceRoot, `update Macro package ${bare}`, async () => {
    const operations = await buildMacroPackageOperations(workspaceRoot, bare, next, expectedRaw);
    await applyJsonFileOperations(workspaceRoot, `persist Macro package ${bare}`, operations);
  });
}

/**
 * Read every macro from every package under the workspace and return them
 * as a flat map keyed by macro name (last-writer-wins on collisions —
 * matches how consumers merge multiple package files into a single lookup
 * for parsing / rendering).
 *
 * Result rows use the extended v9 on-disk shape (typst / latex / markdown /
 * text backends included). Webviews adapt these rows behind MacroDataDriver.
 *
 * Best-effort: individual packages that fail to load (missing file, JSON
 * parse error) are silently skipped so a single broken package can't
 * take out the whole editor.
 */
export async function readAllMacros(
  workspaceRoot: vscode.Uri
): Promise<Record<string, MacroPackageEntry>> {
  return (await readAllMacrosWithOrigin(workspaceRoot)).macros;
}

/**
 * Same as {@link readAllMacros}, but also returns the macro-name → owning
 * package map that the walk already computes internally.
 *
 * Callers used to ask for the macros and then walk every active package a
 * SECOND time just to rebuild this map — doubling the file reads on every
 * panel open. The packages are also read concurrently now: they are
 * independent files and the serial `await` in a loop was pure latency.
 * Cat 2026-07-25: "各个 Panel 开起来都非常慢".
 */
export async function readAllMacrosWithOrigin(
  workspaceRoot: vscode.Uri
): Promise<{
  macros: Record<string, MacroPackageEntry>;
  origin: Record<string, string>;
}> {
  const snapshot = await readPackageMacroSnapshot(workspaceRoot);
  return {
    macros: snapshot.workspaceMacros as Record<string, MacroPackageEntry>,
    origin: snapshot.macroOrigins as Record<string, string>
  };
}

/**
 * Compute the effective set of active macro-package bare names for a
 * workspace. When `config.json#active_macro_packages` is present it is used
 * verbatim (garbage-collected against packages actually on disk); when it is
 * absent (older workspaces) EVERY package on disk is treated as active —
 * a side-effect-free backwards-compat migration. The returned list is
 * deduped and only contains packages that currently exist on disk.
 */
export async function resolveActiveMacroPackages(
  workspaceRoot: vscode.Uri
): Promise<string[]> {
  // Only the file NAMES matter here, so list them directly instead of going
  // through `readMacroPackages`, which parses every package just to compute
  // a macroCount this function throws away. That parse showed up as a whole
  // extra read of every package on each panel open.
  // Cat 2026-07-25: "各个 Panel 开起来都非常慢".
  const [onDisk, cfg] = await Promise.all([
    listMacroPackageNames(workspaceRoot),
    readJson<unknown>(configUri(workspaceRoot))
      .then((raw) => normalizeConfig(raw))
  ]);
  return resolveActiveFromConfig(onDisk, cfg);
}

/**
 * Pure core of {@link resolveActiveMacroPackages}. Split out so callers that
 * have already read `config.json` and listed the packages on disk (the
 * Dashboard) don't have to read either a second time.
 */
function resolveActiveFromConfig(
  onDisk: string[],
  cfg: SnlConfig | null
): string[] {
  if (!cfg || cfg.active_macro_packages === undefined) {
    // Missing field: all packages on disk are active.
    return Array.from(new Set(onDisk)).sort((a, b) => a.localeCompare(b));
  }
  const declared = new Set(cfg.active_macro_packages.map(stripJsonExt));
  // Garbage-collect on read: only surface packages still present on disk.
  const resolved = onDisk.filter((bare) => declared.has(bare));
  return Array.from(new Set(resolved)).sort((a, b) => a.localeCompare(b));
}

/** Bare names of the macro-package files on disk, without reading them. */
async function listMacroPackageNames(
  workspaceRoot: vscode.Uri,
  knownEntityMode?: boolean,
  strict = false
): Promise<string[]> {
  const entityMode = knownEntityMode ?? await usesEntityStorage(workspaceRoot);
  if (entityMode) {
    try {
      return (await readPackageManifestRecords(entityReadStorage(workspaceRoot)))
        .map(({ manifest }) => manifest.id)
        .filter((id) => id !== UNPACKAGED_PACKAGE_ID)
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      throw new Error(
        `Could not list per-entity Macro Packages: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const dir = termMacrosDirUri(workspaceRoot);
  if (!(await exists(dir))) return [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(([name, type]) =>
        type === vscode.FileType.File &&
        name.toLowerCase().endsWith('.json') &&
        !name.startsWith('.')
      )
      .map(([name]) => stripJsonExt(name));
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

/**
 * Persist the active macro-package list to `config.json`, deduping and
 * sorting for stability. Preserves every unrelated config field by
 * round-tripping the raw JSON. Bare names (any `.json` suffix is stripped).
 */
async function setActiveMacroPackages(
  workspaceRoot: vscode.Uri,
  activeList: string[]
): Promise<void> {
  const uri = configUri(workspaceRoot);
  let raw: Record<string, unknown>;
  try {
    raw = (await readJson<Record<string, unknown>>(uri)) ?? {};
  } catch (err) {
    throw new Error(
      `Failed to read .SNL_Doc/config.json: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  const original = structuredClone(raw);
  const normalized = Array.from(
    new Set((Array.isArray(activeList) ? activeList : []).map(stripJsonExt))
  ).sort((a, b) => a.localeCompare(b));
  raw.active_macro_packages = normalized;
  await writeWorkspaceFile(workspaceRoot, uri, jsonBytes(raw), original);
}

export async function setMacroPackageActive(
  workspaceRoot: vscode.Uri,
  packageFile: string,
  active: boolean
): Promise<void> {
  const bare = stripJsonExt(packageFile);
  await withExtensionWriterLock(workspaceRoot, `set active Macro package ${bare}`, async () => {
    const entityMode = await usesEntityStorage(workspaceRoot);
    const packageNames = await listMacroPackageNames(workspaceRoot, entityMode, true);
    const configRaw = await readJson<unknown>(configUri(workspaceRoot));
    const current = new Set(resolveActiveFromConfig(packageNames, normalizeConfig(configRaw)));
    if (active) {
      if (!packageNames.includes(bare)) throw new Error(`Macro Package ${bare} does not exist.`);
      current.add(bare);
    } else {
      current.delete(bare);
    }
    await setActiveMacroPackages(workspaceRoot, Array.from(current));
  });
}

/**
 * Delete a macro-package JSON file and drop it from the active list.
 * Returns `ok` even if the active list didn't contain it; `noFile` when the
 * package file does not exist.
 */
export async function deleteMacroPackage(
  workspaceRoot: vscode.Uri,
  file: string
): Promise<
  | { status: 'ok'; file: string }
  | { status: 'noFile' }
  | { status: 'error'; message: string }
> {
  const fsApi = vscode.workspace.fs;
  const bare = typeof file === 'string' ? stripJsonExt(file.trim()) : '';
  if (!MACRO_FILE_RE.test(bare)) {
    return { status: 'error', message: 'invalid package file name' };
  }
  if (bare === UNPACKAGED_PACKAGE_ID) {
    return { status: 'error', message: 'the _unpackaged system Package cannot be deleted' };
  }
  return withExtensionWriterLock(workspaceRoot, `delete Macro package ${bare}`, async () => {
    if (await usesEntityStorage(workspaceRoot)) {
      try {
        const storage = entityReadStorage(workspaceRoot);
        const [packages, macros, entries] = await Promise.all([
          readPackageManifestRecords(storage),
          readMacroEntityRecords(storage),
          readEntryEntityRecords(storage)
        ]);
        const packageRecord = packages.find(({ manifest }) => manifest.id === bare);
        if (!packageRecord) return { status: 'noFile' } as const;
        const entryCount = entries.filter(({ envelope }) => envelope.package === bare).length;
        if (entryCount > 0) {
          return {
            status: 'error',
            message: `Package ${JSON.stringify(bare)} still contains ${entryCount} ${entryCount === 1 ? 'Entry' : 'Entries'}; move them before deleting the Package.`
          } as const;
        }
        const configRaw = await readJson<unknown>(configUri(workspaceRoot));
        if (!configRaw || typeof configRaw !== 'object' || Array.isArray(configRaw)) {
          throw new Error('config.json must be an object');
        }
        const packageNames = packages
          .map(({ manifest }) => manifest.id)
          .filter((id) => id !== UNPACKAGED_PACKAGE_ID);
        const activePackages = new Set(resolveActiveFromConfig(packageNames, normalizeConfig(configRaw)));
        activePackages.delete(bare);
        const nextConfig = {
          ...configRaw,
          active_macro_packages: [...activePackages].sort((left, right) => left.localeCompare(right))
        };
        const operations: JsonFileOperation[] = macros
          .filter(({ envelope }) => envelope.package === bare)
          .map((record) => ({
            kind: 'delete' as const,
            uri: snlRelativeUri(workspaceRoot, record.path),
            expected: record.rawEnvelope
          }));
        operations.push(
          {
            kind: 'delete',
            uri: snlRelativeUri(workspaceRoot, packageRecord.path),
            expected: packageRecord.rawManifest
          },
          {
            kind: 'write',
            uri: configUri(workspaceRoot),
            value: nextConfig,
            expected: configRaw
          }
        );
        await applyJsonFileOperations(workspaceRoot, `delete Macro package ${bare}`, operations);
        return { status: 'ok', file: `${bare}.json` } as const;
      } catch (err) {
        return { status: 'error', message: err instanceof Error ? err.message : String(err) } as const;
      }
    }
    const target = macroPackageUri(workspaceRoot, bare);
  if (!(await exists(target))) {
    return { status: 'noFile' };
  }
  try {
    await withExtensionWriterLock(workspaceRoot, `delete ${target.fsPath}`, async () => {
      await assertWorkspaceWritableOnDisk(workspaceRoot);
      await fsApi.delete(target, { useTrash: false });
    });
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  try {
    await setMacroPackageActive(workspaceRoot, bare, false);
  } catch {
    // Config missing/unwritable — the file delete already succeeded.
  }
    return { status: 'ok', file: `${bare}.json` };
  });
}

/** Validate the structural invariants of a single {@link MacroPackageEntry}. */
function validateMacro(macro: MacroPackageEntry): string | null {
  const name = typeof macro?.name === 'string' ? macro.name : '';
  if (!name) {
    return 'name is required';
  }
  if (!isSnlIdentifier(name)) {
    return 'name is not a valid SNL identifier';
  }
  if (typeof macro.dynamic_arity !== 'boolean') {
    return "dynamic_arity must be a boolean";
  }
  const styles = macro?.styles;
  if (!Array.isArray(styles)) {
    return 'styles must be an array';
  }
  if (styles.length === 0) {
    return 'styles must have at least one entry';
  }
  const seen = new Set<string>();
  for (let i = 0; i < styles.length; i++) {
    const style = styles[i];
    if (!style || typeof style !== 'object') {
      return `styles[${i}] must be an object`;
    }
    const styleName = typeof style.style_name === 'string' ? style.style_name : '';
    if (!styleName) {
      return `styles[${i}].style_name is required`;
    }
    if (!isSnlIdentifier(styleName)) {
      return `styles[${i}].style_name is not a valid SNL identifier`;
    }
    if (seen.has(styleName)) {
      return `styles[${i}].style_name "${styleName}" is duplicated`;
    }
    seen.add(styleName);
    const rawStyle = style as unknown as Record<string, unknown>;
    const retiredStyleFields = [
      'mode', 'separator', 'block_template_name', 'typst', 'latex', 'markdown', 'text',
      'tag', 'variadic_left', 'variadic_join', 'variadic_right',
      'react_renderer_key', 'display'
    ];
    const retiredStyleField = retiredStyleFields.find((field) => field in rawStyle);
    if (retiredStyleField) {
      return `styles[${i}].${retiredStyleField} is retired in Macro v11; it belongs inside template`;
    }
    const currentStyleFields = new Set(['style_name', 'tags', 'template']);
    if (Object.keys(rawStyle).some((field) => !currentStyleFields.has(field))) {
      return `styles[${i}] has fields outside the Macro v11 Style boundary`;
    }
    const rawTemplate = rawStyle.template;
    let projections: unknown[];
    if (
      rawTemplate && typeof rawTemplate === 'object' && !Array.isArray(rawTemplate) &&
      (rawTemplate as { type?: unknown }).type === 'i18n'
    ) {
      const localized = rawTemplate as Record<string, unknown> & {
        default_language?: unknown; values?: unknown
      };
      const localizedFields = new Set(['type', 'default_language', 'values']);
      if (Object.keys(localized).some((field) => !localizedFields.has(field)) ||
          typeof localized.default_language !== 'string' || localized.default_language.length === 0 ||
          !localized.values || typeof localized.values !== 'object' || Array.isArray(localized.values)) {
        return `styles[${i}].template is an invalid localized template`;
      }
      const values = localized.values as Record<string, unknown>;
      if (!Object.hasOwn(values, localized.default_language) || values[localized.default_language] === undefined) {
        return `styles[${i}].template must define its default language`;
      }
      projections = Object.values(values).filter((projection) => projection !== undefined);
    } else {
      projections = [rawTemplate];
    }
    if (projections.length === 0) return `styles[${i}].template is required`;
    for (const [projectionIndex, value] of projections.entries()) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return `styles[${i}].template projection ${projectionIndex} must be an object`;
      }
      const projection = value as Record<string, unknown>;
      if (
        Object.hasOwn(projection, 'type') ||
        (projection.mode !== 'formula_inline' && projection.mode !== 'formula_display' &&
        projection.mode !== 'text' && projection.mode !== 'block'
        )
      ) {
        return `styles[${i}].template projection ${projectionIndex} has an invalid mode`;
      }
      if (typeof projection.body !== 'string' ||
          (projection.mode !== 'block' && projection.body.trim().length === 0)) {
        return `styles[${i}].template projection ${projectionIndex}.body is required`;
      }
      if (analyzeLatexTemplatePlaceholders(projection.body).variadic !== macro.dynamic_arity) {
        return `styles[${i}].template projection ${projectionIndex}.body variadic marker disagrees with macro arity`;
      }
      if (projection.separator !== undefined && typeof projection.separator !== 'string') {
        return `styles[${i}].template projection ${projectionIndex}.separator must be a string`;
      }
      if (projection.mode !== 'block' && projection.block_template_name !== undefined) {
        return `styles[${i}].template projection ${projectionIndex}.block_template_name is valid only in block mode`;
      }
    }
  }
  // Tags are required string arrays in v9; backslashes remain forbidden.
  const macroTags = macro.tags;
  if (!Array.isArray(macroTags)) {
    return 'tags must be an array of strings';
  }
  for (const t of macroTags) {
    if (typeof t !== 'string') return 'tags entries must be strings';
    if (t.includes('\\')) return 'tags may not contain backslashes';
  }
  for (let i = 0; i < styles.length; i++) {
    const styleTags = styles[i].tags;
    if (!Array.isArray(styleTags)) {
      return `styles[${i}].tags must be an array of strings`;
    }
    for (const t of styleTags) {
      if (typeof t !== 'string') return `styles[${i}].tags entries must be strings`;
      if (t.includes('\\')) return `styles[${i}].tags may not contain backslashes`;
    }
  }
  const src = macro?.source;
  if (!src || typeof src !== 'object') {
    return 'source is required';
  }
  const isStrArray = (v: unknown): boolean =>
    Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (!isStrArray(src.entries)) {
    return 'source.entries must be an array of strings';
  }
  if (!isStrArray(src.urls)) {
    return 'source.urls must be an array of strings';
  }
  try {
    assertCanonicalMacroPackage('Macro', {
      version: '11',
      macros: { [name]: macro }
    }, '11');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

/**
 * Append a macro to a package, deduping by `macro.name`. Writes the canonical
 * shape back. Missing file → `noFile`; the caller is expected to create the
 * package first via {@link createMacroPackage}.
 */
export async function addMacro(
  workspaceRoot: vscode.Uri,
  file: string,
  macro: MacroPackageEntry
): Promise<
  | { status: 'ok'; name: string }
  | { status: 'noFile' }
  | { status: 'duplicate'; name: string }
  | { status: 'invalid'; reason: string }
  | { status: 'error'; message: string }
> {

  const reason = validateMacro(macro);
  if (reason) {
    return { status: 'invalid', reason };
  }

  const read = await readMacroPackage(workspaceRoot, file);
  if (read.status === 'noFile') {
    return { status: 'noFile' };
  }
  if (read.status === 'error') {
    return { status: 'error', message: read.message };
  }

  const name = macro.name.trim();
  if (Object.prototype.hasOwnProperty.call(read.pkg.macros, name)) {
    return { status: 'duplicate', name };
  }

  const { name: _drop, ...rest } = macro;
  const next: MacroPackageFile = {
    ...read.pkg,
    macros: { ...read.pkg.macros, [name]: { ...rest } }
  };

  try {
    await persistMacroPackage(workspaceRoot, stripJsonExt(file), next, read.raw);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'ok', name };
}

/** Dashboard snapshot data. Counts are best-effort: a missing/corrupt file
 *  yields `null` for its count instead of crashing the panel. */
export interface LibrarySummary {
  slug: string;
  title: string;
  entryCount: number | null; // distinct UUIDs referenced from this library's graph
  relationshipCount: number | null; // number of edges
}

export interface EntryPackageSummary {
  /** Stable Package manifest identity. */
  id: string;
  /** Human-facing manifest name. */
  name: string;
  description: string;
  entryCount: number;
}

/**
 * Read Entry Package picker summaries from Package manifests only.
 *
 * Package `entry_ids` is the authoritative point index for the count, so this
 * path never scans Macro entities (or all Entry entities) merely to populate a
 * package picker.
 */
export async function readEntryPackages(
  workspaceRoot: vscode.Uri
): Promise<EntryPackageSummary[]> {
  if (!(await usesEntityStorage(workspaceRoot))) return [];
  const records = await readPackageManifestRecords(entityReadStorage(workspaceRoot));
  return records
    .map(({ manifest }) => {
      const entryIds = packageManifestEntryIds(manifest);
      if (entryIds === null) {
        throw new Error(`Package ${JSON.stringify(manifest.id)} is missing its current Entry membership index.`);
      }
      return {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        entryCount: entryIds.length
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export interface SnlOverview {
  hasSnlDoc: boolean;
  totalEntryCount: number | null; // size of the shared entries.json pool
  /** The shared entry pool from `entries.json` (empty when missing/corrupt). */
  entries: EntryData[];
  entryPackages: EntryPackageSummary[];
  libraries: LibrarySummary[];
  /** Term macro packages enumerated under `term_macros/`. */
  macroPackages: MacroPackageSummary[];
  /**
   * Every macro's identity across every package in the workspace. Powers the
   * Dashboard's Find Macro (SNoogL) search box — client-side substring match
   * over `id`. Package origin is preserved so the search UI can offer
   * "jump to package". Ordered by package then macro name.
   */
  allMacros: AllMacroIndexEntry[];
  /** Active macro names and their source declarations for entry metrics. */
  metricMacroSources: Record<string, { source: { entries: string[]; urls: string[] } }>;
  /** Entry-kind catalog from `config.json#entry_kinds`. */
  entryKinds: EntryKind[];
  /** Macro-kind catalog from `config.json#macro_kinds`. */
  macroKinds: MacroKind[];
  /** Pool-wide relationships from `relationships.json` (empty on missing). */
  relationships: RelationshipData[];
}

/**
 * One entry in the flat "all macros in workspace" index for the SNoogL
 * search box. Kept lightweight (no styles / templates / backends) — this is
 * ship-in-overview data, not render data.
 */
export interface AllMacroIndexEntry {
  /** Macro identity — e.g. `Set.union`. Unique within a package. */
  id: string;
  /** Package file this macro lives in — e.g. `mathlib_basic.json`. */
  packageFile: string;
  /** Package's declared name (falls back to the bare file stem). */
  packageName: string;
  /** Optional macro `kind` (rule / const / partial / …). */
  kind?: string;
}

/**
 * Read a snapshot for the Dashboard panel.
 *
 * Returns `{ hasSnlDoc: false, ... }` when `.SNL_Doc/` is missing — panels use
 * this to render the "not initialized" placeholder. Otherwise scans
 * `config.json` for the library list and computes per-library counts from
 * each `graph.json`.
 *
 * Per-library entry count = number of DISTINCT entry UUIDs that appear as
 * node ids in that library's relationship graph (the subset of the shared
 * pool this library actually references). We deliberately don't union with
 * edge endpoints because edges in our current shape don't carry typed
 * endpoint metadata yet — once the Entry/edge schema lands this should be
 * revisited.
 */
export async function readOverview(
  workspaceRoot: vscode.Uri,
  operationSnapshot?: StoredWorkspaceDataReadSnapshot
): Promise<SnlOverview> {
  const root = snlRootUri(workspaceRoot);
  if (!(await exists(root))) {
    return {
      hasSnlDoc: false,
      totalEntryCount: null,
      entries: [],
      entryPackages: [],
      libraries: [],
      macroPackages: [],
      allMacros: [],
      metricMacroSources: {},
      entryKinds: [],
      macroKinds: [],
      relationships: []
    };
  }

  // Everything below is independent I/O, so it all starts at once. This used
  // to run as four strictly-sequential stages (entries → config → libraries →
  // macro packages), each of which itself awaited in a loop. Cat 2026-07-25:
  // "所有 Dashboard 相关的基本都慢,具体 Library 的 Infoview 不慢" — the
  // Dashboard is the hot path precisely because it fans out the widest.
  const configPromise = operationSnapshot
    ? operationSnapshot.config === null
      ? Promise.reject(new Error('.SNL_Doc/config.json is missing.'))
      : Promise.resolve(normalizeConfig(operationSnapshot.config))
    : readJson<unknown>(configUri(workspaceRoot)).then((raw) => normalizeConfig(raw));
  const discoveredPromise = listLibraries(workspaceRoot);
  const relationshipsPromise = readRelationships(workspaceRoot);
  const config = await configPromise;
  const entityMode = typeof config?.version === 'string' &&
    compareDataVersions(config.version, CURRENT_DATA_VERSION) === 0;
  const entitySnapshot: EntityStorageSnapshot | undefined = entityMode
    ? operationSnapshot?.entities
    : undefined;
  const [entries, discovered, packageNames, relationships] = await Promise.all([
    entitySnapshot
      ? Promise.resolve(entitySnapshot.entries.map(({ entry }) => entry as unknown as EntryData))
      : readEntries(workspaceRoot, entityMode),
    discoveredPromise,
    entitySnapshot
      ? Promise.resolve(entitySnapshot.packages
          .map(({ manifest }) => manifest.id)
          .filter((id) => id !== UNPACKAGED_PACKAGE_ID)
          .sort((left, right) => left.localeCompare(right)))
      : listMacroPackageNames(workspaceRoot, entityMode),
    relationshipsPromise
  ]);
  const totalEntryCount: number | null = entries.length;

  // Per-library counts. Concurrent, but the summaries are assembled in
  // `discovered` order so the rendered table never depends on I/O timing.
  // Best-effort: a library whose graph.json is missing or corrupt keeps both
  // counts null (rendered as "—") instead of failing the whole Dashboard.
  const libraries: LibrarySummary[] = await Promise.all(
    discovered.map(async (lib): Promise<LibrarySummary> => {
      const summary: LibrarySummary = {
        slug: lib.slug,
        title: lib.title,
        entryCount: null,
        relationshipCount: null
      };
      try {
        const rel = await readJson<LibraryGraphFile>(
          libraryGraphUri(workspaceRoot, lib.slug)
        );
        const nodes = Array.isArray(rel.nodes) ? rel.nodes : [];
        const rels = Array.isArray(rel.relationships) ? rel.relationships : [];
        summary.relationshipCount = rels.length;
        // Count distinct Entry-labelled nodes (Sections/Counters don't
        // contribute to "entries in this library"). See spec §2.
        const ids = new Set<string>();
        for (const n of nodes) {
          if (!n || typeof n !== 'object') continue;
          const label = (n as { label?: unknown }).label;
          if (label !== 'Entry') continue;
          const id = (n as { id?: unknown }).id;
          if (typeof id === 'string') {
            ids.add(id);
          }
        }
        summary.entryCount = ids.size;
      } catch {
        // Leave both null — the dashboard renders "—" for unknown.
      }
      return summary;
    })
  );

  // ONE read per macro package. The old code read every package twice: once
  // through `readMacroPackages` (which parsed the file only to infer a
  // macroCount) and once more through `readMacroPackage` for the actual macro
  // rows. Both products come from the same bytes, so we take them together.
  const loaded: Array<{ file: string; raw: unknown; ok: boolean }> = [];
  if (entityMode) {
    try {
      const { packages: packageRecords, macros: macroRecords } = entitySnapshot ??
        await (async () => {
          const storage = entityReadStorage(workspaceRoot);
          const [packages, macros] = await Promise.all([
            readPackageManifestRecords(storage),
            readMacroEntityRecords(storage)
          ]);
          return { packages, macros };
        })();
      for (const bare of packageNames) {
        const packageRecord = packageRecords.find(({ manifest }) => manifest.id === bare);
        if (!packageRecord) continue;
        const {
          format: _format,
          version: _version,
          schema_version: _schemaVersion,
          id: _id,
          name,
          description,
          ...extensions
        } = packageRecord.manifest;
        const macros: Record<string, unknown> = {};
        for (const record of macroRecords.filter(({ envelope }) => envelope.package === bare)) {
          const { name: macroName, ...macro } = record.macro;
          setOwnRecordValue(macros, macroName, macro);
        }
        loaded.push({
          file: `${bare}.json`,
          raw: {
            ...extensions,
            version: MACRO_PACKAGE_VERSION,
            name,
            ...(description ? { description } : {}),
            macros
          },
          ok: true
        });
      }
    } catch (error) {
      throw new Error(
        `Could not read per-entity Macro storage for Dashboard: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    loaded.push(...await Promise.all(
      packageNames.map(async (bare) => {
        const file = `${bare}.json`;
        try {
          const raw = await readJson<unknown>(macroPackageUri(workspaceRoot, bare));
          return { file, raw, ok: true };
        } catch {
          return { file, raw: undefined, ok: false };
        }
      })
    ));
  }
  // Fold in FILE-name order regardless of which read settled first, so
  // `macroPackages` ordering, `allMacros` ordering, and every last-write-wins
  // resolution stay byte-identical to the serial version. Note file order and
  // bare-name order genuinely differ: `core-extra.json` < `core.json`, but
  // bare `core` < `core-extra`. Review 2026-07-25.
  loaded.sort((a, b) => a.file.localeCompare(b.file));

  const activeSet = new Set(
    resolveActiveFromConfig(packageNames, config)
  );
  const macroPackages: MacroPackageSummary[] = loaded.map(({ file, raw, ok }) => ({
    file,
    macroCount: ok ? inferMacroCount(raw) : null,
    active: activeSet.has(stripJsonExt(file))
  }));
  const entryKinds: EntryKind[] = config?.entry_kinds ?? [];
  const macroKinds: MacroKind[] = config?.macro_kinds ?? [];

  // SNoogL search index: one entry per macro across every package. Built from
  // the same bytes we already have in `loaded` — no second read.
  const allMacros: AllMacroIndexEntry[] = [];
  const metricMacroSources: Record<
    string,
    { source: { entries: string[]; urls: string[] } }
  > = {};
  for (let i = 0; i < macroPackages.length; i += 1) {
    const summary = macroPackages[i];
    // `macroPackages` is `loaded.map(...)`, so the indices line up exactly.
    const entry = loaded[i];
    if (!entry.ok) continue;
    const read = buildMacroPackageResult(stripJsonExt(summary.file), entry.raw);
    if (read.status !== 'ok') continue;
    for (const macro of read.macros) {
      if (typeof macro.name !== 'string' || macro.name.length === 0) continue;
      allMacros.push({
        id: macro.name,
        packageFile: summary.file,
        packageName: read.pkg?.name ?? summary.file.replace(/\.json$/i, ''),
        ...(typeof macro.kind === 'string' && macro.kind ? { kind: macro.kind } : {})
      });
      if (summary.active !== false) {
        setOwnRecordValue(metricMacroSources, macro.name, {
          source: {
            entries: Array.isArray(macro.source?.entries) ? macro.source.entries : [],
            urls: Array.isArray(macro.source?.urls) ? macro.source.urls : []
          }
        });
      }
    }
  }
  allMacros.sort((a, b) =>
    a.packageFile === b.packageFile
      ? a.id.localeCompare(b.id)
      : a.packageFile.localeCompare(b.packageFile),
  );

  const entryCounts = new Map<string, number>();
  for (const entry of entries) {
    const packageId = typeof entry.package === 'string' && entry.package
      ? entry.package
      : UNPACKAGED_PACKAGE_ID;
    entryCounts.set(packageId, (entryCounts.get(packageId) ?? 0) + 1);
  }
  const entryPackages: EntryPackageSummary[] = entitySnapshot
    ? entitySnapshot.packages.map(({ manifest }) => ({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        entryCount: entryCounts.get(manifest.id) ?? 0
      }))
    : entries.length > 0
      ? [{ id: UNPACKAGED_PACKAGE_ID, name: UNPACKAGED_PACKAGE_ID, description: '', entryCount: entries.length }]
      : [];
  entryPackages.sort((left, right) => left.id.localeCompare(right.id));

  return {
    hasSnlDoc: true,
    totalEntryCount,
    entries,
    entryPackages,
    libraries,
    macroPackages,
    allMacros,
    metricMacroSources,
    entryKinds,
    macroKinds,
    relationships
  };
}

// ---------------------------------------------------------------------------
// Entry Kinds write ops
// ---------------------------------------------------------------------------

/**
 * Load the current entry_kinds catalog from disk (normalized). Returns `[]`
 * when the config or `.SNL_Doc/` doesn't exist yet.
 */
export async function readEntryKinds(
  workspaceRoot: vscode.Uri
): Promise<EntryKind[]> {
  if (!(await exists(configUri(workspaceRoot)))) return [];
  const cfg = normalizeConfig(await readJson<unknown>(configUri(workspaceRoot)));
  return cfg.entry_kinds ?? [];
}

/**
 * Persist a full entry_kinds catalog to `config.json`. Preserves every
 * unrelated field (libraries, version, unknown keys) by round-tripping the
 * raw JSON and only rewriting `entry_kinds`.
 *
 * Throws when `.SNL_Doc/config.json` is missing or unreadable — callers
 * should surface the error to the user rather than silently create it.
 */
async function writeEntryKinds(
  workspaceRoot: vscode.Uri,
  kinds: EntryKind[]
): Promise<void> {
  const uri = configUri(workspaceRoot);
  let raw: Record<string, unknown>;
  try {
    raw = (await readJson<Record<string, unknown>>(uri)) ?? {};
  } catch (err) {
    throw new Error(
      `Failed to read .SNL_Doc/config.json: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  const original = structuredClone(raw);
  raw.entry_kinds = kinds;
  await writeWorkspaceFile(workspaceRoot, uri, jsonBytes(raw), original);
}

export type ApplyPresetResult =
  | { status: 'applied'; count: number }
  | { status: 'noSnlDoc' }
  | { status: 'nonEmpty'; existing: number }
  | { status: 'unknownPreset'; presetId: string };

/**
 * Initialize `entry_kinds` from a named preset. Refuses to run when the
 * catalog already has entries (a "clobber existing kinds" flow would need
 * explicit user confirmation and diff UI, which we don't have yet).
 *
 * `.SNL_Doc/` must exist. Presets live in {@link ENTRY_KIND_PRESETS} so the
 * webview can enumerate them without touching the extension host.
 */
export async function applyEntryKindsPreset(
  workspaceRoot: vscode.Uri,
  presetId: string
): Promise<ApplyPresetResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  return withExtensionWriterLock(workspaceRoot, 'apply entry kind preset', async () => {
    const prepared = prepareKindPresetApplication(
      ENTRY_KIND_PRESETS,
      presetId,
      await readEntryKinds(workspaceRoot)
    );
    if (prepared.status !== 'applied') return prepared;
    const kinds = prepared.kinds;
    await writeEntryKinds(workspaceRoot, kinds);
    return { status: 'applied', count: kinds.length };
  });
}

export type CreateEntryKindResult =
  | { status: 'created'; kind: EntryKind }
  | { status: 'noSnlDoc' }
  | { status: 'duplicate'; id: string }
  | { status: 'invalid'; message: string };

/**
 * Append a single new entry kind. Rejects duplicates by id and empty ids.
 * All other fields (colours, default counter name, style) are stored
 * verbatim.
 */
export async function createEntryKind(
  workspaceRoot: vscode.Uri,
  input: {
    id: string;
    name: Localized<string, string>;
    description: Localized<string, string>;
    coloring: ThemedKindColoring;
    defaultCounterName: string;
    style: string;
  }
): Promise<CreateEntryKindResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  return withExtensionWriterLock(workspaceRoot, 'create entry kind', async () => {
    const id = (input.id ?? '').trim();
    if (!id) return { status: 'invalid', message: 'id is required' };
    let name: Localized<string, string>;
    let description: Localized<string, string>;
    try {
      name = normalize_kind_label(input.name, 'Entry Kind name', true);
      description = normalize_kind_label(input.description ?? '', 'Entry Kind description', false);
    } catch (error) {
      return { status: 'invalid', message: error instanceof Error ? error.message : String(error) };
    }
    const existing = await readEntryKinds(workspaceRoot);
    if (existing.some((kind) => kind.id === id)) return { status: 'duplicate', id };
    const kind: EntryKind = {
      id,
      name,
      description,
      coloring: fillKindColoringDefaults(input.coloring),
      defaultCounterName: (input.defaultCounterName ?? '').trim(),
      style: (input.style ?? '').trim()
    };
    await writeEntryKinds(workspaceRoot, [...existing, kind]);
    return { status: 'created', kind };
  });
}

/**
 * Thin alias over {@link readEntryKinds} for the Entry editor webview, which
 * only needs the kind catalog to populate its "Kind" dropdown. Kept as a
 * separate named export so the intent is explicit at the call site.
 */
export async function listEntryKinds(
  workspaceRoot: vscode.Uri
): Promise<EntryKind[]> {
  return readEntryKinds(workspaceRoot);
}

// ---------------------------------------------------------------------------
// Macro Kinds write ops
// ---------------------------------------------------------------------------

/**
 * Load the current macro_kinds catalog from disk (normalized). Returns `[]`
 * when the config or `.SNL_Doc/` doesn't exist yet.
 */
export async function readMacroKinds(
  workspaceRoot: vscode.Uri
): Promise<MacroKind[]> {
  if (!(await exists(configUri(workspaceRoot)))) return [];
  const cfg = normalizeConfig(await readJson<unknown>(configUri(workspaceRoot)));
  return cfg.macro_kinds ?? [];
}

/**
 * Persist a full macro_kinds catalog to `config.json`. Preserves every
 * unrelated field by round-tripping the raw JSON and only rewriting
 * `macro_kinds`.
 *
 * Throws when `.SNL_Doc/config.json` is missing or unreadable.
 */
async function writeMacroKinds(
  workspaceRoot: vscode.Uri,
  kinds: MacroKind[]
): Promise<void> {
  const uri = configUri(workspaceRoot);
  let raw: Record<string, unknown>;
  try {
    raw = (await readJson<Record<string, unknown>>(uri)) ?? {};
  } catch (err) {
    throw new Error(
      `Failed to read .SNL_Doc/config.json: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  const original = structuredClone(raw);
  raw.macro_kinds = kinds;
  await writeWorkspaceFile(workspaceRoot, uri, jsonBytes(raw), original);
}

export type ApplyMacroKindsPresetResult =
  | { status: 'applied'; count: number }
  | { status: 'noSnlDoc' }
  | { status: 'nonEmpty'; existing: number }
  | { status: 'unknownPreset'; presetId: string };

/**
 * Initialize `macro_kinds` from a named preset. Refuses to run when the
 * catalog already has entries. `.SNL_Doc/` must exist. Presets live in
 * {@link MACRO_KIND_PRESETS}.
 */
export async function applyMacroKindsPreset(
  workspaceRoot: vscode.Uri,
  presetId: string
): Promise<ApplyMacroKindsPresetResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  return withExtensionWriterLock(workspaceRoot, 'apply Macro kind preset', async () => {
    const prepared = prepareKindPresetApplication(
      MACRO_KIND_PRESETS,
      presetId,
      await readMacroKinds(workspaceRoot)
    );
    if (prepared.status !== 'applied') return prepared;
    const kinds = prepared.kinds;
    await writeMacroKinds(workspaceRoot, kinds);
    return { status: 'applied', count: kinds.length };
  });
}

export type CreateMacroKindResult =
  | { status: 'created'; kind: MacroKind }
  | { status: 'noSnlDoc' }
  | { status: 'duplicate'; id: string }
  | { status: 'invalid'; message: string };

/**
 * Append a single new macro kind. Rejects duplicates by id and empty
 * ids/names. All other fields are stored verbatim.
 */
export async function createMacroKind(
  workspaceRoot: vscode.Uri,
  input: {
    id: string;
    name: string;
    description: string;
    coloring: ThemedKindColoring;
  }
): Promise<CreateMacroKindResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  return withExtensionWriterLock(workspaceRoot, 'create Macro kind', async () => {
    const id = (input.id ?? '').trim();
  const name = (input.name ?? '').trim();
  if (!id) {
    return { status: 'invalid', message: 'id is required' };
  }
  if (!name) {
    return { status: 'invalid', message: 'name is required' };
  }
  const existing = await readMacroKinds(workspaceRoot);
  if (existing.some((k) => k.id === id)) {
    return { status: 'duplicate', id };
  }
  const kind: MacroKind = {
    id,
    name,
    description: (input.description ?? '').trim(),
    coloring: fillKindColoringDefaults(input.coloring)
  };
    await writeMacroKinds(workspaceRoot, [...existing, kind]);
    return { status: 'created', kind };
  });
}

/**
 * Thin alias over {@link readMacroKinds} for the Create Macro webview, which
 * needs the kind catalog to populate its "Kind" dropdown.
 */
export async function listMacroKinds(
  workspaceRoot: vscode.Uri
): Promise<MacroKind[]> {
  return readMacroKinds(workspaceRoot);
}



/**
 * A single Entry in the shared `.SNL_Doc/entries.json` pool.
 *
 * Schema (see Plan.md §"Entry schema"):
 *  - `id`: UUID v4, unique across the pool.
 *  - `kind`: MUST reference an existing `entry_kinds[].id`.
 *  - `title`: invariant string or partial localized map.
 *  - `content`: at most one non-empty format in practice, but all optional —
 *    the editor lets the author fill any subset.
 *  - `contribution_info`: TEMPORARY single Contributor string. This shape may
 *    change; objects/arrays are deliberately unsupported. Missing values from
 *    older Entries remain readable.
 *  - `pointer`: schema deferred; stored verbatim.
 */
export interface EntryData {
  id: string;
  /** Immutable Package identity for per-entity storage; defaults to `_unpackaged`. */
  package?: string;
  kind: string;
  title: Localized<string, string>;
  content: {
    snl?: string;
    typst?: Localized<string, string>;
    latex?: Localized<string, string>;
    markdown?: Localized<string, string>;
    text?: Localized<string, string>;
  };
  /**
   * TEMPORARY Contributor write shape: exactly one string, or null/missing.
   * Legacy structured values remain readable and are preserved by unrelated
   * updates, but cannot be created or replaced through the scalar editor.
   * This is not a stable author/credit schema.
   */
  contribution_info?: unknown;
  // Optional structured pointer to a location in a source file (cat
  // 2026-07-11). `null` when unset. See src/pointer.ts for the shape
  // and resolver.
  pointer: import('./pointer').EntryPointer | null | unknown;
}

export type AddEntryResult =
  | { status: 'ok'; id: string; revision: string }
  | { status: 'duplicate'; id: string }
  | { status: 'unknownKind'; kind: string }
  | { status: 'invalid'; reason: string }
  | { status: 'noSnlDoc' }
  | { status: 'error'; message: string };

/**
 * Append a single {@link EntryData} to `.SNL_Doc/entries.json`, deduping by
 * id. Validates that the id is non-empty + unique, the `kind` references an
 * existing entry kind, the title is non-empty, and `content` is an object.
 *
 * The entries pool is a bare JSON array; a missing/corrupt file is treated as
 * empty so the first entry still lands cleanly.
 */
export async function addEntry(
  workspaceRoot: vscode.Uri,
  entry: EntryData
): Promise<AddEntryResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  try {
    return await withExtensionWriterLock(workspaceRoot, 'add Entry', async () => {
    // Establish writable schema/version mode before business-field validation;
    // future or malformed configs must never masquerade as unknownKind/invalid.
    await assertWorkspaceWritableOnDisk(workspaceRoot);
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
  const kind = typeof entry?.kind === 'string' ? entry.kind.trim() : '';
  let title: EntryData['title'];
  try {
    title = normalize_entry_title(entry?.title ?? '');
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }

  if (!id) {
    return { status: 'invalid', reason: 'id is required' };
  }
  if (!kind) {
    return { status: 'invalid', reason: 'kind is required' };
  }
  // content is now also optional. If unset or non-object, coerce to
  // `{ snl: '' }` so the on-disk row always parses.

  // kind must reference an existing entry kind.
  let kinds: EntryKind[];
  try {
    kinds = await readEntryKinds(workspaceRoot);
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  if (!kinds.some((k) => k.id === kind)) {
    return { status: 'unknownKind', kind };
  }

  // Refuse to write over a malformed existing pool. Missing is a valid empty
  // workspace state; corrupt/non-array JSON is not.
  let pool: EntryData[] = [];
  let entityRecords: EntryEntityRecord[] = [];
  const entityMode = await usesEntityStorage(workspaceRoot);
  const poolUri = entriesUri(workspaceRoot);
  if (entityMode) {
    try {
      entityRecords = await readEntryEntityRecords(entityReadStorage(workspaceRoot));
      pool = entityRecords.map(({ entry: current }) => current as unknown as EntryData);
    } catch (error) {
      return {
        status: 'invalid',
        reason: `Entry entity storage is malformed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  } else if (await exists(poolUri)) {
    let raw: unknown;
    try {
      raw = await readJson<unknown>(poolUri);
    } catch (error) {
      return {
        status: 'invalid',
        reason: `entries.json is malformed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    if (!Array.isArray(raw)) {
      return { status: 'invalid', reason: 'entries.json must contain an array' };
    }
    pool = raw as EntryData[];
  }

  if (pool.some((e) => e && typeof e === 'object' && e.id === id)) {
    return { status: 'duplicate', id };
  }

  let normalizedContent: EntryData['content'];
  try {
    normalizedContent = normalize_entry_content(entry.content);
  } catch (error) {
    return {
      status: 'invalid',
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  let contributor: string | null;
  try {
    contributor = normalizeEntryContributor(entry.contribution_info);
  } catch (error) {
    return {
      status: 'invalid',
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const packageId = typeof entry.package === 'string' && entry.package.trim()
    ? entry.package.trim()
    : UNPACKAGED_PACKAGE_ID;
  let entityPath: string | null = null;
  let ownerManifest: PackageManifestRecord | null = null;
  if (entityMode) {
    try {
      entityPath = entryEntityPath(packageId, id);
      // Canonical point reader validates format/version/schema/id/path before
      // any Entry or membership write is attempted.
      const storage = entityReadStorage(workspaceRoot);
      ownerManifest = await readPackageManifestRecord(storage, packageId);
      if (!ownerManifest) {
        return { status: 'invalid', reason: `Unknown Entry package: ${packageId}` };
      }
      await readIndexedPackageEntryRecords(storage, packageId, ownerManifest.manifest.entry_ids);
    } catch (error) {
      return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const record: EntryData = {
    id,
    ...(entityMode ? { package: packageId } : {}),
    kind,
    title,
    content: normalizedContent,
    contribution_info: contributor,
    pointer: entry.pointer ?? null
  };
  // Drop undefined content fields so entries.json stays tidy.
  for (const key of Object.keys(record.content) as Array<
    keyof EntryData['content']
  >) {
    if (record.content[key] === undefined) {
      delete record.content[key];
    }
  }

  try {
    if (entityMode && entityPath && ownerManifest) {
      await vscode.workspace.fs.createDirectory(entryEntitiesDirUri(workspaceRoot));
      const indexedIds = packageManifestEntryIds(ownerManifest.manifest);
      if (indexedIds === null) throw new Error(`Package ${JSON.stringify(packageId)} is missing entry_ids.`);
      const membershipRewrite = rewritePackageEntryMembership(ownerManifest, [...indexedIds, id]);
      await applyJsonFileOperations(workspaceRoot, `add Entry ${id}`, [
        {
          kind: 'write',
          uri: snlRelativeUri(workspaceRoot, entityPath),
          value: makeEntryEnvelope(packageId, record as unknown as Record<string, unknown>),
          expected: null
        },
        {
          kind: 'write',
          uri: snlRelativeUri(workspaceRoot, ownerManifest.path),
          value: membershipRewrite.value,
          expected: membershipRewrite.expected
        }
      ]);
    } else {
      await writeWorkspaceFile(
        workspaceRoot,
        entriesUri(workspaceRoot),
        jsonBytes([...pool, record]),
        pool
      );
    }
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
      return { status: 'ok', id, revision: entityRevision(record) };
    });
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Read the shared entry pool from `.SNL_Doc/entries.json`.
 *
 * Returns the parsed array of {@link EntryData}. Per-entity storage is strict:
 * malformed envelopes throw instead of masquerading as an empty workspace.
 * Legacy aggregate reads retain their best-effort `[]` fallback.
 */
export async function readEntries(
  workspaceRoot: vscode.Uri,
  knownEntityMode?: boolean
): Promise<EntryData[]> {
  const entityMode = knownEntityMode ?? await usesEntityStorage(workspaceRoot);
  if (entityMode) {
    try {
      const records = await readEntryEntityRecords(entityReadStorage(workspaceRoot));
      return records.map(({ entry }) => entry as unknown as EntryData);
    } catch (error) {
      throw new Error(
        `Could not read per-entity Entry storage: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  try {
    const raw = await readJson<unknown>(entriesUri(workspaceRoot));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (entry): entry is EntryData => entry !== null && typeof entry === 'object'
    );
  } catch {
    return [];
  }
}

async function readPackageEntryMembership(
  workspaceRoot: vscode.Uri,
  packageId: string
): Promise<{ manifestRecord: PackageManifestRecord | null; entryRecords: EntryEntityRecord[] }> {
  return withExtensionWriterLock(workspaceRoot, `read Entry Package ${packageId}`, async () => {
    const storage = entityReadStorage(workspaceRoot);
    const manifestRecord = await readPackageManifestRecord(storage, packageId);
    if (!manifestRecord) return { manifestRecord: null, entryRecords: [] };
    const indexedIds = packageManifestEntryIds(manifestRecord.manifest);
    if (indexedIds === null) {
      throw new Error(`Package ${JSON.stringify(packageId)} is missing its current Entry membership index.`);
    }
    return {
      manifestRecord,
      entryRecords: await readIndexedPackageEntryRecords(storage, packageId, indexedIds)
    };
  });
}

export interface EntryPackagePanelSnapshot {
  readonly selected:
    | { readonly status: 'ok'; readonly package: { readonly id: string; readonly name: string; readonly description: string }; readonly entries: readonly EntryData[] }
    | { readonly status: 'noPackage' };
  readonly entryKinds: readonly EntryKind[];
  readonly metricMacroSources: Readonly<Record<string, { source: { entries: string[]; urls: string[] } }>>;
}

/** Read one Entry Package for its management panel. The manifest is a point
 * read at its deterministic identity; Entry storage is validated fail-closed
 * before rows are filtered to the requested owner. No snapshot is retained. */
export async function readEntryPackagePanelSnapshot(
  workspaceRoot: vscode.Uri,
  packageId: string
): Promise<EntryPackagePanelSnapshot> {
  if (!(await usesEntityStorage(workspaceRoot))) {
    return {
      selected: packageId === UNPACKAGED_PACKAGE_ID
        ? { status: 'ok', package: { id: UNPACKAGED_PACKAGE_ID, name: UNPACKAGED_PACKAGE_ID, description: '' }, entries: await readEntries(workspaceRoot, false) }
        : { status: 'noPackage' },
      entryKinds: await readEntryKinds(workspaceRoot),
      metricMacroSources: {}
    };
  }
  const [{ manifestRecord, entryRecords }, entryKinds] = await Promise.all([
    readPackageEntryMembership(workspaceRoot, packageId),
    readEntryKinds(workspaceRoot)
  ]);
  if (!manifestRecord) {
    return { selected: { status: 'noPackage' }, entryKinds, metricMacroSources: {} };
  }
  return Object.freeze({
    selected: Object.freeze({
      status: 'ok' as const,
      package: Object.freeze({
        id: manifestRecord.manifest.id,
        name: manifestRecord.manifest.name,
        description: manifestRecord.manifest.description
      }),
      entries: Object.freeze(entryRecords.map(({ entry }) => entry as unknown as EntryData))
    }),
    entryKinds: Object.freeze([...entryKinds]),
    metricMacroSources: Object.freeze({})
  });
}

// ---------------------------------------------------------------------------
// Kind Presets — independently versioned JSON extension resources
// ---------------------------------------------------------------------------

export async function readWorkspaceSupportedLanguages(
  workspaceRoot: vscode.Uri
): Promise<SupportedLanguageDescriptor[]> {
  const uri = configUri(workspaceRoot);
  if (!(await exists(uri))) return supportedLanguagesFromConfig({});
  const raw = await readJson<unknown>(uri);
  return supportedLanguagesFromConfig(raw);
}

export type AddWorkspaceSupportedLanguageResult =
  | { status: 'added'; language: SupportedLanguageDescriptor }
  | { status: 'exists'; language: SupportedLanguageDescriptor }
  | { status: 'invalid'; message: string }
  | { status: 'noSnlDoc' };

export async function addWorkspaceSupportedLanguage(
  workspaceRoot: vscode.Uri,
  input: unknown
): Promise<AddWorkspaceSupportedLanguageResult> {
  let language: SupportedLanguageDescriptor;
  try {
    language = normalizeSupportedLanguage(input);
  } catch (error) {
    return { status: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
  if (!(await exists(configUri(workspaceRoot)))) return { status: 'noSnlDoc' };
  return withExtensionWriterLock(workspaceRoot, 'add supported language', async () => {
    const uri = configUri(workspaceRoot);
    const raw = await readJson<unknown>(uri);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { status: 'invalid', message: 'config.json must be an object' };
    }
    const existing = supportedLanguagesFromConfig(raw);
    const duplicate = existing.find((candidate) =>
      candidate.id.toLowerCase() === language.id.toLowerCase());
    if (duplicate) return { status: 'exists', language: duplicate };
    if (existing.length >= 100) {
      return { status: 'invalid', message: 'supported_languages may contain at most 100 entries' };
    }
    const original = structuredClone(raw);
    const next = raw as Record<string, unknown>;
    const stored = Array.isArray(next.supported_languages)
      ? structuredClone(next.supported_languages)
      : [];
    next.supported_languages = [...stored, language];
    await writeWorkspaceFile(workspaceRoot, uri, jsonBytes(next), original);
    return { status: 'added', language };
  });
}

export interface EntryKindPreset extends Omit<KindPresetPackage<'entry'>, 'kinds'> {
  kinds: EntryKind[];
}

export interface MacroKindPreset extends Omit<KindPresetPackage<'macro'>, 'kinds'> {
  kinds: MacroKind[];
}

const KIND_PRESET_RESOURCES = resolve(__dirname, '..', 'resources', 'kind-presets');

/** Validated at host startup; malformed, duplicate, or wrong-domain packages fail closed. */
export const ENTRY_KIND_PRESETS: EntryKindPreset[] =
  loadKindPresetPackages(KIND_PRESET_RESOURCES, 'entry');

/** Validated at host startup; language-specific macro packages are intentionally not invented. */
export const MACRO_KIND_PRESETS: MacroKindPreset[] =
  loadKindPresetPackages(KIND_PRESET_RESOURCES, 'macro');

// ---------------------------------------------------------------------------
// UPDATE ops
// ---------------------------------------------------------------------------
//
// Design rule: **identifiers are never edited via these paths.**
//   - EntryKind.id / MacroKind.id / EntryData.id are referenced elsewhere
//     (entries.json#kind → EntryKind.id; relationships → Entry.id; SNL source
//     → macro.name). Editing them would produce dangling references.
//   - MacroPackageFile "file" (bare filename) is also identity — rename ==
//     delete + recreate.
//   - Library.slug is identity — the on-disk directory name uses it.
//   - MacroPackageEntry.name is identity within its package.
// Edit panels enforce the readonly UX; these helpers additionally treat the
// identity parameter as the lookup key and silently ignore any conflicting
// value in the payload. If the requested identity does not exist, they
// return `notFound` so callers can surface a helpful error.

/** Union return shape for the "update by identity" family of ops. */
type UpdateResult<Ok, Extra = never> =
  | Ok
  | { status: 'noSnlDoc' }
  | { status: 'notFound'; id: string }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string }
  | Extra;

export type UpdateEntryKindResult = UpdateResult<
  { status: 'updated'; kind: EntryKind },
  { status: 'conflict'; id: string }
>;

/**
 * Update an existing entry kind IN PLACE, keyed by `id`. `id` itself is
 * never modified (it's the lookup key). Missing kinds → `notFound`.
 */
export async function updateEntryKind(
  workspaceRoot: vscode.Uri,
  id: string,
  input: {
    name: Localized<string, string>;
    description: Localized<string, string>;
    coloring: ThemedKindColoring;
    defaultCounterName: string;
    style: string;
  },
  expectedRevision?: string
): Promise<UpdateEntryKindResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  return withExtensionWriterLock(workspaceRoot, 'update entry kind', async () => {
    const targetId = (id ?? '').trim();
    if (!targetId) return { status: 'invalid', message: 'id is required' };
    let name: Localized<string, string>;
    let description: Localized<string, string>;
    try {
      name = normalize_kind_label(input.name, 'Entry Kind name', true);
      description = normalize_kind_label(input.description ?? '', 'Entry Kind description', false);
    } catch (error) {
      return { status: 'invalid', message: error instanceof Error ? error.message : String(error) };
    }
    const existing = await readEntryKinds(workspaceRoot);
    const idx = existing.findIndex((kind) => kind.id === targetId);
    if (idx < 0) return { status: 'notFound', id: targetId };
    if (typeof expectedRevision !== 'string' || entityRevision(existing[idx]) !== expectedRevision) {
      return { status: 'conflict', id: targetId };
    }
    const next: EntryKind = {
      ...existing[idx],
      id: targetId,
      name,
      description,
      coloring: mergeThemedKindColoring(
        existing[idx].coloring,
        fillKindColoringDefaults(input.coloring)
      ),
      defaultCounterName: (input.defaultCounterName ?? '').trim(),
      style: (input.style ?? '').trim()
    };
    const kinds = existing.slice();
    kinds[idx] = next;
    await writeEntryKinds(workspaceRoot, kinds);
    return { status: 'updated', kind: next };
  });
}

export type UpdateMacroKindResult = UpdateResult<
  { status: 'updated'; kind: MacroKind },
  { status: 'conflict'; id: string }
>;

/**
 * Update an existing macro kind IN PLACE, keyed by `id`. `id` itself is
 * never modified. Missing kinds → `notFound`.
 */
export async function updateMacroKind(
  workspaceRoot: vscode.Uri,
  id: string,
  input: {
    name: string;
    description: string;
    coloring: ThemedKindColoring;
  },
  expectedRevision?: string
): Promise<UpdateMacroKindResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  return withExtensionWriterLock(workspaceRoot, 'update Macro kind', async () => {
    const targetId = (id ?? '').trim();
  if (!targetId) {
    return { status: 'invalid', message: 'id is required' };
  }
  const name = (input.name ?? '').trim();
  if (!name) {
    return { status: 'invalid', message: 'name is required' };
  }
  const existing = await readMacroKinds(workspaceRoot);
  const idx = existing.findIndex((k) => k.id === targetId);
  if (idx < 0) {
    return { status: 'notFound', id: targetId };
  }
  if (typeof expectedRevision !== 'string' || entityRevision(existing[idx]) !== expectedRevision) {
    return { status: 'conflict', id: targetId };
  }
  const next: MacroKind = {
    ...existing[idx],
    id: targetId,
    name,
    description: (input.description ?? '').trim(),
    coloring: mergeThemedKindColoring(
      existing[idx].coloring,
      fillKindColoringDefaults(input.coloring)
    )
  };
  const kinds = existing.slice();
  kinds[idx] = next;
    await writeMacroKinds(workspaceRoot, kinds);
    return { status: 'updated', kind: next };
  });
}

export type UpdateLibraryResult = UpdateResult<
  { status: 'updated'; slug: string; title: string },
  { status: 'conflict'; id: string }
>;

/**
 * Update a library's meta IN PLACE, keyed by `slug`. Currently only `title`
 * is editable; `slug` is the identity (directory name) and never changes.
 * Missing library directory → `notFound`. Writes `libraries/<slug>/meta.json`;
 * does NOT touch `config.json` (per cat 2026-07-06).
 */
export async function updateLibrary(
  workspaceRoot: vscode.Uri,
  slug: string,
  input: { title: string; description?: string },
  expectedRevision?: string
): Promise<UpdateLibraryResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  const targetSlug = (slug ?? '').trim();
  if (!targetSlug || targetSlug !== slug || slugify(targetSlug) !== targetSlug) {
    return { status: 'invalid', message: 'slug must be one canonical Library path segment' };
  }
  const title = (input.title ?? '').trim();
  if (!title) {
    return { status: 'invalid', message: 'title is required' };
  }
  const libDir = libraryDirUri(workspaceRoot, targetSlug);
  if (!(await exists(libDir))) {
    return { status: 'notFound', id: targetSlug };
  }

  // Merge into existing meta if present so we preserve unknown fields. Missing
  // may initialize; malformed or unreadable bytes must fail closed.
  const metaUri = libraryMetaUri(workspaceRoot, targetSlug);
  let existing: LibraryMetaFile = {};
  let expected: unknown = null;
  if (await exists(metaUri)) {
    const raw = await readJson<unknown>(metaUri);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`libraries/${targetSlug}/meta.json must be a JSON object.`);
    }
    existing = raw as LibraryMetaFile;
    expected = raw;
  }
  if (typeof expectedRevision !== 'string' || entityRevision(expected) !== expectedRevision) {
    return { status: 'conflict', id: targetSlug };
  }
  const next: LibraryMetaFile = {
    ...existing,
    title
  };
  if (typeof input.description === 'string') {
    next.description = input.description;
  }
  await writeWorkspaceFile(
    workspaceRoot,
    metaUri,
    jsonBytes(next),
    expected
  );
  return { status: 'updated', slug: targetSlug, title };
}

export type UpdateEntryResult = UpdateResult<
  { status: 'updated'; id: string; revision: string },
  { status: 'unknownKind'; kind: string }
>;

/**
 * Update an existing {@link EntryData} in the shared pool IN PLACE, keyed by
 * `id`. `id` itself is never modified. `kind` must still reference an
 * existing entry kind. Missing entries → `notFound`.
 */
export async function updateEntry(
  workspaceRoot: vscode.Uri,
  id: string,
  entry: Omit<EntryData, 'id'>,
  expectedRevision?: string
): Promise<UpdateEntryResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  return withExtensionWriterLock(workspaceRoot, 'update Entry', async () => {
    const targetId = (id ?? '').trim();
  if (!targetId) {
    return { status: 'invalid', message: 'id is required' };
  }
  const kind = typeof entry?.kind === 'string' ? entry.kind.trim() : '';
  let title: EntryData['title'];
  try {
    title = normalize_entry_title(entry?.title ?? '');
  } catch (error) {
    return { status: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
  if (!kind) {
    return { status: 'invalid', message: 'kind is required' };
  }
  const kinds = await readEntryKinds(workspaceRoot);
  if (!kinds.some((k) => k.id === kind)) {
    return { status: 'unknownKind', kind };
  }

  const entityMode = await usesEntityStorage(workspaceRoot);
  let entityRecord: Awaited<ReturnType<typeof readEntryEntityRecords>>[number] | undefined;
  let entityRecords: EntryEntityRecord[] = [];
  let pool: EntryData[] = [];
  if (entityMode) {
    entityRecords = await readEntryEntityRecords(entityReadStorage(workspaceRoot));
    entityRecord = entityRecords.find(({ entry: current }) => current.id === targetId);
    pool = entityRecords.map(({ entry: current }) => current as unknown as EntryData);
  } else {
    try {
      const raw = await readJson<unknown>(entriesUri(workspaceRoot));
      if (Array.isArray(raw)) pool = raw as EntryData[];
    } catch {
      pool = [];
    }
  }
  const idx = pool.findIndex((e) => e && typeof e === 'object' && e.id === targetId);
  if (idx < 0) {
    return { status: 'notFound', id: targetId };
  }
  if (typeof expectedRevision !== 'string' || entityRevision(pool[idx]) !== expectedRevision) {
    return {
      status: 'error',
      message: `Entry ${JSON.stringify(targetId)} changed after this editor loaded; refresh before saving.`
    };
  }

  let normalizedContent: EntryData['content'];
  try {
    normalizedContent = normalize_entry_content(entry.content);
  } catch (error) {
    return {
      status: 'invalid',
      message: error instanceof Error ? error.message : String(error)
    };
  }
  let contributor: unknown;
  try {
    contributor = normalizeUpdatedEntryContributor(
      entry.contribution_info,
      pool[idx].contribution_info
    );
  } catch (error) {
    return {
      status: 'invalid',
      message: error instanceof Error ? error.message : String(error)
    };
  }
  const currentPackageId = pool[idx].package ?? UNPACKAGED_PACKAGE_ID;
  const packageId = entityMode && typeof entry.package === 'string' && entry.package.trim()
    ? entry.package.trim()
    : currentPackageId;
  let destinationManifest: PackageManifestRecord | null = null;
  let currentManifest: PackageManifestRecord | null = null;
  if (entityMode) {
    try {
      packageManifestPath(packageId);
      const storage = entityReadStorage(workspaceRoot);
      destinationManifest = await readPackageManifestRecord(storage, packageId);
      if (!destinationManifest) {
        return { status: 'invalid', message: `Package ${JSON.stringify(packageId)} does not exist` };
      }
      currentManifest = packageId === currentPackageId
        ? destinationManifest
        : await readPackageManifestRecord(storage, currentPackageId);
      if (!currentManifest) {
        return { status: 'invalid', message: `Package ${JSON.stringify(currentPackageId)} does not exist` };
      }
      await readIndexedPackageEntryRecords(
        storage, currentPackageId, currentManifest.manifest.entry_ids
      );
      if (destinationManifest !== currentManifest) {
        await readIndexedPackageEntryRecords(
          storage, packageId, destinationManifest.manifest.entry_ids
        );
      }
    } catch (error) {
      return { status: 'invalid', message: error instanceof Error ? error.message : String(error) };
    }
  }
  const mergedContent = {
    ...(pool[idx].content as Record<string, unknown>)
  } as Record<string, unknown>;
  for (const key of ['snl', 'typst', 'latex', 'markdown', 'text'] as const) {
    if (normalizedContent[key] === undefined) delete mergedContent[key];
    else mergedContent[key] = normalizedContent[key];
  }
  const record: EntryData = {
    ...pool[idx],
    id: targetId,
    ...(entityMode ? { package: packageId } : {}),
    kind,
    title,
    content: mergedContent as EntryData['content'],
    contribution_info: contributor,
    pointer: entry.pointer ?? null
  };
  for (const key of Object.keys(record.content) as Array<
    keyof EntryData['content']
  >) {
    if (record.content[key] === undefined) {
      delete record.content[key];
    }
  }

  const next = pool.slice();
  next[idx] = record;
  try {
    if (entityMode && entityRecord) {
      const rewrite = rewriteEntryEntityRecord(
        entityRecord,
        packageId,
        record as unknown as Record<string, unknown>
      );
      if (packageId === currentPackageId) {
        await writeWorkspaceFile(
          workspaceRoot,
          snlRelativeUri(workspaceRoot, entityRecord.path),
          jsonBytes(rewrite.value),
          rewrite.expected
        );
      } else if (currentManifest && destinationManifest) {
        const currentIds = packageManifestEntryIds(currentManifest.manifest);
        const destinationIds = packageManifestEntryIds(destinationManifest.manifest);
        if (currentIds === null || destinationIds === null) {
          throw new Error('Current Package membership index is missing.');
        }
        const currentMembership = rewritePackageEntryMembership(
          currentManifest,
          currentIds.filter((entryId) => entryId !== targetId)
        );
        const destinationMembership = rewritePackageEntryMembership(
          destinationManifest,
          [...destinationIds, targetId]
        );
        await applyJsonFileOperations(workspaceRoot, `move Entry ${targetId}`, [
          {
            kind: 'write',
            uri: snlRelativeUri(workspaceRoot, entryEntityPath(packageId, targetId)),
            value: rewrite.value,
            expected: null
          },
          {
            kind: 'write',
            uri: snlRelativeUri(workspaceRoot, destinationManifest.path),
            value: destinationMembership.value,
            expected: destinationMembership.expected
          },
          {
            kind: 'write',
            uri: snlRelativeUri(workspaceRoot, currentManifest.path),
            value: currentMembership.value,
            expected: currentMembership.expected
          },
          {
            kind: 'delete',
            uri: snlRelativeUri(workspaceRoot, entityRecord.path),
            expected: rewrite.expected
          }
        ]);
      }
    } else {
      await writeWorkspaceFile(workspaceRoot, entriesUri(workspaceRoot), jsonBytes(next), pool);
    }
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
    return { status: 'updated', id: targetId, revision: entityRevision(record) };
  });
}

export type UpdateMacroPackageResult = UpdateResult<
  { status: 'updated'; file: string; name: string }
>;

/**
 * Update a macro package's METADATA (name / description) IN PLACE. `file` is
 * the identity — this does NOT rename the package file. To rename, delete
 * and recreate. Macros inside the package are NOT touched by this call —
 * use {@link updateMacro} / {@link addMacro} for per-macro edits.
 */
export async function updateMacroPackage(
  workspaceRoot: vscode.Uri,
  file: string,
  input: { name: string; description: string },
  expectedRevision?: string
): Promise<UpdateMacroPackageResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  const bare = typeof file === 'string' ? stripJsonExt(file.trim()) : '';
  if (!MACRO_FILE_RE.test(bare)) {
    return {
      status: 'invalid',
      message: 'file must be a Windows-safe Package ID ([A-Za-z0-9][A-Za-z0-9._-]*)'
    };
  }
  const name = (input.name ?? '').trim();
  if (!name) {
    return { status: 'invalid', message: 'name is required' };
  }

  const read = await readMacroPackage(workspaceRoot, bare);
  if (read.status === 'noFile') {
    return { status: 'notFound', id: `${bare}.json` };
  }
  if (read.status === 'error') {
    return { status: 'error', message: read.message };
  }
  if (typeof expectedRevision !== 'string' || macroPackageMetadataRevision(read.raw) !== expectedRevision) {
    return {
      status: 'error',
      message: `Macro Package ${JSON.stringify(bare)} changed after this editor loaded; refresh before saving.`
    };
  }

  const next: MacroPackageFile = {
    ...read.pkg,
    name
  };
  const desc = (input.description ?? '').trim();
  if (desc) {
    next.description = desc;
  } else {
    delete next.description;
  }

  try {
    await persistMacroPackage(workspaceRoot, bare, next, read.raw);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'updated', file: `${bare}.json`, name };
}

export type UpdateMacroResult = UpdateResult<
  { status: 'updated'; name: string }
>;

/**
 * Update an existing macro inside a package IN PLACE, keyed by `macro.name`.
 * The macro name is identity — rename == delete + recreate. All other fields
 * (styles / description / source / kind / arity) are replaced. Missing
 * macros → `notFound`. The write preserves insertion order in the package
 * map (the on-disk `macros` object is rebuilt entry-by-entry).
 */
export async function updateMacro(
  workspaceRoot: vscode.Uri,
  file: string,
  macro: MacroPackageEntry,
  expectedRevision?: string
): Promise<UpdateMacroResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  const reason = validateMacro(macro);
  if (reason) {
    return { status: 'invalid', message: reason };
  }

  const read = await readMacroPackage(workspaceRoot, file);
  if (read.status === 'noFile') {
    return { status: 'notFound', id: file };
  }
  if (read.status === 'error') {
    return { status: 'error', message: read.message };
  }

  const name = macro.name.trim();
  if (!Object.prototype.hasOwnProperty.call(read.pkg.macros, name)) {
    return { status: 'notFound', id: name };
  }
  const currentMacro = read.macros.find((candidate) => candidate.name === name);
  if (typeof expectedRevision !== 'string' || !currentMacro || entityRevision(currentMacro) !== expectedRevision) {
    return {
      status: 'error',
      message: `Macro ${JSON.stringify(name)} changed after this editor loaded; refresh before saving.`
    };
  }

  // Rebuild the map preserving insertion order — plain object iteration in
  // V8 preserves insertion order for string keys, so simply replacing the
  // value under `name` keeps its position in the file.
  const { name: _drop, ...rest } = macro;
  const nextMacros: Record<string, MacroPackageEntryWithoutName> = {};
  for (const [key, val] of Object.entries(read.pkg.macros)) {
    setOwnRecordValue(nextMacros, key, key === name ? { ...rest } : val);
  }
  const next: MacroPackageFile = { ...read.pkg, macros: nextMacros };

  try {
    await persistMacroPackage(workspaceRoot, stripJsonExt(file), next, read.raw);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'updated', name };
}

// ---------------------------------------------------------------------------
// Macro packages: multi-select batch ops
// ---------------------------------------------------------------------------

/**
 * Remove a set of macros (by name) from a single package in one atomic write.
 * Names not present are ignored. Reuses {@link readMacroPackage} for the read
 * and the canonical {@link jsonBytes} write — no bespoke round-trip logic.
 */
export async function batchDeleteMacros(
  workspaceRoot: vscode.Uri,
  sourceFile: string,
  names: string[]
): Promise<
  | { status: 'ok'; deletedCount: number }
  | { status: 'noFile' }
  | { status: 'error'; message: string }
> {
  const wanted = new Set(
    (Array.isArray(names) ? names : []).filter(
      (n) => typeof n === 'string' && n.length > 0
    )
  );
  const read = await readMacroPackage(workspaceRoot, sourceFile);
  if (read.status === 'noFile') {
    return { status: 'noFile' };
  }
  if (read.status === 'error') {
    return { status: 'error', message: read.message };
  }

  const nextMacros: Record<string, MacroPackageEntryWithoutName> = {};
  let deletedCount = 0;
  for (const [key, val] of Object.entries(read.pkg.macros)) {
    if (wanted.has(key)) {
      deletedCount += 1;
      continue;
    }
    setOwnRecordValue(nextMacros, key, val);
  }

  const next: MacroPackageFile = { ...read.pkg, macros: nextMacros };
  try {
    await persistMacroPackage(workspaceRoot, stripJsonExt(sourceFile), next, read.raw);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'ok', deletedCount };
}

/**
 * Move a set of macros from a source package to a destination package
 * (delete from source, add to destination). If the destination already
 * contains any of the named macros the whole batch is refused and NO writes
 * happen (`conflict`) — name-conflict resolution is a later feature. Names
 * not present in the source are skipped.
 */
export async function batchMoveMacros(
  workspaceRoot: vscode.Uri,
  sourceFile: string,
  destFile: string,
  names: string[]
): Promise<
  | { status: 'ok'; movedCount: number }
  | { status: 'conflict'; conflictNames: string[] }
  | { status: 'noFile'; which: 'source' | 'dest' }
  | { status: 'error'; message: string }
> {
  const srcBare = stripJsonExt(sourceFile);
  const destBare = stripJsonExt(destFile);
  if (srcBare === destBare) {
    return { status: 'error', message: 'source and destination are the same package' };
  }
  const wanted = (Array.isArray(names) ? names : []).filter(
    (n) => typeof n === 'string' && n.length > 0
  );

  const srcRead = await readMacroPackage(workspaceRoot, srcBare);
  if (srcRead.status === 'noFile') {
    return { status: 'noFile', which: 'source' };
  }
  if (srcRead.status === 'error') {
    return { status: 'error', message: srcRead.message };
  }
  const destRead = await readMacroPackage(workspaceRoot, destBare);
  if (destRead.status === 'noFile') {
    return { status: 'noFile', which: 'dest' };
  }
  if (destRead.status === 'error') {
    return { status: 'error', message: destRead.message };
  }

  // Only move names that actually live in the source.
  const moving = wanted.filter((n) =>
    Object.prototype.hasOwnProperty.call(srcRead.pkg.macros, n)
  );
  // Refuse the whole batch on any destination-side name collision.
  const conflictNames = moving.filter((n) =>
    Object.prototype.hasOwnProperty.call(destRead.pkg.macros, n)
  );
  if (conflictNames.length > 0) {
    return { status: 'conflict', conflictNames };
  }

  const movingSet = new Set(moving);
  const nextSrcMacros: Record<string, MacroPackageEntryWithoutName> = {};
  for (const [key, val] of Object.entries(srcRead.pkg.macros)) {
    if (movingSet.has(key)) continue;
    setOwnRecordValue(nextSrcMacros, key, val);
  }
  const nextDestMacros: Record<string, MacroPackageEntryWithoutName> = {
    ...destRead.pkg.macros
  };
  for (const n of moving) {
    setOwnRecordValue(nextDestMacros, n, srcRead.pkg.macros[n]);
  }

  const nextSrc: MacroPackageFile = { ...srcRead.pkg, macros: nextSrcMacros };
  const nextDest: MacroPackageFile = { ...destRead.pkg, macros: nextDestMacros };
  try {
    await withExtensionWriterLock(workspaceRoot, `move Macros ${srcBare} to ${destBare}`, async () => {
      const entityMode = await usesEntityStorage(workspaceRoot);
      const sourceEnvelopes = entityMode
        ? new Map((await readMacroEntityRecords(entityReadStorage(workspaceRoot)))
            .filter(({ envelope }) => envelope.package === srcBare)
            .map(({ macro, envelope }) => [macro.name, envelope]))
        : new Map<string, MacroEnvelope>();
      const operations = entityMode
        ? [
            ...await buildMacroPackageOperations(
              workspaceRoot,
              destBare,
              nextDest,
              destRead.raw,
              sourceEnvelopes
            ),
            ...await buildMacroPackageOperations(workspaceRoot, srcBare, nextSrc, srcRead.raw)
          ]
        : [
            {
              kind: 'write' as const,
              uri: macroPackageUri(workspaceRoot, destBare),
              value: nextDest,
              expected: destRead.raw
            },
            {
              kind: 'write' as const,
              uri: macroPackageUri(workspaceRoot, srcBare),
              value: nextSrc,
              expected: srcRead.raw
            }
          ];
      await applyJsonFileOperations(workspaceRoot, `move Macros ${srcBare} to ${destBare}`, operations);
    });
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'ok', movedCount: moving.length };
}

/**
 * Copy a set of macros from a source package into a BRAND-NEW package. The
 * source package is NOT modified (copy-out, not move-out). Reuses
 * {@link createMacroPackage} (which validates the bare filename, rejects
 * duplicates, and appends the new package to `active_macro_packages`) and
 * {@link addMacro} for each copied macro.
 */
export async function batchPackageAsNew(
  workspaceRoot: vscode.Uri,
  sourceFile: string,
  names: string[],
  newFile: string,
  newDisplayName?: string,
  newDescription?: string,
  moveSource = false
): Promise<
  | { status: 'ok'; file: string; copiedCount: number }
  | { status: 'noFile' }
  | { status: 'duplicate'; file: string }
  | { status: 'invalid'; reason: string }
  | { status: 'error'; message: string }
> {
  const wanted = new Set(
    (Array.isArray(names) ? names : []).filter(
      (n) => typeof n === 'string' && n.length > 0
    )
  );
  const read = await readMacroPackage(workspaceRoot, sourceFile);
  if (read.status === 'noFile') {
    return { status: 'noFile' };
  }
  if (read.status === 'error') {
    return { status: 'error', message: read.message };
  }

  const selected = read.macros.filter((m) => wanted.has(m.name));
  if (selected.length === 0) {
    return { status: 'invalid', reason: 'no matching macros selected' };
  }

  const bare = typeof newFile === 'string' ? newFile.trim() : '';
  if (!MACRO_FILE_RE.test(bare)) {
    return {
      status: 'invalid',
      reason: 'file must be a Windows-safe Package ID ([A-Za-z0-9][A-Za-z0-9._-]*)'
    };
  }
  const displayName =
    (typeof newDisplayName === 'string' && newDisplayName.trim()) || bare;

  try {
    await withExtensionWriterLock(workspaceRoot, `copy Macros into new Package ${bare}`, async () => {
      const currentSource = await readMacroPackage(workspaceRoot, sourceFile);
      if (currentSource.status !== 'ok') throw new Error('source Macro Package changed or disappeared');
      assertJsonSnapshotUnchanged(read.raw, currentSource.raw, `${sourceFile}.json`);
      const configRaw = await readJson<unknown>(configUri(workspaceRoot));
      if (!configRaw || typeof configRaw !== 'object' || Array.isArray(configRaw)) {
        throw new Error('config.json must be an object');
      }
      const entityMode = await usesEntityStorage(workspaceRoot);
      const packageNames = await listMacroPackageNames(workspaceRoot, entityMode, true);
      const foldedCollision = packageNames.find((name) => name.toLowerCase() === bare.toLowerCase());
      if (foldedCollision) throw new Error(`Macro Package ${foldedCollision} already exists.`);
      const active = new Set(resolveActiveFromConfig(packageNames, normalizeConfig(configRaw)));
      active.add(bare);
      const nextConfig = {
        ...configRaw,
        active_macro_packages: [...active].sort((left, right) => left.localeCompare(right))
      };
      const operations: JsonFileOperation[] = [];
      if (entityMode) {
        const sourceBare = stripJsonExt(sourceFile);
        const sourceRecords = await readMacroEntityRecords(entityReadStorage(workspaceRoot));
        const sourceEnvelopes = new Map(
          sourceRecords
            .filter(({ envelope }) => envelope.package === sourceBare)
            .map(({ macro, envelope }) => [macro.name, envelope])
        );
        operations.push({
          kind: 'write',
          uri: snlRelativeUri(workspaceRoot, packageManifestPath(bare)),
          value: makePackageManifest(
            bare,
            displayName,
            typeof newDescription === 'string' ? newDescription.trim() : ''
          ),
          expected: null
        });
        for (const macro of selected) {
          operations.push({
            kind: 'write',
            uri: snlRelativeUri(workspaceRoot, macroEntityPath(bare, macro.name)),
            value: {
              ...(sourceEnvelopes.get(macro.name) ?? {}),
              ...makeMacroEnvelope(bare, macro as unknown as Record<string, unknown>)
            },
            expected: null
          });
        }
      } else {
        const macros: Record<string, MacroPackageEntryWithoutName> = {};
        for (const macro of selected) {
          const { name, ...value } = macro;
          setOwnRecordValue(macros, name, value);
        }
        operations.push({
          kind: 'write',
          uri: macroPackageUri(workspaceRoot, bare),
          value: {
            version: MACRO_PACKAGE_VERSION,
            name: displayName,
            ...(typeof newDescription === 'string' && newDescription.trim()
              ? { description: newDescription.trim() }
              : {}),
            macros
          },
          expected: null
        });
      }
      if (moveSource) {
        const selectedNames = new Set(selected.map((macro) => macro.name));
        const remainingMacros: Record<string, MacroPackageEntryWithoutName> = {};
        for (const [name, value] of Object.entries(currentSource.pkg.macros)) {
          if (!selectedNames.has(name)) setOwnRecordValue(remainingMacros, name, value);
        }
        const nextSource: MacroPackageFile = { ...currentSource.pkg, macros: remainingMacros };
        if (entityMode) {
          operations.push(...await buildMacroPackageOperations(
            workspaceRoot,
            stripJsonExt(sourceFile),
            nextSource,
            currentSource.raw
          ));
        } else {
          operations.push({
            kind: 'write',
            uri: macroPackageUri(workspaceRoot, stripJsonExt(sourceFile)),
            value: nextSource,
            expected: currentSource.raw
          });
        }
      }
      operations.push({
        kind: 'write',
        uri: configUri(workspaceRoot),
        value: nextConfig,
        expected: configRaw
      });
      await applyJsonFileOperations(workspaceRoot, `copy Macros into new Package ${bare}`, operations);
    });
    return { status: 'ok', file: `${bare}.json`, copiedCount: selected.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already exists/i.test(message)) return { status: 'duplicate', file: `${bare}.json` };
    return { status: 'error', message };
  }
}

/**
 * Copy a set of macros from a source package into an EXISTING destination
 * package (source is NOT modified). If the destination already contains any
 * of the named macros the whole batch is refused and NO writes happen
 * (`conflict`) — mirrors the {@link batchMoveMacros} conflict policy so both
 * transfer flavors behave the same. Names not present in the source are
 * silently skipped.
 */
export async function batchCopyMacros(
  workspaceRoot: vscode.Uri,
  sourceFile: string,
  destFile: string,
  names: string[]
): Promise<
  | { status: 'ok'; copiedCount: number }
  | { status: 'conflict'; conflictNames: string[] }
  | { status: 'noFile'; which: 'source' | 'dest' }
  | { status: 'error'; message: string }
> {
  const srcBare = stripJsonExt(sourceFile);
  const destBare = stripJsonExt(destFile);
  if (srcBare === destBare) {
    return {
      status: 'error',
      message: 'source and destination are the same package'
    };
  }
  const wanted = (Array.isArray(names) ? names : []).filter(
    (n) => typeof n === 'string' && n.length > 0
  );

  const srcRead = await readMacroPackage(workspaceRoot, srcBare);
  if (srcRead.status === 'noFile') {
    return { status: 'noFile', which: 'source' };
  }
  if (srcRead.status === 'error') {
    return { status: 'error', message: srcRead.message };
  }
  const destRead = await readMacroPackage(workspaceRoot, destBare);
  if (destRead.status === 'noFile') {
    return { status: 'noFile', which: 'dest' };
  }
  if (destRead.status === 'error') {
    return { status: 'error', message: destRead.message };
  }

  // Only copy names that actually live in the source.
  const copying = wanted.filter((n) =>
    Object.prototype.hasOwnProperty.call(srcRead.pkg.macros, n)
  );
  // Refuse the whole batch on any destination-side name collision.
  const conflictNames = copying.filter((n) =>
    Object.prototype.hasOwnProperty.call(destRead.pkg.macros, n)
  );
  if (conflictNames.length > 0) {
    return { status: 'conflict', conflictNames };
  }

  const nextDestMacros: Record<string, MacroPackageEntryWithoutName> = {
    ...destRead.pkg.macros
  };
  for (const n of copying) {
    setOwnRecordValue(nextDestMacros, n, srcRead.pkg.macros[n]);
  }

  const nextDest: MacroPackageFile = {
    ...destRead.pkg,
    macros: nextDestMacros
  };
  try {
    await withExtensionWriterLock(workspaceRoot, `copy Macros ${srcBare} to ${destBare}`, async () => {
      const currentSource = await readMacroPackage(workspaceRoot, srcBare);
      if (currentSource.status !== 'ok') throw new Error('source Macro Package changed or disappeared');
      assertJsonSnapshotUnchanged(srcRead.raw, currentSource.raw, `${srcBare}.json`);
      if (await usesEntityStorage(workspaceRoot)) {
        const sourceEnvelopes = new Map(
          (await readMacroEntityRecords(entityReadStorage(workspaceRoot)))
            .filter(({ envelope }) => envelope.package === srcBare)
            .map(({ macro, envelope }) => [macro.name, envelope])
        );
        const operations = await buildMacroPackageOperations(
          workspaceRoot,
          destBare,
          nextDest,
          destRead.raw,
          sourceEnvelopes
        );
        await applyJsonFileOperations(workspaceRoot, `copy Macros ${srcBare} to ${destBare}`, operations);
      } else {
        await applyJsonFileOperations(workspaceRoot, `copy Macros ${srcBare} to ${destBare}`, [{
          kind: 'write',
          uri: macroPackageUri(workspaceRoot, destBare),
          value: nextDest,
          expected: destRead.raw
        }]);
      }
    });
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'ok', copiedCount: copying.length };
}

/**
 * Move a set of macros from a source package into a BRAND-NEW package (the
 * source-side entries are removed). Composed from {@link batchPackageAsNew}
 * (create+copy) followed by {@link batchDeleteMacros} on the source — if the
 * source-side delete fails after the destination package was created, the
 * new package is left in place (macros exist in both) rather than lost.
 */
export async function batchMoveToNewPackage(
  workspaceRoot: vscode.Uri,
  sourceFile: string,
  names: string[],
  newFile: string,
  newDisplayName?: string,
  newDescription?: string
): Promise<
  | { status: 'ok'; file: string; movedCount: number }
  | { status: 'noFile' }
  | { status: 'duplicate'; file: string }
  | { status: 'invalid'; reason: string }
  | { status: 'error'; message: string }
> {
  const created = await batchPackageAsNew(
    workspaceRoot,
    sourceFile,
    names,
    newFile,
    newDisplayName,
    newDescription,
    true
  );
  if (created.status !== 'ok') {
    return created;
  }
  return {
    status: 'ok',
    file: created.file,
    movedCount: created.copiedCount
  };
}

// ---------------------------------------------------------------------------
// Library discovery / meta (filesystem is the source of truth)
// ---------------------------------------------------------------------------

/** Summary produced by {@link listLibraries}: one entry per on-disk library
 *  directory. `title` falls back to the slug when meta.json is missing or
 *  doesn't carry a `title` field. */
export interface LibraryEntry {
  slug: string;
  title: string;
  description?: string;
  /** True iff `meta.json` exists AND parsed. False on missing/malformed
   *  meta — the caller may want to surface "imported, needs meta" affordance. */
  hasMeta: boolean;
}

/**
 * Enumerate `.SNL_Doc/libraries/*​/` on disk and return one summary per
 * subdirectory. Missing `.SNL_Doc/libraries/` (or missing `.SNL_Doc/` at
 * all) → `[]`. Hidden dotfiles (`.gitkeep`) and non-directory entries are
 * skipped. Results are sorted alphabetically by slug for deterministic UI.
 *
 * This is the SOURCE OF TRUTH for "which libraries exist" as of 2026-07-06:
 * `config.json#libraries` is no longer consulted. Pasting a folder in from
 * another workspace = the folder shows up here immediately, no config edit
 * needed. Deleting a folder = it disappears here immediately, no config
 * cleanup needed.
 */
export async function listLibraries(
  workspaceRoot: vscode.Uri
): Promise<LibraryEntry[]> {
  const slugs = await listLibraryDirNames(workspaceRoot);
  // Read the metas concurrently — they are independent files and the serial
  // `await` in a loop was pure latency on every Dashboard open. The output
  // order is re-established by the sort below, so it stays deterministic
  // regardless of which read settles first.
  // Cat 2026-07-25: "所有 Dashboard 相关的基本都慢".
  const out = await Promise.all(
    slugs.map((name) => readLibraryEntry(workspaceRoot, name))
  );
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

/** Directory names under `.SNL_Doc/libraries/`, without reading any file. */
async function listLibraryDirNames(
  workspaceRoot: vscode.Uri
): Promise<string[]> {
  const fsApi = vscode.workspace.fs;
  const dir = librariesDirUri(workspaceRoot);
  if (!(await exists(dir))) {
    return [];
  }

  let entries: [string, vscode.FileType][];
  try {
    entries = await fsApi.readDirectory(dir);
  } catch {
    return [];
  }

  return entries
    .filter(
      ([name, type]) =>
        type === vscode.FileType.Directory && !name.startsWith('.')
    )
    .map(([name]) => name);
}

/** One library summary, folding in `meta.json` best-effort. */
async function readLibraryEntry(
  workspaceRoot: vscode.Uri,
  name: string
): Promise<LibraryEntry> {
  const summary: LibraryEntry = {
    slug: name,
    title: name, // fallback: slug becomes the display title
    hasMeta: false
  };
  try {
    const raw = await readJson<LibraryMetaFile>(
      libraryMetaUri(workspaceRoot, name)
    );
    if (raw && typeof raw === 'object') {
      summary.hasMeta = true;
      if (typeof raw.title === 'string' && raw.title.trim().length > 0) {
        summary.title = raw.title.trim();
      }
      if (typeof raw.description === 'string') {
        summary.description = raw.description;
      }
    }
  } catch {
    // Missing / malformed meta.json → keep hasMeta:false, use slug as title.
  }
  return summary;
}

/**
 * Read `libraries/<slug>/meta.json` and return the normalized shape. Missing
 * file → `{status: 'noFile'}`. Malformed / unreadable → `{status: 'error'}`.
 */
export async function readLibraryMeta(
  workspaceRoot: vscode.Uri,
  slug: string
): Promise<
  | { status: 'ok'; meta: LibraryMetaFile }
  | { status: 'noFile' }
  | { status: 'error'; message: string }
> {
  try {
    const raw = await readJson<unknown>(libraryMetaUri(workspaceRoot, slug));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { status: 'error', message: 'meta.json must be a JSON object.' };
    }
    return { status: 'ok', meta: raw as LibraryMetaFile };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === 'FileNotFound' || code === 'ENOENT') {
      return { status: 'noFile' };
    }
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Atomically write `libraries/<slug>/meta.json`. Preserves unknown fields
 * of the existing file. Errors bubble up as `{status: 'error'}`.
 */
export async function writeLibraryMeta(
  workspaceRoot: vscode.Uri,
  slug: string,
  meta: LibraryMetaFile
): Promise<{ status: 'ok' } | { status: 'error'; message: string }> {
  let existing: LibraryMetaFile = {};
  let expectedOriginal: unknown = null;
  try {
    const raw = await readJson<unknown>(libraryMetaUri(workspaceRoot, slug));
    expectedOriginal = raw;
    if (raw && typeof raw === 'object') {
      existing = raw as LibraryMetaFile;
    }
  } catch {
    // Missing / malformed → treat as empty and overwrite.
  }
  const merged: LibraryMetaFile = { ...existing, ...meta };
  try {
    await writeWorkspaceFile(workspaceRoot,
      libraryMetaUri(workspaceRoot, slug),
      jsonBytes(merged),
      expectedOriginal
    );
    return { status: 'ok' };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
}


// ---------------------------------------------------------------------------
// Library graph: read / write
// ---------------------------------------------------------------------------

/**
 * Well-typed view of a library graph node. Mirrors `libraryGraph.ts`'s
 * `GraphNode` but lives here so callers importing `snlDoc` don't need to pull
 * in the engine module just to read a graph.
 */
export interface GraphNodeDto {
  id: string;
  label: string;
  props: Record<string, unknown>;
}

/** Well-typed view of a library graph relationship (edge). */
export interface GraphRelationshipDto {
  from: string;
  to: string;
  label: string;
}

/** Result of {@link readLibraryGraph}. `warnings` names non-fatal issues
 *  (dangling entryId, unknown node label, malformed edge, …) that the caller
 *  should surface to the user. `graph` always parses — malformed pieces are
 *  skipped and named in `warnings`. */
export interface ReadLibraryGraphResult {
  graph: { nodes: GraphNodeDto[]; relationships: GraphRelationshipDto[] };
  warnings: string[];
}

/**
 * Optional inputs for {@link readLibraryGraph}.
 *
 * `entryPool` lets a caller that has ALREADY read the shared pool hand it in
 * so the dangling-entryId validation doesn't read `entries.json` a second
 * time. Panels routinely need both the graph and the pool, and the hidden
 * inner read doubled that file on every push.
 * Cat 2026-07-25: "各个 Panel 开起来都非常慢".
 *
 * Semantics are unchanged: when omitted the pool is read internally exactly
 * as before, and a read failure still degrades to "skip entryId validation"
 * rather than failing the graph read.
 */
export interface ReadLibraryGraphOptions {
  entryPool?: EntryData[];
}

/**
 * Read `libraries/<slug>/graph.json` and normalize it into a well-typed
 * shape. Non-fatal issues (dangling `entryId`, malformed rows, unknown label
 * strings) are collected in `warnings` rather than aborting the read — see
 * spec §8. Missing file → `{status: 'noFile'}`. Read/parse error → `{status:
 * 'error', message}`.
 */
export async function readLibraryGraph(
  workspaceRoot: vscode.Uri,
  slug: string,
  opts?: ReadLibraryGraphOptions
): Promise<
  | { status: 'ok'; result: ReadLibraryGraphResult }
  | { status: 'noFile' }
  | { status: 'error'; message: string }
> {
  let raw: unknown;
  try {
    raw = await readJson<unknown>(libraryGraphUri(workspaceRoot, slug));
  } catch (err) {
    // The real VS Code fs throws FileSystemError with code 'FileNotFound';
    // the Node-based smoke shim throws NodeJS.SystemError with code 'ENOENT'.
    // Accept both so callers can render the "not initialized" placeholder
    // whichever host we're running in.
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === 'FileNotFound' || code === 'ENOENT') {
      return { status: 'noFile' };
    }
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }

  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return {
      status: 'ok',
      result: { graph: { nodes: [], relationships: [] }, warnings: ['graph file is not a JSON object'] }
    };
  }
  const rawObj = raw as Record<string, unknown>;
  const rawNodes = Array.isArray(rawObj.nodes) ? rawObj.nodes : [];
  const rawRels = Array.isArray(rawObj.relationships)
    ? rawObj.relationships
    : [];
  if (!Array.isArray(rawObj.nodes)) {
    warnings.push('nodes is not an array (treated as empty)');
  }
  if (!Array.isArray(rawObj.relationships)) {
    warnings.push('relationships is not an array (treated as empty)');
  }

  // Cheap pre-index of the shared entry pool so dangling-entryId warnings
  // can be computed in one read. When the caller already holds the pool it
  // hands it in via `opts.entryPool`, saving a duplicate `entries.json` read.
  const knownEntryIds = new Set<string>();
  try {
    const entries = opts?.entryPool ?? (await readEntries(workspaceRoot));
    for (const e of entries) {
      if (e && typeof e.id === 'string') knownEntryIds.add(e.id);
    }
  } catch {
    // If the shared pool is unreadable we simply skip entryId validation.
    // Not a fatal condition for reading a library's graph.
  }

  const nodes: GraphNodeDto[] = [];
  const idSet = new Set<string>();
  for (let i = 0; i < rawNodes.length; i++) {
    const n = rawNodes[i];
    if (!n || typeof n !== 'object') {
      warnings.push(`node[${i}] is not an object; skipped`);
      continue;
    }
    const obj = n as Record<string, unknown>;
    const id = obj.id;
    const label = obj.label;
    if (typeof id !== 'string' || id.length === 0) {
      warnings.push(`node[${i}] has no string id; skipped`);
      continue;
    }
    if (typeof label !== 'string' || label.length === 0) {
      warnings.push(`node[${id}] has no string label; skipped`);
      continue;
    }
    if (idSet.has(id)) {
      warnings.push(`node[${id}] duplicated in graph; kept first occurrence`);
      continue;
    }
    idSet.add(id);
    const props =
      obj.props && typeof obj.props === 'object' && !Array.isArray(obj.props)
        ? (obj.props as Record<string, unknown>)
        : {};
    nodes.push({ id, label, props });

    // v2 spec §1: the only supported node label is 'Entry'. Anything else
    // (e.g. leftover v1 'Section' / 'Counter') is kept in the graph but
    // will be ignored by the numbering engine — flag it.
    if (label !== 'Entry') {
      warnings.push(
        `node "${id}" has label "${label}"; only "Entry" is supported in v2 (kept, but ignored by numbering)`
      );
    }

    // Spec §8: Entry nodes carry props.entryId → warn if dangling.
    if (label === 'Entry' && knownEntryIds.size > 0) {
      const entryId = props.entryId;
      if (typeof entryId === 'string' && entryId && !knownEntryIds.has(entryId)) {
        warnings.push(
          `Entry node "${id}" references missing entry "${entryId}"`
        );
      }
    }
  }

  const relationships: GraphRelationshipDto[] = [];
  for (let i = 0; i < rawRels.length; i++) {
    const r = rawRels[i];
    if (!r || typeof r !== 'object') {
      warnings.push(`relationship[${i}] is not an object; skipped`);
      continue;
    }
    const obj = r as Record<string, unknown>;
    const from = obj.from;
    const to = obj.to;
    const label = obj.label;
    if (typeof from !== 'string' || typeof to !== 'string' || typeof label !== 'string') {
      warnings.push(`relationship[${i}] is missing string from/to/label; skipped`);
      continue;
    }
    if (!idSet.has(from)) {
      warnings.push(`relationship[${i}] references unknown source node "${from}"; skipped`);
      continue;
    }
    if (!idSet.has(to)) {
      warnings.push(`relationship[${i}] references unknown target node "${to}"; skipped`);
      continue;
    }
    if (label !== 'branch') {
      warnings.push(
        `relationship[${i}] has label "${label}"; only "branch" is supported in v2 (kept, but ignored by numbering)`
      );
    }
    relationships.push({ from, to, label });
  }

  return {
    status: 'ok',
    result: { graph: { nodes, relationships }, warnings }
  };
}

const RAW_RELATIONSHIP_RECORD = Symbol('raw-library-relationship-record');

type LibraryGraphMutationDecision =
  | boolean
  | void
  | { nodes: GraphNodeDto[]; relationships: GraphRelationshipDto[] };

/**
 * Writer-locked raw graph mutation. The callback sees the latest normalized
 * graph while wrapper/node/relationship extension fields are retained by
 * stable identity in the committed raw document.
 */
export async function mutateLibraryGraph(
  workspaceRoot: vscode.Uri,
  slug: string,
  mutate: (
    graph: { nodes: GraphNodeDto[]; relationships: GraphRelationshipDto[] },
    transaction: { onRollback(action: () => void | Promise<void>): void }
  ) => LibraryGraphMutationDecision | Promise<LibraryGraphMutationDecision>
): Promise<
  | { status: 'ok'; changed: boolean }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string }
> {
  return withExtensionWriterLock(workspaceRoot, 'mutate Library graph', async () => {
    const uri = libraryGraphUri(workspaceRoot, slug);
    let raw: unknown;
    let existed = true;
    try {
      await assertOwnedLibraryPath(workspaceRoot, uri);
      raw = await readJson<unknown>(uri);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== 'FileNotFound' && code !== 'ENOENT') {
        return { status: 'error', message: error instanceof Error ? error.message : String(error) } as const;
      }
      existed = false;
      raw = { nodes: [], relationships: [] };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { status: 'invalid', message: 'Library graph must be a JSON object.' } as const;
    }
    const wrapper = raw as Record<string, unknown>;
    if (!Array.isArray(wrapper.nodes) || !Array.isArray(wrapper.relationships)) {
      return { status: 'invalid', message: 'Library graph nodes and relationships must be arrays.' } as const;
    }

    const rawNodes = new Map<string, Record<string, unknown>>();
    const nodes: GraphNodeDto[] = [];
    for (const value of wrapper.nodes) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { status: 'invalid', message: 'Library graph contains a malformed node.' } as const;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.id !== 'string' || !record.id || typeof record.label !== 'string' ||
          !record.label || rawNodes.has(record.id) || !record.props ||
          typeof record.props !== 'object' || Array.isArray(record.props)) {
        return { status: 'invalid', message: 'Library graph contains a malformed or duplicate node.' } as const;
      }
      rawNodes.set(record.id, record);
      nodes.push({ id: record.id, label: record.label, props: { ...(record.props as Record<string, unknown>) } });
    }

    const relationships: GraphRelationshipDto[] = [];
    for (const value of wrapper.relationships) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { status: 'invalid', message: 'Library graph contains a malformed relationship.' } as const;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.from !== 'string' || !record.from ||
          typeof record.to !== 'string' || !record.to ||
          typeof record.label !== 'string' || !record.label) {
        return { status: 'invalid', message: 'Library graph contains a malformed relationship.' } as const;
      }
      if (!rawNodes.has(record.from) || !rawNodes.has(record.to)) {
        return { status: 'invalid', message: 'Library graph contains a dangling relationship.' } as const;
      }
      const normalized = {
        from: record.from,
        to: record.to,
        label: record.label,
        [RAW_RELATIONSHIP_RECORD]: record
      } as GraphRelationshipDto & {
        [RAW_RELATIONSHIP_RECORD]: Record<string, unknown>;
      };
      relationships.push(normalized);
    }

    const rollbackActions: Array<() => void | Promise<void>> = [];
    const runRollback = async (): Promise<string[]> => {
      const errors: string[] = [];
      for (const action of [...rollbackActions].reverse()) {
        try {
          await action();
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return errors;
    };
    let decision: LibraryGraphMutationDecision;
    try {
      decision = await mutate(
        { nodes, relationships },
        { onRollback: (action) => rollbackActions.push(action) }
      );
    } catch (error) {
      const rollbackErrors = await runRollback();
      return {
        status: 'error',
        message: `${error instanceof Error ? error.message : String(error)}` +
          (rollbackErrors.length ? `; rollback failed: ${rollbackErrors.join('; ')}` : '')
      } as const;
    }
    if (!decision) {
      const rollbackErrors = await runRollback();
      if (rollbackErrors.length) {
        return { status: 'error', message: `Graph mutation rollback failed: ${rollbackErrors.join('; ')}` } as const;
      }
      return { status: 'ok', changed: false } as const;
    }
    const nextGraph = typeof decision === 'object' ? decision : { nodes, relationships };
    const nextNodes = nextGraph.nodes.map((node) => ({
      ...(rawNodes.get(node.id) ?? {}),
      id: node.id,
      label: node.label,
      props: node.props
    }));
    const nextRelationships = nextGraph.relationships.map((relationship) => {
      const tagged = relationship as GraphRelationshipDto & {
        [RAW_RELATIONSHIP_RECORD]?: Record<string, unknown>;
      };
      const original = tagged[RAW_RELATIONSHIP_RECORD];
      const {
        [RAW_RELATIONSHIP_RECORD]: _rawRelationship,
        ...managed
      } = tagged;
      return { ...(original ?? {}), ...managed };
    });
    const next = { ...wrapper, nodes: nextNodes, relationships: nextRelationships };
    try {
      await writeWorkspaceFile(
        workspaceRoot,
        uri,
        jsonBytes(next),
        existed ? raw : null
      );
      return { status: 'ok', changed: true } as const;
    } catch (error) {
      const rollbackErrors = await runRollback();
      return {
        status: 'error',
        message: `${error instanceof Error ? error.message : String(error)}` +
          (rollbackErrors.length ? `; rollback failed: ${rollbackErrors.join('; ')}` : '')
      } as const;
    }
  });
}

/**
 * Atomically write a library graph to `libraries/<slug>/graph.json`. Caller
 * is responsible for validating the graph before writing (the read side is
 * forgiving, the write side is not — we trust what we're given here).
 */
export async function writeLibraryGraph(
  workspaceRoot: vscode.Uri,
  slug: string,
  graph: { nodes: GraphNodeDto[]; relationships: GraphRelationshipDto[] }
): Promise<{ status: 'ok' } | { status: 'error'; message: string }> {
  const file: LibraryGraphFile = {
    nodes: graph.nodes,
    relationships: graph.relationships
  };
  try {
    await writeWorkspaceFile(workspaceRoot, libraryGraphUri(workspaceRoot, slug), jsonBytes(file));
    return { status: 'ok' };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * CAS-safe scoped update of the shared Entry indexed by one outline node.
 * It transforms raw JSON so node identity, topology, and unrelated extension
 * fields survive byte-for-byte at the value level.
 */
export async function updateLibraryGraphNodeEntryId(
  workspaceRoot: vscode.Uri,
  slug: string,
  nodeId: string,
  expectedEntryId: string | null,
  entryId: string
): Promise<
  | { status: 'ok' }
  | { status: 'invalid' }
  | { status: 'notFound' }
  | { status: 'conflict'; currentEntryId: string | null }
  | { status: 'error'; message: string }
> {
  return withExtensionWriterLock(workspaceRoot, 'update Library graph Entry reference', async () => {
    const uri = libraryGraphUri(workspaceRoot, slug);
    let raw: unknown;
    try {
      raw = await readJson<unknown>(uri);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === 'FileNotFound' || code === 'ENOENT') return { status: 'notFound' } as const;
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      } as const;
    }
    const updated = updateRawLibraryGraphNodeEntryId(
      raw,
      nodeId,
      expectedEntryId,
      entryId
    );
    if (!updated.ok) {
      return updated.reason === 'conflict'
        ? { status: 'conflict', currentEntryId: updated.currentEntryId } as const
        : { status: updated.reason } as const;
    }
    if (!updated.changed) return { status: 'ok' } as const;
    try {
      await writeWorkspaceFile(workspaceRoot, uri, jsonBytes(updated.value), raw);
      return { status: 'ok' } as const;
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      } as const;
    }
  });
}

/** Writer-locked raw graph transform used by the Library add-parent command. */
export async function wrapLibraryGraphNodeWithParent(
  workspaceRoot: vscode.Uri,
  slug: string,
  targetId: string,
  parent: GraphNodeDto
): Promise<
  | { status: 'ok' }
  | { status: 'invalid' | 'notFound' | 'malformed' }
  | { status: 'error'; message: string }
> {
  return withExtensionWriterLock(workspaceRoot, 'wrap Library graph node', async () => {
    const uri = libraryGraphUri(workspaceRoot, slug);
    let raw: unknown;
    try {
      raw = await readJson<unknown>(uri);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === 'FileNotFound' || code === 'ENOENT') return { status: 'notFound' } as const;
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      } as const;
    }
    const wrapped = wrapRawLibraryGraphNodeWithParent(raw, targetId, parent);
    if (!wrapped.ok) return { status: wrapped.reason } as const;
    try {
      await writeWorkspaceFile(workspaceRoot, uri, jsonBytes(wrapped.value), raw);
      return { status: 'ok' } as const;
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      } as const;
    }
  });
}

// ---------------------------------------------------------------------------
// Library counters: read / write (2026-07-16)
// ---------------------------------------------------------------------------

/**
 * Coerce a persisted counter record into the current {@link CounterNode}
 * shape. Never throws — bad fields fall back to safe defaults and malformed
 * children are dropped, so a hand-mangled counters.json can't take the
 * whole tree down.
 */
function normalizeCounterNode(raw: unknown): CounterNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' && obj.id ? obj.id : '';
  if (!id) return null;
  const name = typeof obj.name === 'string' ? obj.name : '';
  const numbering = typeof obj.numbering === 'string' ? obj.numbering : '';
  const children: CounterNode[] = [];
  if (Array.isArray(obj.children)) {
    for (const c of obj.children) {
      const child = normalizeCounterNode(c);
      if (child) children.push(child);
    }
  }
  return { id, name, numbering, children };
}

/**
 * Read `libraries/<slug>/counters.json` and return its counter roots.
 * Missing file / malformed JSON / wrong shape all degrade to `[]` (never
 * throws) — counters are an optional sidecar.
 */
export async function readLibraryCounters(
  workspaceRoot: vscode.Uri,
  slug: string
): Promise<CounterNode[]> {
  let raw: unknown;
  try {
    raw = await readJson<unknown>(libraryCountersUri(workspaceRoot, slug));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object') return [];
  const rawCounters = (raw as Record<string, unknown>).counters;
  if (!Array.isArray(rawCounters)) return [];
  const out: CounterNode[] = [];
  for (const c of rawCounters) {
    const node = normalizeCounterNode(c);
    if (node) out.push(node);
  }
  return out;
}

/**
 * Persist a counter tree to `libraries/<slug>/counters.json`. The caller
 * owns the tree shape; we serialize verbatim as `{ counters: roots }`.
 */
export async function writeLibraryCounters(
  workspaceRoot: vscode.Uri,
  slug: string,
  roots: CounterNode[]
): Promise<void> {
  await writeWorkspaceFile(
    workspaceRoot,
    libraryCountersUri(workspaceRoot, slug),
    jsonBytes({ counters: roots } satisfies LibraryCountersFile)
  );
}

/**
 * Writer-locked counter-tree mutation. The callback receives the latest
 * snapshot under the shared workspace lock, and persisted unknown wrapper or
 * node fields are overlaid back by stable counter id.
 */
export async function mutateLibraryCounters(
  workspaceRoot: vscode.Uri,
  slug: string,
  mutate: (roots: CounterNode[]) => boolean
): Promise<
  | { status: 'ok'; changed: boolean }
  | { status: 'invalid' }
  | { status: 'error'; message: string }
> {
  return withExtensionWriterLock(workspaceRoot, 'mutate Library counters', async () => {
    const uri = libraryCountersUri(workspaceRoot, slug);
    let raw: unknown;
    let existed = true;
    try {
      raw = await readJson<unknown>(uri);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== 'FileNotFound' && code !== 'ENOENT') {
        return {
          status: 'error',
          message: error instanceof Error ? error.message : String(error)
        } as const;
      }
      existed = false;
      raw = { counters: [] };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { status: 'invalid' } as const;
    }
    const wrapper = raw as Record<string, unknown>;
    if (!Array.isArray(wrapper.counters)) return { status: 'invalid' } as const;

    const rawById = new Map<string, Record<string, unknown>>();
    const validateAndCollect = (records: unknown[]): boolean => records.every((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      if (
        typeof record.id !== 'string' || record.id.length === 0 || rawById.has(record.id) ||
        typeof record.name !== 'string' || typeof record.numbering !== 'string' ||
        !Array.isArray(record.children)
      ) return false;
      rawById.set(record.id, record);
      return validateAndCollect(record.children);
    });
    if (!validateAndCollect(wrapper.counters)) return { status: 'invalid' } as const;

    const roots = wrapper.counters.map((record) => normalizeCounterNode(record)!);
    const changed = mutate(roots);
    if (!changed) return { status: 'ok', changed: false } as const;
    const preserve = (node: CounterNode): Record<string, unknown> => ({
      ...(rawById.get(node.id) ?? {}),
      id: node.id,
      name: node.name,
      numbering: node.numbering,
      children: node.children.map(preserve)
    });
    const next = { ...wrapper, counters: roots.map(preserve) };
    try {
      if (existed) await writeWorkspaceFile(workspaceRoot, uri, jsonBytes(next), raw);
      else await writeWorkspaceFile(workspaceRoot, uri, jsonBytes(next));
      return { status: 'ok', changed: true } as const;
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      } as const;
    }
  });
}

export type RollbackCreatedEntryResult =
  | { status: 'ok'; id: string }
  | { status: 'notFound'; id: string }
  | { status: 'conflict'; id: string; message: string }
  | { status: 'referenced'; id: string; library: string }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string };

async function assertCreatedEntryUnreferencedByRawLibraries(
  workspaceRoot: vscode.Uri,
  entryId: string
): Promise<{ referencedBy: string | null }> {
  await assertOwnedLibraryRoot(workspaceRoot);
  const directoryEntries = await vscode.workspace.fs.readDirectory(librariesDirUri(workspaceRoot));
  for (const [slug, type] of directoryEntries) {
    if (slug === '.gitkeep' && type === vscode.FileType.File) continue;
    if (type !== vscode.FileType.Directory) {
      throw new Error(`Library census found non-directory entry ${JSON.stringify(slug)}.`);
    }
    libraryDirUri(workspaceRoot, slug);
    const graphUri = libraryGraphUri(workspaceRoot, slug);
    await assertOwnedLibraryPath(workspaceRoot, graphUri);
    const raw = await readJson<unknown>(graphUri);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Library ${JSON.stringify(slug)} graph must be a JSON object.`);
    }
    const wrapper = raw as Record<string, unknown>;
    if (!Array.isArray(wrapper.nodes) || !Array.isArray(wrapper.relationships)) {
      throw new Error(`Library ${JSON.stringify(slug)} graph must contain node and relationship arrays.`);
    }
    const nodeIds = new Set<string>();
    for (const value of wrapper.nodes) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Library ${JSON.stringify(slug)} graph contains a malformed node.`);
      }
      const node = value as Record<string, unknown>;
      if (typeof node.id !== 'string' || !node.id || nodeIds.has(node.id) ||
          typeof node.label !== 'string' || !node.label ||
          !node.props || typeof node.props !== 'object' || Array.isArray(node.props)) {
        throw new Error(`Library ${JSON.stringify(slug)} graph contains a malformed or duplicate node.`);
      }
      nodeIds.add(node.id);
      const props = node.props as Record<string, unknown>;
      if (Object.hasOwn(props, 'entryId') && typeof props.entryId !== 'string') {
        throw new Error(`Library ${JSON.stringify(slug)} graph contains a non-string Entry reference.`);
      }
      if (props.entryId === entryId) return { referencedBy: slug };
    }
    for (const value of wrapper.relationships) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Library ${JSON.stringify(slug)} graph contains a malformed relationship.`);
      }
      const relationship = value as Record<string, unknown>;
      if (typeof relationship.from !== 'string' || !relationship.from ||
          typeof relationship.to !== 'string' || !relationship.to ||
          typeof relationship.label !== 'string' || !relationship.label) {
        throw new Error(`Library ${JSON.stringify(slug)} graph contains a malformed relationship.`);
      }
      if (!nodeIds.has(relationship.from) || !nodeIds.has(relationship.to)) {
        throw new Error(`Library ${JSON.stringify(slug)} graph contains a dangling relationship.`);
      }
    }
  }
  return { referencedBy: null };
}

/**
 * Compensate an Entry created inside a larger writer transaction. The expected
 * revision must be the revision returned by addEntry, i.e. the exact canonical
 * record that was persisted. Raw Library JSON is enumerated strictly here;
 * tolerant dashboard readers are deliberately not used at this trust boundary.
 */
export async function rollbackCreatedEntry(
  workspaceRoot: vscode.Uri,
  id: string,
  expectedRevision: string
): Promise<RollbackCreatedEntryResult> {
  try {
    return await withExtensionWriterLock(workspaceRoot, 'roll back created Entry', async () => {
      const matches = (await readEntries(workspaceRoot)).filter((entry) => entry?.id === id);
      if (matches.length === 0) return { status: 'notFound', id } as const;
      if (matches.length !== 1) {
        return { status: 'invalid', message: `Entry ${JSON.stringify(id)} is duplicated.` } as const;
      }
      if (entityRevision(matches[0]) !== expectedRevision) {
        return {
          status: 'conflict', id,
          message: `Entry ${JSON.stringify(id)} changed after creation.`
        } as const;
      }
      let census: { referencedBy: string | null };
      try {
        census = await assertCreatedEntryUnreferencedByRawLibraries(workspaceRoot, id);
      } catch (error) {
        return {
          status: 'invalid',
          message: `Could not complete strict Library graph census: ${error instanceof Error ? error.message : String(error)}`
        } as const;
      }
      if (census.referencedBy) {
        return { status: 'referenced', id, library: census.referencedBy } as const;
      }
      const deleted = await deleteEntry(workspaceRoot, id);
      if (deleted.status === 'ok') return { status: 'ok', id } as const;
      if (deleted.status === 'notFound') return { status: 'notFound', id } as const;
      return {
        status: 'error',
        message: 'message' in deleted ? deleted.message : `Could not delete Entry ${JSON.stringify(id)}.`
      } as const;
    });
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Delete APIs (cat 2026-07-09).
//
// These four functions cover the "delete an entity" family that was missing
// from snlDoc.ts before this batch — `deleteMacroPackage` and
// `batchDeleteMacros` already existed for macros / macro packages.
//
// Semantics they share:
//   - Read → mutate in memory → write back atomically. No inode-level tricks.
//   - Return a discriminated status: 'ok' / 'noSnlDoc' / 'notFound' /
//     'error' (plus 'invalid' where an argument shape is wrong).
//   - Do NOT silently prune cross-references (Library outline nodes that
//     point at deleted entries, Macro source.entries that reference deleted
//     entries, entries whose kind == deletedKind.id). Callers get a
//     `references` field on the result listing the dangling refs, and it's
//     the UI's job to warn / confirm / prune. That keeps the delete API
//     honest and lets the UI implement its own confirmation policy without
//     racing another writer.
// ---------------------------------------------------------------------------

/**
 * Delete a single entry from the shared pool (`.SNL_Doc/entries.json`).
 *
 * Does NOT prune library-graph nodes that reference this entry — Library
 * outlines can safely tolerate a `node.props.entryId` whose target is gone
 * (the outline renders it as a placeholder / "unresolved" node). Does NOT
 * prune macro `source.entries[]` either — those become dead references but
 * cause no runtime error; the linter surfaces them as warnings.
 *
 * If callers want to clean up references, they should walk libraries +
 * macro packages after the delete succeeds. This function reports the
 * counts in `references` so a UI can prompt the user.
 */
export async function deleteEntry(
  workspaceRoot: vscode.Uri,
  id: string,
  expectedPackageId?: string
): Promise<
  | {
      status: 'ok';
      id: string;
      references: {
        libraryNodes: Array<{ librarySlug: string; nodeId: string }>;
        macroSources: Array<{ packageFile: string; macroName: string }>;
        relationships: string[];
      };
    }
  | { status: 'noSnlDoc' }
  | { status: 'notFound'; id: string }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string }
> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  return withExtensionWriterLock(workspaceRoot, 'delete Entry', async () => {
    const targetId = (id ?? '').trim();
  if (!targetId) {
    return { status: 'invalid', message: 'id is required' };
  }
  const entityMode = await usesEntityStorage(workspaceRoot);
  let entityRecord: Awaited<ReturnType<typeof readEntryEntityRecords>>[number] | undefined;
  let entityRecords: EntryEntityRecord[] = [];
  let ownerManifest: PackageManifestRecord | null = null;
  let pool: EntryData[] = [];
  if (entityMode) {
    entityRecords = await readEntryEntityRecords(entityReadStorage(workspaceRoot));
    entityRecord = entityRecords.find(({ entry }) => entry.id === targetId);
    if (entityRecord && expectedPackageId !== undefined &&
        entityRecord.envelope.package !== expectedPackageId) {
      return { status: 'notFound', id: targetId };
    }
    if (entityRecord) {
      try {
        ownerManifest = await readPackageManifestRecord(
          entityReadStorage(workspaceRoot), entityRecord.envelope.package
        );
        if (!ownerManifest) {
          return { status: 'invalid', message: `Package ${JSON.stringify(entityRecord.envelope.package)} does not exist` };
        }
        await readIndexedPackageEntryRecords(
          entityReadStorage(workspaceRoot),
          entityRecord.envelope.package,
          ownerManifest.manifest.entry_ids
        );
      } catch (error) {
        return { status: 'invalid', message: error instanceof Error ? error.message : String(error) };
      }
    }
    pool = entityRecords.map(({ entry }) => entry as unknown as EntryData);
  } else {
    try {
      const raw = await readJson<unknown>(entriesUri(workspaceRoot));
      if (Array.isArray(raw)) pool = raw as EntryData[];
    } catch {
      pool = [];
    }
  }
  const idx = pool.findIndex(
    (e) => e && typeof e === 'object' && e.id === targetId
  );
  if (idx < 0) {
    return { status: 'notFound', id: targetId };
  }
  // Collect references BEFORE we mutate — inconsistent snapshots are worse
  // than a slightly stale reference list.
  const references = {
    libraryNodes: [] as Array<{ librarySlug: string; nodeId: string }>,
    macroSources: [] as Array<{ packageFile: string; macroName: string }>,
    relationships: [] as string[]
  };
  try {
    const libs = await listLibraries(workspaceRoot);
    for (const lib of libs) {
      const graphRead = await readLibraryGraph(workspaceRoot, lib.slug);
      if (graphRead.status !== 'ok') continue;
      for (const node of graphRead.result.graph.nodes) {
        // Node's entryId is stored on node.props per LibraryGraph spec.
        const props =
          (node as unknown as { props?: { entryId?: unknown } }).props ?? {};
        if (typeof props.entryId === 'string' && props.entryId === targetId) {
          references.libraryNodes.push({
            librarySlug: lib.slug,
            nodeId: node.id
          });
        }
      }
    }
  } catch {
    // Library scan is best-effort; don't fail the delete just because a
    // library is unreadable.
  }
  try {
    const pkgs = await readMacroPackages(workspaceRoot);
    for (const summary of pkgs) {
      const read = await readMacroPackage(workspaceRoot, summary.file);
      if (read.status !== 'ok') continue;
      for (const macro of read.macros) {
        const src =
          (macro as unknown as { source?: { entries?: unknown } }).source ?? {};
        if (Array.isArray(src.entries) && src.entries.includes(targetId)) {
          references.macroSources.push({
            packageFile: summary.file,
            macroName: macro.name
          });
        }
      }
    }
  } catch {
    // Same — best-effort.
  }
  try {
    const rels = await readRelationships(workspaceRoot);
    for (const r of rels) {
      if (r.from === targetId || r.to === targetId) {
        references.relationships.push(r.id);
      }
    }
  } catch {
    // Best-effort — a broken relationships.json shouldn't block delete.
  }
  const original = structuredClone(pool);
  pool.splice(idx, 1);
  try {
    if (entityMode && entityRecord && ownerManifest) {
      const indexedIds = packageManifestEntryIds(ownerManifest.manifest);
      if (indexedIds === null) throw new Error('Current Package membership index is missing.');
      const membershipRewrite = rewritePackageEntryMembership(
        ownerManifest,
        indexedIds.filter((entryId) => entryId !== targetId)
      );
      await applyJsonFileOperations(workspaceRoot, `delete Entry ${targetId}`, [
        {
          kind: 'write',
          uri: snlRelativeUri(workspaceRoot, ownerManifest.path),
          value: membershipRewrite.value,
          expected: membershipRewrite.expected
        },
        {
          kind: 'delete',
          uri: snlRelativeUri(workspaceRoot, entityRecord.path),
          expected: entityRecord.rawEnvelope
        }
      ]);
    } else {
      await writeWorkspaceFile(workspaceRoot, entriesUri(workspaceRoot), jsonBytes(pool), original);
    }
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
    return { status: 'ok', id: targetId, references };
  });
}

/**
 * Delete an entry-kind row from `.SNL_Doc/config.json#entry_kinds`.
 *
 * Reports entries whose `kind === id` as dangling references. Does NOT
 * cascade — leaving orphaned "unknown kind" entries is safer than mass
 * mutating entries whose semantics the user thought were stable.
 */
export async function deleteEntryKind(
  workspaceRoot: vscode.Uri,
  id: string
): Promise<
  | {
      status: 'ok';
      id: string;
      references: { entries: string[] };
    }
  | { status: 'noSnlDoc' }
  | { status: 'notFound'; id: string }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string }
> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  return withExtensionWriterLock(workspaceRoot, 'delete entry kind', async () => {
    const targetId = (id ?? '').trim();
  if (!targetId) {
    return { status: 'invalid', message: 'id is required' };
  }
  let cfg: Record<string, unknown> = {};
  try {
    const raw = await readJson<unknown>(configUri(workspaceRoot));
    if (raw && typeof raw === 'object') {
      cfg = raw as Record<string, unknown>;
    }
  } catch {
    cfg = {};
  }
  const list = Array.isArray(cfg.entry_kinds) ? (cfg.entry_kinds as EntryKind[]) : [];
  const idx = list.findIndex((k) => k && k.id === targetId);
  if (idx < 0) {
    return { status: 'notFound', id: targetId };
  }
  const references = { entries: [] as string[] };
  try {
    const entries = await readEntries(workspaceRoot);
    for (const e of entries) {
      if (e.kind === targetId) references.entries.push(e.id);
    }
  } catch {
    // best-effort
  }
  const original = structuredClone(cfg);
  const next = list.slice();
  next.splice(idx, 1);
  cfg.entry_kinds = next;
  try {
    await writeWorkspaceFile(workspaceRoot, configUri(workspaceRoot), jsonBytes(cfg), original);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
    return { status: 'ok', id: targetId, references };
  });
}

/**
 * Delete a macro-kind row from `.SNL_Doc/config.json#macro_kinds`.
 *
 * Reports macros whose `kind === id` as dangling references (they'll fall
 * back to an "unknown kind" hover badge but keep working).
 */
export async function deleteMacroKind(
  workspaceRoot: vscode.Uri,
  id: string
): Promise<
  | {
      status: 'ok';
      id: string;
      references: Array<{ packageFile: string; macroName: string }>;
    }
  | { status: 'noSnlDoc' }
  | { status: 'notFound'; id: string }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string }
> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  return withExtensionWriterLock(workspaceRoot, 'delete Macro kind', async () => {
    const targetId = (id ?? '').trim();
  if (!targetId) {
    return { status: 'invalid', message: 'id is required' };
  }
  let cfg: Record<string, unknown> = {};
  try {
    const raw = await readJson<unknown>(configUri(workspaceRoot));
    if (raw && typeof raw === 'object') {
      cfg = raw as Record<string, unknown>;
    }
  } catch {
    cfg = {};
  }
  const list = Array.isArray(cfg.macro_kinds) ? (cfg.macro_kinds as MacroKind[]) : [];
  const idx = list.findIndex((k) => k && k.id === targetId);
  if (idx < 0) {
    return { status: 'notFound', id: targetId };
  }
  const references: Array<{ packageFile: string; macroName: string }> = [];
  try {
    const pkgs = await readMacroPackages(workspaceRoot);
    for (const summary of pkgs) {
      const read = await readMacroPackage(workspaceRoot, summary.file);
      if (read.status !== 'ok') continue;
      for (const macro of read.macros) {
        const k = (macro as unknown as { kind?: unknown }).kind;
        if (typeof k === 'string' && k === targetId) {
          references.push({ packageFile: summary.file, macroName: macro.name });
        }
      }
    }
  } catch {
    // best-effort
  }
  const original = structuredClone(cfg);
  const next = list.slice();
  next.splice(idx, 1);
  cfg.macro_kinds = next;
  try {
    await writeWorkspaceFile(workspaceRoot, configUri(workspaceRoot), jsonBytes(cfg), original);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
    return { status: 'ok', id: targetId, references };
  });
}

/**
 * Delete an entire library directory (`.SNL_Doc/libraries/<slug>/`),
 * including its meta.json and graph.json.
 *
 * Does NOT delete the shared-pool entries the library referenced — that
 * would silently destroy content that other libraries might link. Callers
 * that want a scorched-earth delete should walk this library's graph nodes
 * BEFORE calling this and issue per-entry `deleteEntry` calls.
 */
export async function deleteLibrary(
  workspaceRoot: vscode.Uri,
  slug: string
): Promise<
  | { status: 'ok'; slug: string }
  | { status: 'noSnlDoc' }
  | { status: 'notFound'; slug: string }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string }
> {
  const fsApi = vscode.workspace.fs;
  const targetSlug = (slug ?? '').trim();
  if (!targetSlug || targetSlug !== slug || slugify(targetSlug) !== targetSlug) {
    return {
      status: 'invalid',
      message: 'slug must be one canonical Library path segment'
    };
  }
  const librariesRoot = librariesDirUri(workspaceRoot);
  const dir = libraryDirUri(workspaceRoot, targetSlug);
  try {
    return await withExtensionWriterLock(workspaceRoot, `delete ${dir.fsPath}`, async () => {
      if (!(await exists(snlRootUri(workspaceRoot)))) {
        return { status: 'noSnlDoc' } as const;
      }
      await assertOwnedLibraryRoot(workspaceRoot);
      await assertWorkspaceWritableOnDisk(workspaceRoot, true, true);
      if (!(await exists(dir))) {
        return { status: 'notFound', slug: targetSlug } as const;
      }
      const targetStat = await fsApi.stat(dir);
      if (targetStat.type !== vscode.FileType.Directory) {
        return { status: 'invalid', message: 'Library target is not a real directory' } as const;
      }
      const quarantine = vscode.Uri.joinPath(
        librariesRoot,
        `.deleting-${targetSlug}-${randomUUID()}`
      );
      await fsApi.rename(dir, quarantine, { overwrite: false });
      try {
        await fsApi.delete(quarantine, { recursive: true, useTrash: true });
      } catch (deleteError) {
        try {
          await fsApi.rename(quarantine, dir, { overwrite: false });
        } catch (rollbackError) {
          throw new Error(
            `Library deletion failed and rollback also failed: ${String(deleteError)}; rollback: ${String(rollbackError)}`
          );
        }
        throw deleteError;
      }
      return { status: 'ok', slug: targetSlug } as const;
    });
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

// ===========================================================================
// Relationships (pool-wide semantic graph — cat 2026-07-10)
// ===========================================================================
//
// A *relationship* is a directed edge between two entries in the shared pool,
// carrying a free-text `label` (e.g. "depends-on", "generalizes", "proves")
// and an opaque `metadata: unknown` payload the caller owns.
//
// The relationship graph is GLOBAL — one `relationships.json` at the
// `.SNL_Doc/` root, sibling of `entries.json`. Per-library relationship
// views are computed as *induced subgraphs* over the library's entry set
// (endpoints ∈ library.entryIds); we don't store per-library edge lists.
//
// This is INTENTIONALLY distinct from `libraries/<slug>/graph.json` — that
// file is the library's outline/branch tree, structural not semantic. A
// library entry can appear in many relationships and vice versa.
//
// Design constraints (cat 2026-07-10):
//   - endpoints are entry ids only (no urls / external refs).
//   - label is a String (free-form; not registered in config.json — kinds
//     may come later, but not needed for Phase 1).
//   - metadata is `any` — stored verbatim as JSON; UI edits it as raw JSON.

export interface RelationshipData {
  /** Stable id, unique across relationships.json. Author-controlled. */
  id: string;
  /** Source entry id — MUST exist in entries.json at write time. */
  from: string;
  /** Target entry id — MUST exist in entries.json at write time. */
  to: string;
  /** Free-form edge label, e.g. "depends-on". Non-empty. */
  label: string;
  /** Arbitrary caller payload. Stored verbatim. */
  metadata: unknown;
}

interface RelationshipsFile {
  version?: number;
  relationships?: RelationshipData[];
}

const RELATIONSHIPS_FILE_VERSION = 1;

/**
 * Read the pool-wide relationships list from `.SNL_Doc/relationships.json`.
 * A missing file is an empty pool. Existing data is strict: malformed JSON,
 * a wrong wrapper/version, invalid records, and duplicate ids all throw so
 * callers cannot mistake corruption for a valid graph with missing edges.
 */
export async function readRelationships(
  workspaceRoot: vscode.Uri
): Promise<RelationshipData[]> {
  const uri = relationshipsUri(workspaceRoot);
  if (!(await exists(uri))) return [];
  const raw = await readJson<unknown>(uri);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('relationships.json must be an object wrapper.');
  }
  const wrapper = raw as RelationshipsFile;
  if (wrapper.version !== RELATIONSHIPS_FILE_VERSION) {
    throw new Error(`relationships.json#version must be ${RELATIONSHIPS_FILE_VERSION}.`);
  }
  if (!Array.isArray(wrapper.relationships)) {
    throw new Error('relationships.json#relationships must be an array.');
  }
  const ids = new Set<string>();
  return wrapper.relationships.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`relationships.json#relationships[${index}] must be an object.`);
    }
    const rel = record as RelationshipData;
    for (const field of ['id', 'from', 'to', 'label'] as const) {
      const value = rel[field];
      if (typeof value !== 'string' || !value || value.trim() !== value) {
        throw new Error(`relationships.json#relationships[${index}].${field} must be a canonical non-empty string.`);
      }
    }
    if (ids.has(rel.id)) throw new Error(`relationships.json contains duplicate id ${JSON.stringify(rel.id)}.`);
    ids.add(rel.id);
    return rel;
  });
}

/** Write the canonical `{ version, relationships }` shape to disk. */
async function writeRelationships(
  workspaceRoot: vscode.Uri,
  list: RelationshipData[],
  expectedOriginal: RelationshipData[]
): Promise<void> {
  const payload: RelationshipsFile = {
    version: RELATIONSHIPS_FILE_VERSION,
    relationships: list
  };
  const expectedPayload: RelationshipsFile | null =
    (await exists(relationshipsUri(workspaceRoot))) || expectedOriginal.length > 0
      ? { version: RELATIONSHIPS_FILE_VERSION, relationships: expectedOriginal }
      : null;
  await writeWorkspaceFile(
    workspaceRoot,
    relationshipsUri(workspaceRoot),
    jsonBytes(payload),
    expectedPayload
  );
}

export type AddRelationshipResult =
  | { status: 'ok'; id: string }
  | { status: 'duplicate'; id: string }
  | { status: 'unknownEndpoint'; endpoint: 'from' | 'to'; id: string }
  | { status: 'invalid'; message: string }
  | { status: 'noSnlDoc' }
  | { status: 'error'; message: string };

/**
 * Add a new relationship. Validates:
 *  - `id` non-empty and unique in the current list;
 *  - `from` and `to` both resolve to entries in the shared pool;
 *  - `label` non-empty (trimmed).
 * `metadata` is stored verbatim (may be null / undefined → null).
 */
export async function addRelationship(
  workspaceRoot: vscode.Uri,
  rel: RelationshipData
): Promise<AddRelationshipResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  const id = typeof rel?.id === 'string' ? rel.id.trim() : '';
  const from = typeof rel?.from === 'string' ? rel.from.trim() : '';
  const to = typeof rel?.to === 'string' ? rel.to.trim() : '';
  const label = typeof rel?.label === 'string' ? rel.label.trim() : '';
  if (!id) return { status: 'invalid', message: 'id is required' };
  if (!from) return { status: 'invalid', message: 'from is required' };
  if (!to) return { status: 'invalid', message: 'to is required' };
  if (!label) return { status: 'invalid', message: 'label is required' };

  const entries = await readEntries(workspaceRoot);
  const pool = new Set(entries.map((e) => e.id));
  if (!pool.has(from)) return { status: 'unknownEndpoint', endpoint: 'from', id: from };
  if (!pool.has(to)) return { status: 'unknownEndpoint', endpoint: 'to', id: to };

  const list = await readRelationships(workspaceRoot);
  if (list.some((r) => r.id === id)) {
    return { status: 'duplicate', id };
  }
  const record: RelationshipData = {
    id,
    from,
    to,
    label,
    metadata: rel.metadata ?? null
  };
  try {
    await writeRelationships(workspaceRoot, [...list, record], list);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'ok', id };
}

export type UpdateRelationshipResult =
  | { status: 'updated'; id: string }
  | { status: 'noSnlDoc' }
  | { status: 'notFound'; id: string }
  | { status: 'conflict'; id: string }
  | { status: 'invalid'; message: string }
  | { status: 'unknownEndpoint'; endpoint: 'from' | 'to'; id: string }
  | { status: 'error'; message: string };

/**
 * Update an existing relationship IN PLACE, keyed by `id`. `id` itself is
 * never modified (it's the lookup key). `from` / `to` must still resolve
 * to entries in the shared pool.
 */
export async function updateRelationship(
  workspaceRoot: vscode.Uri,
  id: string,
  input: Omit<RelationshipData, 'id'>,
  expectedRevision?: string
): Promise<UpdateRelationshipResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  const targetId = (id ?? '').trim();
  if (!targetId) return { status: 'invalid', message: 'id is required' };
  const from = typeof input?.from === 'string' ? input.from.trim() : '';
  const to = typeof input?.to === 'string' ? input.to.trim() : '';
  const label = typeof input?.label === 'string' ? input.label.trim() : '';
  if (!from) return { status: 'invalid', message: 'from is required' };
  if (!to) return { status: 'invalid', message: 'to is required' };
  if (!label) return { status: 'invalid', message: 'label is required' };

  const entries = await readEntries(workspaceRoot);
  const pool = new Set(entries.map((e) => e.id));
  if (!pool.has(from)) return { status: 'unknownEndpoint', endpoint: 'from', id: from };
  if (!pool.has(to)) return { status: 'unknownEndpoint', endpoint: 'to', id: to };

  const list = await readRelationships(workspaceRoot);
  const idx = list.findIndex((r) => r.id === targetId);
  if (idx < 0) return { status: 'notFound', id: targetId };
  if (typeof expectedRevision !== 'string' || entityRevision(list[idx]) !== expectedRevision) {
    return { status: 'conflict', id: targetId };
  }

  const next = list.slice();
  next[idx] = {
    ...list[idx],
    id: targetId,
    from,
    to,
    label,
    metadata: input.metadata ?? null
  };
  try {
    await writeRelationships(workspaceRoot, next, list);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'updated', id: targetId };
}

export type DeleteRelationshipResult =
  | { status: 'ok'; id: string }
  | { status: 'noSnlDoc' }
  | { status: 'notFound'; id: string }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string };

/**
 * Delete a single relationship from `.SNL_Doc/relationships.json`. No
 * reference-scan (relationships don't have consumers of their own id;
 * anything referencing them would be new tooling we don't have yet).
 */
export async function deleteRelationship(
  workspaceRoot: vscode.Uri,
  id: string
): Promise<DeleteRelationshipResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  const targetId = (id ?? '').trim();
  if (!targetId) return { status: 'invalid', message: 'id is required' };
  const list = await readRelationships(workspaceRoot);
  const idx = list.findIndex((r) => r.id === targetId);
  if (idx < 0) return { status: 'notFound', id: targetId };
  const next = list.slice();
  next.splice(idx, 1);
  try {
    await writeRelationships(workspaceRoot, next, list);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'ok', id: targetId };
}

// ===========================================================================
// Auto-generated dependency relationships (cat 2026-07-10 §3)
// ===========================================================================
//
// For each entry E, walk E.content.snl, collect every macro identifier
// used, and — for each macro whose `source.entries[]` names an existing
// entry — emit a relationship  `E → src`  with:
//
//   label:    "depends"
//   metadata: {
//     isAtomic: bool,                 // filled in by computeAtomicity
//     generator: "macro-source-scan",
//     macros: string[],                // deduped macro names that induced
//                                        this edge (many-to-one collapse)
//   }
//
// Atomicity per cat's spec: "若一个 dependency 可以表示为其他几个 dependency
// 的复合，则它不是 Atomic." Implemented as transitive-reducibility over the
// current depends-graph — a A→B edge is NOT atomic iff there is an
// alternative path A→x1→…→xk→B of length ≥ 2 using only depends edges.
//
// SNL macro-name extraction: the parser lives in @sjtu-ai4math/snl-basics
// (browser bundle, React-linked). Host code can't load it, so we run a
// lightweight tokenizer that mirrors the parser's macro-identifier
// recognition:
//   - skip `%…%`, `$…$`, `$$…$$` delimited spans (opaque leaves);
//   - skip `@` bare-binder introductions (bindings, not uses);
//   - collect the identifier that starts with [A-Za-z_.][A-Za-z0-9_.]*
//     everywhere else.
// False positives (over-counted names) are harmless — an unregistered
// name yields no source.entries and generates no edge.

/** Identity marker written into metadata.generator for auto rows so we
 *  know it's safe to regenerate without stomping user-authored edges. */
const AUTO_GENERATOR_TAG = 'macro-source-scan';
const AUTO_LABEL = 'depends';
/** Labels that {@link regenerateDependencyRelationships} manages. Both
 *  are (label, generator) tuples on the metadata side; treat this list
 *  as the source of truth for "is this row auto-managed?". */
const AUTO_LABELS: readonly string[] = ['depends', 'uses_context'];
const AUTO_LABEL_USES_CONTEXT = 'uses_context';

/**
 * Extract macro identifiers AND `x@foo` context-src target entry ids from
 * an SNL string. The scanner is a lightweight tokenizer that mirrors the
 * parser's identifier recognition without pulling the parser itself into
 * the host bundle.
 *
 * `macros`: bare identifiers used as macro references (used to look up
 *   `source.entries[]` for the "depends" auto-edge).
 * `contextSrcs`: the `<name>` in `x@<name>` postfixes — a direct
 *   entry-id reference (Stage 1 §src-postfix), used for the
 *   "uses_context" auto-edge (cat 2026-07-10).
 */
export function extractSnlReferences(
  snl: string
): { macros: string[]; contextSrcs: string[] } {
  const macros = new Set<string>();
  const contextSrcs = new Set<string>();
  if (!snl) return { macros: [], contextSrcs: [] };
  let i = 0;
  const n = snl.length;
  const isIdStart = (c: string): boolean => /[A-Za-z_.]/.test(c);
  const isIdCont = (c: string): boolean => /[A-Za-z0-9_.]/.test(c);
  while (i < n) {
    const c = snl[i];
    if (/\s|[(),\[\]]/.test(c)) { i += 1; continue; }
    if (c === '%') {
      i += 1;
      while (i < n && snl[i] !== '%') i += 1;
      i += 1;
      continue;
    }
    if (c === '$') {
      const isDisplay = snl[i + 1] === '$';
      const delim = isDisplay ? '$$' : '$';
      i += delim.length;
      while (i < n && snl.substr(i, delim.length) !== delim) i += 1;
      i += delim.length;
      continue;
    }
    if (c === '@') {
      // Bare `@foo` = binder introduction. Skip the following name — it's
      // a binding site, not a use.
      i += 1;
      if (i < n && (snl[i] === '%' || snl[i] === '$')) continue;
      while (i < n && isIdCont(snl[i])) i += 1;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdCont(snl[j])) j += 1;
      macros.add(snl.slice(i, j));
      i = j;
      if (i < n && snl[i] === '[') {
        while (i < n && snl[i] !== ']') i += 1;
        if (i < n) i += 1;
      }
      // `x@foo` src postfix: `x` was just collected as a macro name (a
      // false positive we accept — unregistered names produce no edge),
      // but the `@foo` chunk names a context-entry id and IS the
      // uses_context source ref.
      if (i < n && snl[i] === '@') {
        i += 1;
        const start = i;
        while (i < n && isIdCont(snl[i])) i += 1;
        if (i > start) contextSrcs.add(snl.slice(start, i));
      }
      continue;
    }
    i += 1;
  }
  return { macros: Array.from(macros), contextSrcs: Array.from(contextSrcs) };
}

/** Report from {@link regenerateDependencyRelationships}. */
export interface DependencyGenReport {
  added: number;
  removed: number;
  updated: number;
  preservedUser: number;
  totalDepends: number;
  totalUsesContext: number;
  atomicCount: number;
}

export interface DependencyScope {
  /** Restrict scan to a subset of entry ids. `null` = every entry. */
  entryIds: Set<string> | null;
}

/** Pure snapshot reconciliation used by the writer and focused tests. */
export function reconcileDependencyRelationships(
  entries: readonly EntryData[],
  macros: Readonly<Record<string, MacroPackageEntry>>,
  existing: readonly RelationshipData[],
  scope: DependencyScope
): { relationships: RelationshipData[]; report: DependencyGenReport } {
  const poolIds = new Set(entries.map((entry) => entry.id));
  const isSystemAutoRow = (relationship: RelationshipData): boolean =>
    AUTO_LABELS.includes(relationship.label) &&
    relationship.metadata !== null &&
    typeof relationship.metadata === 'object' &&
    (relationship.metadata as { generator?: unknown }).generator === AUTO_GENERATOR_TAG;
  const isManagedDependencyRow = (relationship: RelationshipData): boolean =>
    relationship.label === AUTO_LABEL && isSystemAutoRow(relationship);

  const preservedRows: RelationshipData[] = [];
  const inScopeAuto = new Map<string, RelationshipData>();
  for (const relationship of existing) {
    const inScope = scope.entryIds === null || scope.entryIds.has(relationship.from);
    if (isManagedDependencyRow(relationship) && inScope) {
      inScopeAuto.set(`${relationship.label}|${relationship.from}|${relationship.to}`, relationship);
    } else {
      preservedRows.push(relationship);
    }
  }
  const preservedUser = preservedRows.filter((relationship) =>
    !isSystemAutoRow(relationship)
  ).length;

  const generated = new Map<string, { rel: RelationshipData; witnesses: Set<string> }>();
  const idPrefix: Record<string, string> = {
    [AUTO_LABEL]: 'dep',
    [AUTO_LABEL_USES_CONTEXT]: 'ctx'
  };
  const witnessField: Record<string, string> = {
    [AUTO_LABEL]: 'macros',
    [AUTO_LABEL_USES_CONTEXT]: 'postfixes'
  };
  const allocatedIds = new Set(preservedRows.map(({ id }) => id));
  const allocateGeneratedId = (
    label: string,
    from: string,
    to: string,
    previous: RelationshipData | undefined
  ): string => {
    if (previous && !allocatedIds.has(previous.id)) {
      allocatedIds.add(previous.id);
      return previous.id;
    }
    const base = `${idPrefix[label]}.${from}.${to}`;
    let candidate = base;
    let suffix = 1;
    while (allocatedIds.has(candidate)) candidate = `${base}.${suffix++}`;
    allocatedIds.add(candidate);
    return candidate;
  };
  const upsert = (label: string, from: string, to: string, witness: string): void => {
    if (!to || from === to || !poolIds.has(to)) return;
    const key = `${label}|${from}|${to}`;
    let bucket = generated.get(key);
    if (!bucket) {
      const previous = inScopeAuto.get(key);
      bucket = {
        rel: {
          id: allocateGeneratedId(label, from, to, previous),
          from,
          to,
          label,
          metadata: {
            generator: AUTO_GENERATOR_TAG,
            [witnessField[label]]: [] as string[],
            isAtomic: true
          }
        },
        witnesses: new Set<string>()
      };
      generated.set(key, bucket);
    }
    bucket.witnesses.add(witness);
  };

  for (const entry of entries) {
    if (scope.entryIds !== null && !scope.entryIds.has(entry.id)) continue;
    const snl = entry.content?.snl ?? '';
    if (!snl.trim()) continue;
    const references = extractSnlReferences(snl);
    for (const name of references.macros) {
      const macro = Object.hasOwn(macros, name) ? macros[name] : undefined;
      if (!macro || !Array.isArray(macro.source?.entries)) continue;
      for (const source of macro.source.entries) upsert(AUTO_LABEL, entry.id, source, name);
    }
  }

  for (const bucket of generated.values()) {
    const metadata = bucket.rel.metadata as Record<string, unknown>;
    metadata[witnessField[bucket.rel.label]] = Array.from(bucket.witnesses).sort();
  }

  const relationships = [...preservedRows, ...Array.from(generated.values(), ({ rel }) => rel)];
  const generatedRows = new Set(Array.from(generated.values(), ({ rel }) => rel));
  computeAtomicityInPlace(relationships, (relationship) => generatedRows.has(relationship));
  relationships.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );

  let added = 0;
  let updated = 0;
  for (const key of generated.keys()) {
    if (inScopeAuto.has(key)) updated += 1;
    else added += 1;
  }
  let removed = 0;
  for (const key of inScopeAuto.keys()) {
    if (!generated.has(key)) removed += 1;
  }
  return {
    relationships,
    report: {
      added,
      removed,
      updated,
      preservedUser,
      totalDepends: relationships.filter(({ label }) => label === AUTO_LABEL).length,
      totalUsesContext: relationships.filter(({ label }) => label === AUTO_LABEL_USES_CONTEXT).length,
      atomicCount: relationships.filter((relationship) =>
        AUTO_LABELS.includes(relationship.label) &&
        relationship.metadata !== null &&
        typeof relationship.metadata === 'object' &&
        (relationship.metadata as { isAtomic?: unknown }).isAtomic === true
      ).length
    }
  };
}

/**
 * Regenerate the auto-managed subset of `relationships.json` for a scope.
 * Managed rows are identified by (label === "depends") AND
 * (metadata.generator === "macro-source-scan"). User-authored rows and
 * out-of-scope auto rows are preserved verbatim. `uses_context` and every
 * other relationship label are outside this reconciler and remain unchanged.
 *
 * The managed dependency source is `macros[name].source.entries` for each
 * macro name used in the Entry's SNL.
 *
 * Atomicity (metadata.isAtomic) is recomputed PER LABEL over the merged
 * graph: A→B in label L is atomic iff no alternative path A→…→B exists
 * using only label-L edges.
 */
export async function regenerateDependencyRelationships(
  workspaceRoot: vscode.Uri,
  scope: DependencyScope
): Promise<
  | { status: 'ok'; report: DependencyGenReport }
  | { status: 'noSnlDoc' }
  | { status: 'error'; message: string }
> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  try {
    const entries = await readEntries(workspaceRoot);
    const macros = await readAllMacros(workspaceRoot);
    const existing = await readRelationships(workspaceRoot);
    const { relationships: merged, report } = reconcileDependencyRelationships(
      entries,
      macros,
      existing,
      scope
    );

    const relationshipsFile = relationshipsUri(workspaceRoot);
    const expectedRelationships: RelationshipsFile | null =
      (await exists(relationshipsFile)) || existing.length > 0
        ? { version: RELATIONSHIPS_FILE_VERSION, relationships: existing }
        : null;
    await writeWorkspaceFile(workspaceRoot,
      relationshipsFile,
      jsonBytes({ version: 1, relationships: merged }),
      expectedRelationships
    );

    return { status: 'ok', report };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

/**
 * Mark each auto-managed edge (label ∈ AUTO_LABELS) with
 * `metadata.isAtomic = true|false`. Atomicity is computed PER LABEL:
 * an A→B edge with label L is atomic iff no alternative path A→…→B of
 * length ≥ 2 exists using only label-L edges.
 *
 * Algorithm: bucket by label, for each edge BFS from source over
 * same-label edges excluding that one direct edge; if target reachable,
 * not atomic. O(V × (V+E)) per label.
 */
export function computeAtomicityInPlace(
  rels: RelationshipData[],
  shouldUpdate: (relationship: RelationshipData) => boolean = () => true
): void {
  for (const label of AUTO_LABELS) {
    const bucket: { rel: RelationshipData; idx: number }[] = [];
    rels.forEach((r) => {
      if (r.label === label) bucket.push({ rel: r, idx: bucket.length });
    });
    const adj = new Map<string, { to: string; edgeIdx: number }[]>();
    bucket.forEach(({ rel, idx }) => {
      if (!adj.has(rel.from)) adj.set(rel.from, []);
      adj.get(rel.from)!.push({ to: rel.to, edgeIdx: idx });
    });
    bucket.forEach(({ rel, idx: thisIdx }) => {
      if (!shouldUpdate(rel)) return;
      const seen = new Set<string>([rel.from]);
      const queue: string[] = [rel.from];
      let hit = false;
      while (queue.length > 0 && !hit) {
        const cur = queue.shift()!;
        const outs = adj.get(cur) ?? [];
        for (const e of outs) {
          if (cur === rel.from && e.edgeIdx === thisIdx) continue;
          if (e.to === rel.to) { hit = true; break; }
          if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
        }
      }
      const md = (rel.metadata ?? {}) as { isAtomic?: boolean } & Record<string, unknown>;
      md.isAtomic = !hit;
      rel.metadata = md;
    });
  }
}
