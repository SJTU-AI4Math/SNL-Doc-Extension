import * as vscode from 'vscode';
import type { Localized } from '@sjtu-ai4math/snl-basics';
import {
  is_valid_i18n_string,
  macro_template_variants,
  normalize_entry_content,
  normalize_macro_template
} from './localizedContent';
import { slugify } from './slug';
import { CURRENT_DATA_VERSION } from './dataMigrationCore';
import {
  assertJsonSnapshotUnchanged,
  assertWorkspaceDataVersionNotRegressed,
  assertWorkspaceDataWritable
} from './dataMigrations';
import { withWorkspaceDataLock } from './workspaceDataLock';

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

async function assertWorkspaceWritableOnDisk(workspaceRoot: vscode.Uri): Promise<unknown> {
  let rawConfig: unknown;
  try {
    rawConfig = await readJson<unknown>(configUri(workspaceRoot));
  } catch (error) {
    throw new Error(
      `Workspace data is not writable: config.json could not be read (${error instanceof Error ? error.message : String(error)}).`
    );
  }
  assertWorkspaceDataWritable(rawConfig);
  return rawConfig;
}

async function withExtensionWriterLock<T>(
  workspaceRoot: vscode.Uri,
  purpose: string,
  task: () => Promise<T>
): Promise<T> {
  return workspaceRoot.scheme === 'file'
    ? withWorkspaceDataLock(workspaceRoot, purpose, task)
    : task();
}

const NO_EXPECTED_SNAPSHOT = Symbol('no-expected-snapshot');

async function writeWorkspaceFile(
  workspaceRoot: vscode.Uri,
  uri: vscode.Uri,
  bytes: Uint8Array,
  expectedOriginal: unknown | typeof NO_EXPECTED_SNAPSHOT = NO_EXPECTED_SNAPSHOT
): Promise<void> {
  await withExtensionWriterLock(workspaceRoot, `write ${uri.fsPath}`, async () => {
    const currentConfig = await assertWorkspaceWritableOnDisk(workspaceRoot);
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
    await vscode.workspace.fs.writeFile(uri, bytes);
  });
}

/**
 * Lazily-created "SNL Macros" output channel. Mirrors InfoviewPanel's lazy
 * accessor pattern. Guarded so non-VS-Code hosts (the Node smoke shim, which
 * has no `vscode.window`) degrade to a no-op instead of throwing.
 */
let snlMacrosOutput: vscode.OutputChannel | null = null;
function macrosOutput(): vscode.OutputChannel | null {
  if (snlMacrosOutput) {
    return snlMacrosOutput;
  }
  try {
    const win = (vscode as { window?: typeof vscode.window }).window;
    if (win && typeof win.createOutputChannel === 'function') {
      snlMacrosOutput = win.createOutputChannel('SNL Macros');
      return snlMacrosOutput;
    }
  } catch {
    // Fall through to no-op.
  }
  return null;
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

export function librariesDirUri(workspaceRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(snlRootUri(workspaceRoot), 'libraries');
}

export function libraryDirUri(
  workspaceRoot: vscode.Uri,
  slug: string
): vscode.Uri {
  return vscode.Uri.joinPath(librariesDirUri(workspaceRoot), slug);
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
 *  - `coloring.stroke` / `coloring.background`: any CSS colour value; the
 *    Dashboard uses these to render both the swatch and the frame preview.
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
  name: string;
  coloring: { stroke: string; background: string };
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
 *  - `coloring.stroke` / `coloring.background`: any CSS colour value; drives
 *    both the swatch and the rendered frame in the view's KindPalette.
 *
 * Stored under `config.json#macro_kinds` (sibling of `entry_kinds`). Extra
 * on-disk fields survive round-trips; see {@link normalizeMacroKind}.
 */
export interface MacroKind {
  id: string;
  name: string;
  description: string;
  coloring: { stroke: string; background: string };
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
  const rawKinds = Array.isArray(cfg.entry_kinds) ? cfg.entry_kinds : [];
  const rawMacroKinds = Array.isArray(cfg.macro_kinds) ? cfg.macro_kinds : [];
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
  const activeMacroPackages =
    Array.isArray(rawActive) && rawActive.every((v) => typeof v === 'string')
      ? (rawActive as string[])
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

  let stroke = '#888888';
  let background = '#eeeeee';
  const coloringRaw = obj.coloring;
  if (coloringRaw && typeof coloringRaw === 'object') {
    const c = coloringRaw as Record<string, unknown>;
    if (typeof c.stroke === 'string') stroke = c.stroke;
    if (typeof c.background === 'string') background = c.background;
  } else if (typeof obj.color === 'string') {
    stroke = obj.color;
    background = obj.color;
  }

  return {
    id,
    name,
    description,
    coloring: { stroke, background }
  };
}

/**
 * Coerce a persisted entry-kind record (possibly from an older schema) into
 * the current {@link EntryKind} shape. Never throws — bad fields fall back
 * to safe defaults so the Dashboard always renders something.
 *
 * Migrations handled:
 *  - v0.0.2 `color: string` → `coloring.stroke = color`, background
 *    defaults to the same value at 20% alpha via a light overlay heuristic;
 *    we intentionally reuse `stroke` for background too when we can't
 *    guess, keeping the migration lossless-ish and visible.
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
  const name = typeof obj.name === 'string' ? obj.name : id;

  // coloring: prefer the new `{stroke, background}` shape, fall back to the
  // v0.0.2 flat `color` field.
  let stroke = '#888888';
  let background = '#eeeeee';
  const coloringRaw = obj.coloring;
  if (coloringRaw && typeof coloringRaw === 'object') {
    const c = coloringRaw as Record<string, unknown>;
    if (typeof c.stroke === 'string') stroke = c.stroke;
    if (typeof c.background === 'string') background = c.background;
  } else if (typeof obj.color === 'string') {
    // Legacy: single colour → use it for both, user can split later.
    stroke = obj.color;
    background = obj.color;
  }

  // defaultCounterName: prefer the new plain-string name. A legacy
  // `numbering` (string or v0.0.2 `{pattern}` object) is deliberately NOT
  // reinterpreted as a name — it coerces to '' (see block comment above).
  const defaultCounterName =
    typeof obj.defaultCounterName === 'string' ? obj.defaultCounterName : '';

  const style = typeof obj.style === 'string' ? obj.style : '';

  return {
    id,
    name,
    coloring: { stroke, background },
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
  const fsApi = vscode.workspace.fs;
  const root = snlRootUri(workspaceRoot);

  if (await exists(root)) {
    return { status: 'exists' };
  }

  const termMacrosDir = termMacrosDirUri(workspaceRoot);
  const librariesDir = librariesDirUri(workspaceRoot);

  await fsApi.createDirectory(root);
  await fsApi.createDirectory(termMacrosDir);
  await fsApi.createDirectory(librariesDir);

  const config: SnlConfig = {
    version: CURRENT_DATA_VERSION,
    entry_kinds: [],
    macro_kinds: []
  };
  await fsApi.writeFile(configUri(workspaceRoot), jsonBytes(config));

  // Shared entry pool — lives at .SNL_Doc/ top level.
  await fsApi.writeFile(entriesUri(workspaceRoot), jsonBytes([]));

  // .gitkeep placeholders so empty dirs survive `git add`.
  const gitkeep = ENCODER.encode('');
  await fsApi.writeFile(
    vscode.Uri.joinPath(termMacrosDir, '.gitkeep'),
    gitkeep
  );
  await fsApi.writeFile(
    vscode.Uri.joinPath(librariesDir, '.gitkeep'),
    gitkeep
  );

  return { status: 'created' };
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
  const root = snlRootUri(workspaceRoot);

  if (!(await exists(root))) {
    return { status: 'noSnlDoc' };
  }

  const trimmedTitle = (title ?? '').trim();
  const slug = slugify(trimmedTitle);
  const libDir = libraryDirUri(workspaceRoot, slug);
  if (await exists(libDir)) {
    return { status: 'duplicate', slug };
  }
  await assertWorkspaceWritableOnDisk(workspaceRoot);

  // Create library tree.
  const documentsDir = vscode.Uri.joinPath(libDir, 'documents');
  const typstDir = vscode.Uri.joinPath(documentsDir, 'Typst');
  const latexDir = vscode.Uri.joinPath(documentsDir, 'LaTeX');
  const markdownDir = vscode.Uri.joinPath(documentsDir, 'Markdown');

  await fsApi.createDirectory(libDir);
  await fsApi.createDirectory(documentsDir);
  await fsApi.createDirectory(typstDir);
  await fsApi.createDirectory(latexDir);
  await fsApi.createDirectory(markdownDir);

  await writeWorkspaceFile(workspaceRoot,
    libraryMetaUri(workspaceRoot, slug),
    jsonBytes({ title: trimmedTitle } satisfies LibraryMetaFile),
    null
  );
  await writeWorkspaceFile(workspaceRoot,
    libraryGraphUri(workspaceRoot, slug),
    jsonBytes({ nodes: [], relationships: [] } satisfies LibraryGraphFile),
    null
  );
  await writeWorkspaceFile(workspaceRoot,
    libraryCountersUri(workspaceRoot, slug),
    jsonBytes({ counters: [] } satisfies LibraryCountersFile),
    null
  );

  const gitkeep = ENCODER.encode('');
  await writeWorkspaceFile(workspaceRoot, vscode.Uri.joinPath(typstDir, '.gitkeep'), gitkeep, null);
  await writeWorkspaceFile(workspaceRoot, vscode.Uri.joinPath(latexDir, '.gitkeep'), gitkeep, null);
  await writeWorkspaceFile(workspaceRoot,
    vscode.Uri.joinPath(markdownDir, '.gitkeep'),
    gitkeep,
    null
  );

  return { status: 'created', slug, title: trimmedTitle };
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
  workspaceRoot: vscode.Uri
): Promise<MacroPackageSummary[]> {
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
/**
 * One strict Macro v8 render style, extended with consumer-owned output
 * backends (typst / latex / markdown / text) which live per style.
 */
interface MacroPackageStyleBase {
  /** Style token used in `foo[style](…)`. Must be unique per macro. */
  style_name: string;
  /** Separator between children substituted at `#*`. */
  separator?: string;
  /** Free-text labels attached to this style (backslash forbidden). */
  tags: string[];
  // Extended (consumer-owned) output backends per style:
  typst?: { built_in: string; synthesis: { mode: 'formula' | 'text'; macro: string } };
  latex?: { built_in: string; synthesis: { mode: 'formula' | 'text'; macro: string } };
  markdown?: string;
  text?: string;
}

export interface InvariantMacroPackageStyle extends MacroPackageStyleBase {
  mode: 'formula_inline' | 'formula_display' | 'block';
  template: string;
  /** Named block renderer; valid only for block mode. */
  block_template_name?: string;
}

export interface TextMacroPackageStyle extends MacroPackageStyleBase {
  mode: 'text';
  template: string;
  block_template_name?: never;
}

export type MacroPackageStyle = InvariantMacroPackageStyle | TextMacroPackageStyle;

export interface MacroPackageEntry {
  name: string;
  description: string;
  source: { entries: string[]; urls: string[] };
  /** Semantic kind (optional). Unset → rendered nodes default to `fvar`. */
  kind?: string;
  dynamic_arity: boolean;
  /** Language → implicit style name; renderer falls back through en then styles[0]. */
  default_style: Record<string, string>;
  /** Ordered styles; styles[0] is the final fallback. */
  styles: MacroPackageStyle[];
  /** Free-text labels attached to the macro itself (backslash forbidden). */
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
const MACRO_FILE_RE = /^[a-zA-Z0-9_-]+$/;
const MACRO_PACKAGE_VERSION = '8';

/** Strip a trailing `.json` (case-insensitive) from a package file argument. */
function stripJsonExt(file: string): string {
  return file.replace(/\.json$/i, '');
}

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

function isStringRecord(value: unknown): value is Record<string, string> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string');
}

/** v7 → v8: split localized text templates and add language default styles. */
function v7MacroToV8(input: Record<string, unknown>): MacroPackageEntry {
  const rawStyles = Array.isArray(input.styles)
    ? input.styles.map((style) => ({ ...(style as Record<string, unknown>) }))
    : [];
  const styles: MacroPackageStyle[] = [];
  const default_style = isStringRecord(input.default_style)
    ? { ...input.default_style }
    : {};

  rawStyles.forEach((style, styleIndex) => {
    const styleName = typeof style.style_name === 'string' ? style.style_name : `style${styleIndex}`;
    if (is_valid_i18n_string(style.template)) {
      throw new Error(
        `style ${styleName} has a localized template; Macro v8 cannot preserve ` +
        'language-dependent explicit [style] semantics. Split it manually before workspace migration.'
      );
    }
    styles.push({
      ...style,
      style_name: styleName,
      template: normalize_macro_template(
        style.mode as 'formula_inline' | 'formula_display' | 'text' | 'block',
        style.template
      )
    } as MacroPackageStyle);
    if (styleIndex === 0 && Object.keys(default_style).length === 0) {
      default_style.en = styleName;
    }
  });

  return {
    ...input,
    name: typeof input.name === 'string' ? input.name : '',
    description: typeof input.description === 'string' ? input.description : '',
    source: {
      entries: Array.isArray((input.source as { entries?: unknown } | undefined)?.entries)
        ? (input.source as { entries: string[] }).entries : [],
      urls: Array.isArray((input.source as { urls?: unknown } | undefined)?.urls)
        ? (input.source as { urls: string[] }).urls : []
    },
    dynamic_arity: input.dynamic_arity === true,
    default_style,
    styles,
    tags: Array.isArray(input.tags) && input.tags.every((tag) => typeof tag === 'string')
      ? input.tags as string[] : []
  };
}

/**
 * Explicit Macro v6 → v7 input migration. Legacy names are confined to this
 * boundary; callers may then apply the explicit v7 → v8 migration.
 * Unknown extension fields and consumer-owned output backends survive the shallow copies.
 */
function v6MacroToV7(input: Record<string, unknown>): Record<string, unknown> {
  const rawStyles = Array.isArray(input.styles) ? input.styles : [];
  const styles = rawStyles.map((value, index): MacroPackageStyle => {
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
    const style: MacroPackageStyle = mode === 'text'
      ? {
          ...styleBase,
          mode,
          template: dynamicTemplate ?? (
            is_valid_i18n_string(raw.template)
              ? raw.template
              : normalize_macro_template('text', raw.template)
          )
        } as unknown as MacroPackageStyle
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
        `v8 styles array (${reason}); normalizing entries independently`
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
        trimmed[k] = v;
      }
    }
    pushKeyed(trimmed);
    return groupMacrosToStyles(collected);
  }
  return [];
}

function normalizeMacros(raw: unknown): MacroPackageEntry[] {
  return normalizeMacrosV7(raw).map((macro) => v7MacroToV8(macro));
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
  const fsApi = vscode.workspace.fs;
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }

  const bare = typeof file === 'string' ? stripJsonExt(file.trim()) : '';
  if (!MACRO_FILE_RE.test(bare)) {
    return {
      status: 'invalid',
      reason: 'file must match [a-zA-Z0-9_-]+ (no path, no dots)'
    };
  }
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (!name) {
    return { status: 'invalid', reason: 'displayName is required' };
  }

  const target = macroPackageUri(workspaceRoot, bare);
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
    // Ensure the term_macros/ directory exists first.
    await fsApi.createDirectory(termMacrosDirUri(workspaceRoot));
    await writeWorkspaceFile(workspaceRoot, target, jsonBytes(pkg), null);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  // Newly-created packages default to active. Resolve the current effective
  // active set (migrating older configs to "all on disk") and persist it with
  // this package included, materializing the field on first create.
  try {
    await setMacroPackageActive(workspaceRoot, bare, true);
  } catch {
    // Config missing/unwritable — the package file was still created.
  }
  return { status: 'ok', file: `${bare}.json` };
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
  raw: unknown
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

  const macrosMap: Record<string, MacroPackageEntryWithoutName> = {};
  for (const m of macros) {
    const { name, ...rest } = m;
    macrosMap[name] = rest;
  }

  const pkg: MacroPackageFile = {
    version: MACRO_PACKAGE_VERSION,
    name: pkgName,
    macros: macrosMap
  };
  if (pkgDescription) {
    pkg.description = pkgDescription;
  }

  return { status: 'ok', pkg, macros };
}

/**
 * Canonicalize any supported historical Macro package shape to the current v8
 * wrapper while preserving wrapper-level extension fields. Used by explicit
 * workspace data migrations; ordinary reads remain non-mutating.
 */
export function canonicalizeMacroPackageData(
  file: string,
  raw: unknown,
  targetVersion: '7' | '8' = '8'
): Record<string, unknown> {
  const bare = stripJsonExt(file);
  const wrapper = raw && typeof raw === 'object' && !Array.isArray(raw) &&
    'macros' in (raw as Record<string, unknown>)
    ? raw as Record<string, unknown>
    : {};

  if (targetVersion === '7') {
    const macros = normalizeMacrosV7(raw);
    const macrosMap: Record<string, unknown> = {};
    for (const macro of macros) {
      const name = typeof macro.name === 'string' ? macro.name : '';
      const { name: _drop, ...rest } = macro;
      macrosMap[name] = rest;
    }
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

  const result = buildMacroPackageResult(bare, raw);
  if (result.status === 'error') {
    throw new Error(`${file}: ${result.message}`);
  }
  return {
    ...wrapper,
    ...result.pkg
  };
}

/**
 * Read every macro from every package under the workspace and return them
 * as a flat map keyed by macro name (last-writer-wins on collisions —
 * matches how consumers merge multiple package files into a single lookup
 * for parsing / rendering).
 *
 * Result rows use the extended v8 on-disk shape (typst / latex / markdown /
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
  // `listMacroPackageNames` instead of `readMacroPackages`: we are about to
  // read each package in full anyway, so parsing them once more just to
  // compute a discarded macroCount is wasted work.
  const [onDisk, active] = await Promise.all([
    listMacroPackageNames(workspaceRoot),
    resolveActiveMacroPackages(workspaceRoot)
  ]);
  const activeSet = new Set(active);
  const out: Record<string, MacroPackageEntry> = {};
  // Track which active package first defined each name so we can report the
  // two colliding packages (Feature 3 will make this actionable).
  const origin: Record<string, string> = {};

  // Sort on the FILE name, not the bare name, so "last write wins" resolves
  // name collisions exactly as it did when this walked `readMacroPackages`
  // output. The two orders differ: `core.json` sorts before `core-extra.json`,
  // but bare `core-extra` sorts before `core`. Review 2026-07-25.
  const activePackages = onDisk
    .filter((bare) => activeSet.has(bare))
    .sort((a, b) => `${a}.json`.localeCompare(`${b}.json`));
  // Read concurrently, then fold in that order regardless of which I/O
  // finished first.
  const loaded = await Promise.all(
    activePackages.map(async (bare) => ({
      bare,
      read: await readMacroPackage(workspaceRoot, `${bare}.json`)
    }))
  );

  for (const { bare, read } of loaded) {
    if (read.status !== 'ok') continue;
    for (const macro of read.macros) {
      if (typeof macro.name === 'string' && macro.name.length > 0) {
        if (Object.prototype.hasOwnProperty.call(out, macro.name)) {
          macrosOutput()?.appendLine(
            `[warn] macro name conflict: "${macro.name}" in packages: ` +
              `${origin[macro.name]}, ${bare}. ` +
              `Last write wins (order-dependent).`
          );
        }
        out[macro.name] = macro;
        origin[macro.name] = bare;
      }
    }
  }
  return { macros: out, origin };
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
      .catch((): SnlConfig | null => null)
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
  workspaceRoot: vscode.Uri
): Promise<string[]> {
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
  } catch {
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
  const fsApi = vscode.workspace.fs;
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
    const current = new Set(await resolveActiveMacroPackages(workspaceRoot));
    if (active) current.add(bare);
    else current.delete(bare);
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
}

/** Validate the structural invariants of a single {@link MacroPackageEntry}. */
function validateMacro(macro: MacroPackageEntry): string | null {
  const name = typeof macro?.name === 'string' ? macro.name.trim() : '';
  if (!name) {
    return 'name is required';
  }
  // Naming rule (2026-07-04-late 猫猫 spec 1 + spec 3-update):
  //   ASCII-forbidden set: @ # $ % whitespace ( ) [ ] { }
  //   Everything else — including backslash, dots, Unicode letters, digits,
  //   emoji — is allowed. The forbidden characters are all reserved by the
  //   SNL syntax (delimiters / bracket forms) or would produce ambiguous
  //   parses; everything else is fair game for user naming.
  const forbidden = /[@#$%\s(){}\[\]]/;
  if (forbidden.test(name)) {
    return (
      'name may not contain @ # $ % whitespace ( ) [ ] { } — ' +
      'these characters are reserved by the SNL parser'
    );
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
    const styleName =
      typeof style.style_name === 'string' ? style.style_name.trim() : '';
    if (!styleName) {
      return `styles[${i}].style_name is required`;
    }
    if (seen.has(styleName)) {
      return `styles[${i}].style_name "${styleName}" is duplicated`;
    }
    seen.add(styleName);
    if (
      style.mode !== 'formula_inline' &&
      style.mode !== 'formula_display' &&
      style.mode !== 'text' &&
      style.mode !== 'block'
    ) {
      return `styles[${i}].mode must be one of 'formula_inline', 'formula_display', 'text', 'block'`;
    }
    let templates: string[];
    try {
      templates = macro_template_variants(style.mode, style.template);
    } catch (error) {
      return `styles[${i}].template is invalid: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (templates.length === 0 || templates.some((template) => template.trim().length === 0)) {
      return `styles[${i}].template is required`;
    }
    if (macro.dynamic_arity && templates.some((template) => !template.includes('#*'))) {
      return `styles[${i}].template must contain #* for a dynamic macro`;
    }
    if (style.separator !== undefined && typeof style.separator !== 'string') {
      return `styles[${i}].separator must be a string`;
    }
    if (style.mode !== 'block' && style.block_template_name !== undefined) {
      return `styles[${i}].block_template_name is valid only in block mode`;
    }
    const raw = style as unknown as Record<string, unknown>;
    for (const legacyKey of [
      'tag', 'variadic_left', 'variadic_join', 'variadic_right',
      'react_renderer_key', 'display'
    ]) {
      if (legacyKey in raw) {
        return `styles[${i}].${legacyKey} is not valid in Macro v8`;
      }
    }
  }
  if (!isStringRecord(macro.default_style)) {
    return 'default_style must be a language-to-style-name object';
  }
  for (const [language, styleName] of Object.entries(macro.default_style)) {
    if (!language.trim()) return 'default_style language keys must be non-empty';
    if (!seen.has(styleName)) {
      return `default_style[${JSON.stringify(language)}] references unknown style "${styleName}"`;
    }
  }
  // Tags are required string arrays in v8; backslashes remain forbidden.
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
  const fsApi = vscode.workspace.fs;

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
    await writeWorkspaceFile(workspaceRoot,
      macroPackageUri(workspaceRoot, file),
      jsonBytes(next),
      read.raw
    );
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

export interface SnlOverview {
  hasSnlDoc: boolean;
  totalEntryCount: number | null; // size of the shared entries.json pool
  /** The shared entry pool from `entries.json` (empty when missing/corrupt). */
  entries: EntryData[];
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
  workspaceRoot: vscode.Uri
): Promise<SnlOverview> {
  const root = snlRootUri(workspaceRoot);
  if (!(await exists(root))) {
    return {
      hasSnlDoc: false,
      totalEntryCount: null,
      entries: [],
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
  const [entries, config, discovered, packageNames, relationships] =
    await Promise.all([
      readEntries(workspaceRoot),
      readJson<unknown>(configUri(workspaceRoot))
        .then((raw) => normalizeConfig(raw))
        .catch((): SnlConfig | null => null),
      // Discover libraries by scanning the on-disk `libraries/` tree (per cat
      // 2026-07-06: config is no longer the source of truth). `listLibraries`
      // reads each meta.json (falling back to the slug when missing) and
      // hands us back {slug, title} pairs.
      listLibraries(workspaceRoot),
      // Names only — we read each package's bytes exactly once below and
      // derive BOTH the summary (macroCount) and the macro rows from it.
      listMacroPackageNames(workspaceRoot),
      readRelationships(workspaceRoot)
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
  const loaded = await Promise.all(
    packageNames.map(async (bare) => {
      const file = `${bare}.json`;
      try {
        const raw = await readJson<unknown>(
          macroPackageUri(workspaceRoot, bare)
        );
        return { file, raw, ok: true as const };
      } catch {
        // Unreadable / corrupt JSON: summary still appears with a null count,
        // and it contributes no macros. Matches the old best-effort split of
        // `readMacroPackages` + `readMacroPackage`.
        return { file, raw: undefined, ok: false as const };
      }
    })
  );
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
        metricMacroSources[macro.name] = {
          source: {
            entries: Array.isArray(macro.source?.entries) ? macro.source.entries : [],
            urls: Array.isArray(macro.source?.urls) ? macro.source.urls : []
          }
        };
      }
    }
  }
  allMacros.sort((a, b) =>
    a.packageFile === b.packageFile
      ? a.id.localeCompare(b.id)
      : a.packageFile.localeCompare(b.packageFile),
  );

  return {
    hasSnlDoc: true,
    totalEntryCount,
    entries,
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
  try {
    const cfg = normalizeConfig(await readJson<unknown>(configUri(workspaceRoot)));
    return cfg.entry_kinds ?? [];
  } catch {
    return [];
  }
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
  const fsApi = vscode.workspace.fs;
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
    const preset = ENTRY_KIND_PRESETS.find((p) => p.id === presetId);
  if (!preset) {
    return { status: 'unknownPreset', presetId };
  }
  const existing = await readEntryKinds(workspaceRoot);
  if (existing.length > 0) {
    return { status: 'nonEmpty', existing: existing.length };
  }
  // Clone the preset kinds so callers can't accidentally mutate the source
  // table by editing the returned config later.
  const kinds = preset.kinds.map((k) => ({
    id: k.id,
    name: k.name,
    coloring: { stroke: k.coloring.stroke, background: k.coloring.background },
    defaultCounterName: k.defaultCounterName,
    style: k.style
  }));
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
    name: string;
    stroke: string;
    background: string;
    defaultCounterName: string;
    style: string;
  }
): Promise<CreateEntryKindResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  return withExtensionWriterLock(workspaceRoot, 'create entry kind', async () => {
    const id = (input.id ?? '').trim();
  const name = (input.name ?? '').trim();
  if (!id) {
    return { status: 'invalid', message: 'id is required' };
  }
  if (!name) {
    return { status: 'invalid', message: 'name is required' };
  }
  const existing = await readEntryKinds(workspaceRoot);
  if (existing.some((k) => k.id === id)) {
    return { status: 'duplicate', id };
  }
  const kind: EntryKind = {
    id,
    name,
    coloring: {
      stroke: (input.stroke ?? '').trim() || '#888888',
      background: (input.background ?? '').trim() || '#eeeeee'
    },
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
  try {
    const cfg = normalizeConfig(await readJson<unknown>(configUri(workspaceRoot)));
    return cfg.macro_kinds ?? [];
  } catch {
    return [];
  }
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
  const fsApi = vscode.workspace.fs;
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
    const preset = MACRO_KIND_PRESETS.find((p) => p.id === presetId);
  if (!preset) {
    return { status: 'unknownPreset', presetId };
  }
  const existing = await readMacroKinds(workspaceRoot);
  if (existing.length > 0) {
    return { status: 'nonEmpty', existing: existing.length };
  }
  const kinds = preset.kinds.map((k) => ({
    id: k.id,
    name: k.name,
    description: k.description,
    coloring: { stroke: k.coloring.stroke, background: k.coloring.background }
  }));
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
    coloring: { stroke: string; background: string };
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
    coloring: {
      stroke: (input.coloring?.stroke ?? '').trim() || '#888888',
      background: (input.coloring?.background ?? '').trim() || '#eeeeee'
    }
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
 *  - `title`: display title (English for now; i18n later).
 *  - `content`: at most one non-empty format in practice, but all optional —
 *    the editor lets the author fill any subset.
 *  - `contribution_info` / `pointer`: schemas deferred; stored verbatim.
 */
export interface EntryData {
  id: string;
  kind: string;
  title: string;
  content: {
    snl?: string;
    typst?: Localized<string, string>;
    latex?: Localized<string, string>;
    markdown?: Localized<string, string>;
    text?: Localized<string, string>;
  };
  contribution_info: unknown;
  // Optional structured pointer to a location in a source file (cat
  // 2026-07-11). `null` when unset. See src/pointer.ts for the shape
  // and resolver.
  pointer: import('./pointer').EntryPointer | null | unknown;
}

export type AddEntryResult =
  | { status: 'ok'; id: string }
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
  const fsApi = vscode.workspace.fs;
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }

  const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
  const kind = typeof entry?.kind === 'string' ? entry.kind.trim() : '';
  // Title is optional as of 2026-07-06 (cat: "支持无标题或无内容的 entry").
  // We keep the field always present in on-disk shape but accept the empty
  // string; the UI renders "(untitled)" in place of a title bar.
  const title = typeof entry?.title === 'string' ? entry.title.trim() : '';

  if (!id) {
    return { status: 'invalid', reason: 'id is required' };
  }
  if (!kind) {
    return { status: 'invalid', reason: 'kind is required' };
  }
  // content is now also optional. If unset or non-object, coerce to
  // `{ snl: '' }` so the on-disk row always parses.

  // kind must reference an existing entry kind.
  const kinds = await readEntryKinds(workspaceRoot);
  if (!kinds.some((k) => k.id === kind)) {
    return { status: 'unknownKind', kind };
  }

  // Refuse to write over a malformed existing pool. Missing is a valid empty
  // workspace state; corrupt/non-array JSON is not.
  let pool: EntryData[] = [];
  const poolUri = entriesUri(workspaceRoot);
  if (await exists(poolUri)) {
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
  const record: EntryData = {
    id,
    kind,
    title,
    content: normalizedContent,
    contribution_info: entry.contribution_info ?? null,
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
    await writeWorkspaceFile(
      workspaceRoot,
      entriesUri(workspaceRoot),
      jsonBytes([...pool, record]),
      pool
    );
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'ok', id };
}

/**
 * Read the shared entry pool from `.SNL_Doc/entries.json`.
 *
 * Returns the parsed array of {@link EntryData}. On a missing or corrupt file
 * (or a non-array top level) returns `[]`. Non-object items are filtered out
 * defensively so a partially hand-edited pool can't crash the dashboard.
 */
export async function readEntries(
  workspaceRoot: vscode.Uri
): Promise<EntryData[]> {
  try {
    const raw = await readJson<unknown>(entriesUri(workspaceRoot));
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter(
      (e): e is EntryData => e !== null && typeof e === 'object'
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Entry Kind Presets
// ---------------------------------------------------------------------------

export interface EntryKindPreset {
  id: string;
  label: string;
  description: string;
  kinds: EntryKind[];
}

/**
 * Built-in preset catalog. `Fulcrum's Math Notes` is transcribed from the
 * 12 `#let *条目 = entry(...)` declarations in
 * `Fulcrum-Notes-Typst/Fulcrum-Template-Typst/FulcrumCN.typ` (colours,
 * counter role, and box style preserved). The other three presets are
 * placeholders — their concrete kind lists will be filled in as each
 * ecosystem's writing conventions get formalized.
 *
 * `defaultCounterName` — 2026-07-16: each kind seeds the NAME of a
 * Library-scoped counter (a plain string matched by `counter.name`), not a
 * DSL. The slug of the English kind name is used (`Definition` →
 * `"definition"`). No counter is auto-created; if a library has no counter
 * with that name, the kind simply contributes no numbering.
 */
export const ENTRY_KIND_PRESETS: EntryKindPreset[] = [
  {
    id: 'fulcrum-math-notes',
    label: "Fulcrum's Math Notes",
    description:
      'Chapter/Section/Subsection scaffolding + 12 Fulcrum-Notes-Typst content kinds (Definition/Axiom/Lemma/Theorem/Corollary/Property/Remark/Example/Counterexample/Construction/Proof/Problem). Each kind seeds a defaultCounterName (slug of its English name).',
    kinds: [
      // Structural kinds — parents that decide the numbering of their level.
      {
        id: 'chapter',
        name: 'Chapter',
        coloring: { stroke: '#787878', background: '#F0F0F0' },
        defaultCounterName: 'chapter',
        style: 'section'
      },
      {
        id: 'section',
        name: 'Section',
        coloring: { stroke: '#787878', background: '#F0F0F0' },
        defaultCounterName: 'section',
        style: 'section'
      },
      {
        id: 'subsection',
        name: 'Subsection',
        coloring: { stroke: '#787878', background: '#F0F0F0' },
        defaultCounterName: 'subsection',
        style: 'section'
      },
      // Content kinds.
      {
        id: 'definition',
        name: 'Definition',
        coloring: { stroke: '#009C27', background: '#D6FEE0' },
        defaultCounterName: 'definition',
        style: ''
      },
      {
        id: 'axiom',
        name: 'Axiom',
        coloring: { stroke: '#C1C103', background: '#FFFFAC' },
        defaultCounterName: 'axiom',
        style: ''
      },
      {
        id: 'lemma',
        name: 'Lemma',
        coloring: { stroke: '#005B9C', background: '#DAF0FF' },
        defaultCounterName: 'lemma',
        style: ''
      },
      {
        id: 'theorem',
        name: 'Theorem',
        coloring: { stroke: '#005B9C', background: '#DAF0FF' },
        defaultCounterName: 'theorem',
        style: ''
      },
      {
        id: 'corollary',
        name: 'Corollary',
        coloring: { stroke: '#005B9C', background: '#DAF0FF' },
        defaultCounterName: 'corollary',
        style: ''
      },
      {
        id: 'property',
        name: 'Property',
        coloring: { stroke: '#AC00AF', background: '#FFEDFF' },
        defaultCounterName: 'property',
        style: ''
      },
      {
        id: 'remark',
        name: 'Remark',
        coloring: { stroke: '#E07B00', background: '#FFEBD2' },
        defaultCounterName: 'remark',
        style: 'remark'
      },
      {
        id: 'example',
        name: 'Example',
        coloring: { stroke: '#7700E4', background: '#EFDFFF' },
        defaultCounterName: 'example',
        style: ''
      },
      {
        id: 'counterexample',
        name: 'Counterexample',
        coloring: { stroke: '#D20022', background: '#FFD6DC' },
        defaultCounterName: 'counterexample',
        style: ''
      },
      {
        id: 'construction',
        name: 'Construction',
        coloring: { stroke: '#787878', background: '#F0F0F0' },
        defaultCounterName: 'construction',
        style: 'proof'
      },
      {
        id: 'proof',
        name: 'Proof',
        coloring: { stroke: '#787878', background: '#F0F0F0' },
        defaultCounterName: 'proof',
        style: 'proof'
      },
      {
        id: 'problem',
        name: 'Problem',
        coloring: { stroke: '#005B9C', background: '#DAF0FF' },
        defaultCounterName: 'problem',
        style: 'problem'
      },
      // Cat 2026-07-09: `context` = an entry whose top-level `@x` bvar
      // decls are meant to be referenced from OTHER entries via the
      // `x@<this-entry-id>` src postfix. Behaviorally identical to any
      // other content kind — the UI does NOT branch on it; it's here
      // just so the pattern has a name users can pick. Numbering ''
      // (unnumbered) because a shared-variable block usually isn't a
      // theorem-numbering peer.
      {
        id: 'context',
        name: 'Context',
        coloring: { stroke: '#8B5CF6', background: '#EDE9FE' },
        defaultCounterName: 'context',
        style: ''
      }
    ]
  },
  {
    id: 'lean4-document',
    label: 'Lean 4 Document',
    description:
      'Entry kinds for a Lean 4 code-mirrored document (placeholder — to be filled in with the Lean side of the mirror).',
    kinds: []
  },
  {
    id: 'typescript-document',
    label: 'TypeScript Document',
    description:
      'Entry kinds for a TypeScript code-mirrored document (placeholder).',
    kinds: []
  },
  {
    id: 'python-document',
    label: 'Python Document',
    description:
      'Entry kinds for a Python code-mirrored document (placeholder).',
    kinds: []
  }
];

// ---------------------------------------------------------------------------
// Macro Kind Presets
// ---------------------------------------------------------------------------

export interface MacroKindPreset {
  id: string;
  label: string;
  description: string;
  kinds: MacroKind[];
}

/**
 * Built-in macro-kind preset catalog. The single `snl-basics-defaults` preset
 * mirrors SNL-Basics's `DEFAULT_KIND_PALETTE` (the 5 Lean-Expr default kinds),
 * so a fresh project's macro kinds match the library's out-of-the-box colors.
 */
export const MACRO_KIND_PRESETS: MacroKindPreset[] = [
  {
    id: 'snl-basics-defaults',
    label: 'SNL-Basics defaults',
    description:
      "The 5 default macro kinds from SNL-Basics's DEFAULT_KIND_PALETTE (rule / const / bvar / binder / fvar), plus a 'partial' kind for helper subtrees that shouldn't fire hover feedback (e.g. matrix rows).",
    kinds: [
      {
        id: 'rule',
        name: 'Rule',
        description:
          'Meta-mathematical rule symbols (∀, ∃, `:`, `def`, apply, implies, paren…).',
        coloring: { stroke: '#009C27', background: '#D6FEE0' }
      },
      {
        id: 'const',
        name: 'Const',
        description: 'Mathematical constants / defined terms (add, mul, and, or…).',
        coloring: { stroke: '#005B9C', background: '#DAF0FF' }
      },
      {
        id: 'bvar',
        name: 'Bound variable',
        description: 'Bound-variable occurrences.',
        coloring: { stroke: '#7700E4', background: '#EFDFFF' }
      },
      {
        id: 'binder',
        name: 'Binder',
        description: 'Binding sites (∀-`x`, λ parameter, informal `dx`…).',
        coloring: { stroke: '#E07B00', background: '#FFEBD2' }
      },
      {
        id: 'fvar',
        name: 'Free variable',
        description: 'Free variables (undefined, effectively `sorry`s).',
        coloring: { stroke: '#D20022', background: '#FFD6DC' }
      },
      {
        id: 'partial',
        name: 'Partial',
        description:
          "Helper subtree that is NOT a complete syntactic node — e.g. a matrix.row inside a Matrix macro. Rendered with no visual frame, and hover feedback skips over it to its parent macro. Use for implementation-only intermediate macros that shouldn't attract user attention.",
        coloring: { stroke: 'inherit', background: 'transparent' }
      }
    ]
  }
];

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
  { status: 'updated'; kind: EntryKind }
>;

/**
 * Update an existing entry kind IN PLACE, keyed by `id`. `id` itself is
 * never modified (it's the lookup key). Missing kinds → `notFound`.
 */
export async function updateEntryKind(
  workspaceRoot: vscode.Uri,
  id: string,
  input: {
    name: string;
    stroke: string;
    background: string;
    defaultCounterName: string;
    style: string;
  }
): Promise<UpdateEntryKindResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  return withExtensionWriterLock(workspaceRoot, 'update entry kind', async () => {
    const targetId = (id ?? '').trim();
  if (!targetId) {
    return { status: 'invalid', message: 'id is required' };
  }
  const name = (input.name ?? '').trim();
  if (!name) {
    return { status: 'invalid', message: 'name is required' };
  }
  const existing = await readEntryKinds(workspaceRoot);
  const idx = existing.findIndex((k) => k.id === targetId);
  if (idx < 0) {
    return { status: 'notFound', id: targetId };
  }
  const next: EntryKind = {
    id: targetId,
    name,
    coloring: {
      stroke: (input.stroke ?? '').trim() || '#888888',
      background: (input.background ?? '').trim() || '#eeeeee'
    },
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
  { status: 'updated'; kind: MacroKind }
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
    coloring: { stroke: string; background: string };
  }
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
  const next: MacroKind = {
    id: targetId,
    name,
    description: (input.description ?? '').trim(),
    coloring: {
      stroke: (input.coloring?.stroke ?? '').trim() || '#888888',
      background: (input.coloring?.background ?? '').trim() || '#eeeeee'
    }
  };
  const kinds = existing.slice();
  kinds[idx] = next;
    await writeMacroKinds(workspaceRoot, kinds);
    return { status: 'updated', kind: next };
  });
}

export type UpdateLibraryResult = UpdateResult<
  { status: 'updated'; slug: string; title: string }
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
  input: { title: string; description?: string }
): Promise<UpdateLibraryResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  const targetSlug = (slug ?? '').trim();
  if (!targetSlug) {
    return { status: 'invalid', message: 'slug is required' };
  }
  const title = (input.title ?? '').trim();
  if (!title) {
    return { status: 'invalid', message: 'title is required' };
  }
  const libDir = libraryDirUri(workspaceRoot, targetSlug);
  if (!(await exists(libDir))) {
    return { status: 'notFound', id: targetSlug };
  }

  const fsApi = vscode.workspace.fs;
  // Merge into existing meta if present so we preserve unknown fields.
  let existing: LibraryMetaFile = {};
  try {
    const raw = await readJson<unknown>(libraryMetaUri(workspaceRoot, targetSlug));
    if (raw && typeof raw === 'object') {
      existing = raw as LibraryMetaFile;
    }
  } catch {
    // File missing or unreadable: start fresh.
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
    libraryMetaUri(workspaceRoot, targetSlug),
    jsonBytes(next),
    existing
  );
  return { status: 'updated', slug: targetSlug, title };
}

export type UpdateEntryResult = UpdateResult<
  { status: 'updated'; id: string },
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
  entry: Omit<EntryData, 'id'>
): Promise<UpdateEntryResult> {
  const fsApi = vscode.workspace.fs;
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  const targetId = (id ?? '').trim();
  if (!targetId) {
    return { status: 'invalid', message: 'id is required' };
  }
  const kind = typeof entry?.kind === 'string' ? entry.kind.trim() : '';
  // Title and content are optional as of 2026-07-06 (see addEntry note).
  const title = typeof entry?.title === 'string' ? entry.title.trim() : '';
  if (!kind) {
    return { status: 'invalid', message: 'kind is required' };
  }
  const kinds = await readEntryKinds(workspaceRoot);
  if (!kinds.some((k) => k.id === kind)) {
    return { status: 'unknownKind', kind };
  }

  let pool: EntryData[] = [];
  try {
    const raw = await readJson<unknown>(entriesUri(workspaceRoot));
    if (Array.isArray(raw)) {
      pool = raw as EntryData[];
    }
  } catch {
    pool = [];
  }
  const idx = pool.findIndex((e) => e && typeof e === 'object' && e.id === targetId);
  if (idx < 0) {
    return { status: 'notFound', id: targetId };
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
  const record: EntryData = {
    id: targetId,
    kind,
    title,
    content: normalizedContent,
    contribution_info: entry.contribution_info ?? null,
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
    await writeWorkspaceFile(workspaceRoot, entriesUri(workspaceRoot), jsonBytes(next), pool);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'updated', id: targetId };
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
  input: { name: string; description: string }
): Promise<UpdateMacroPackageResult> {
  const fsApi = vscode.workspace.fs;
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  const bare = typeof file === 'string' ? stripJsonExt(file.trim()) : '';
  if (!MACRO_FILE_RE.test(bare)) {
    return {
      status: 'invalid',
      message: 'file must match [a-zA-Z0-9_-]+ (no path, no dots)'
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
    await writeWorkspaceFile(
      workspaceRoot,
      macroPackageUri(workspaceRoot, bare),
      jsonBytes(next),
      read.raw
    );
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
  macro: MacroPackageEntry
): Promise<UpdateMacroResult> {
  const fsApi = vscode.workspace.fs;
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

  // Rebuild the map preserving insertion order — plain object iteration in
  // V8 preserves insertion order for string keys, so simply replacing the
  // value under `name` keeps its position in the file.
  const { name: _drop, ...rest } = macro;
  const nextMacros: Record<string, MacroPackageEntryWithoutName> = {};
  for (const [key, val] of Object.entries(read.pkg.macros)) {
    nextMacros[key] = key === name ? { ...rest } : val;
  }
  const next: MacroPackageFile = { ...read.pkg, macros: nextMacros };

  try {
    await writeWorkspaceFile(workspaceRoot,
      macroPackageUri(workspaceRoot, file),
      jsonBytes(next),
      read.raw
    );
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
  const fsApi = vscode.workspace.fs;
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
    nextMacros[key] = val;
  }

  const next: MacroPackageFile = { ...read.pkg, macros: nextMacros };
  try {
    await writeWorkspaceFile(workspaceRoot,
      macroPackageUri(workspaceRoot, sourceFile),
      jsonBytes(next),
      read.raw
    );
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
  const fsApi = vscode.workspace.fs;
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
    nextSrcMacros[key] = val;
  }
  const nextDestMacros: Record<string, MacroPackageEntryWithoutName> = {
    ...destRead.pkg.macros
  };
  for (const n of moving) {
    nextDestMacros[n] = srcRead.pkg.macros[n];
  }

  const nextSrc: MacroPackageFile = { ...srcRead.pkg, macros: nextSrcMacros };
  const nextDest: MacroPackageFile = { ...destRead.pkg, macros: nextDestMacros };
  try {
    // Write destination first: if the source write then fails the macros
    // exist in both places (recoverable) rather than being lost entirely.
    await writeWorkspaceFile(
      workspaceRoot,
      macroPackageUri(workspaceRoot, destBare),
      jsonBytes(nextDest),
      destRead.raw
    );
    await writeWorkspaceFile(
      workspaceRoot,
      macroPackageUri(workspaceRoot, srcBare),
      jsonBytes(nextSrc),
      srcRead.raw
    );
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
  newDescription?: string
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

  const bare = typeof newFile === 'string' ? stripJsonExt(newFile.trim()) : '';
  if (!MACRO_FILE_RE.test(bare)) {
    return {
      status: 'invalid',
      reason: 'file must match [a-zA-Z0-9_-]+ (no path, no dots)'
    };
  }
  const displayName =
    (typeof newDisplayName === 'string' && newDisplayName.trim()) || bare;

  const created = await createMacroPackage(
    workspaceRoot,
    bare,
    displayName,
    typeof newDescription === 'string' ? newDescription : undefined
  );
  if (created.status === 'duplicate') {
    return { status: 'duplicate', file: created.file };
  }
  if (created.status === 'invalid') {
    return { status: 'invalid', reason: created.reason };
  }
  if (created.status === 'noSnlDoc') {
    return { status: 'error', message: '.SNL_Doc/ not found' };
  }
  if (created.status === 'error') {
    return { status: 'error', message: created.message };
  }

  let copiedCount = 0;
  for (const macro of selected) {
    const added = await addMacro(workspaceRoot, bare, macro);
    if (added.status === 'ok') {
      copiedCount += 1;
    } else if (added.status !== 'duplicate') {
      // A duplicate inside a freshly-created package is impossible, but be
      // defensive: any other failure aborts and surfaces the reason.
      return {
        status: 'error',
        message:
          added.status === 'invalid'
            ? added.reason
            : added.status === 'error'
              ? added.message
              : `failed to copy macro "${macro.name}" (${added.status})`
      };
    }
  }
  return { status: 'ok', file: created.file, copiedCount };
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
  const fsApi = vscode.workspace.fs;
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
    nextDestMacros[n] = srcRead.pkg.macros[n];
  }

  const nextDest: MacroPackageFile = {
    ...destRead.pkg,
    macros: nextDestMacros
  };
  try {
    await writeWorkspaceFile(workspaceRoot,
      macroPackageUri(workspaceRoot, destBare),
      jsonBytes(nextDest),
      destRead.raw
    );
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
    newDescription
  );
  if (created.status !== 'ok') {
    return created;
  }
  // Now remove the successfully-copied macros from the source. We use the
  // ORIGINAL names[] input rather than derived counts so partial success on
  // the copy side (a name absent from source silently skipped) does not turn
  // into a source-side error.
  const deleted = await batchDeleteMacros(workspaceRoot, sourceFile, names);
  if (deleted.status !== 'ok') {
    return {
      status: 'error',
      message:
        deleted.status === 'noFile'
          ? `Copied ${created.copiedCount} macro(s) into "${created.file}", but the source package vanished before removal.`
          : `Copied ${created.copiedCount} macro(s) into "${created.file}", but source-side removal failed: ${deleted.message}`
    };
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
    if (!raw || typeof raw !== 'object') {
      return { status: 'ok', meta: {} };
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
  const fsApi = vscode.workspace.fs;
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
  const fsApi = vscode.workspace.fs;
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
  id: string
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
  const fsApi = vscode.workspace.fs;
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  const targetId = (id ?? '').trim();
  if (!targetId) {
    return { status: 'invalid', message: 'id is required' };
  }
  let pool: EntryData[] = [];
  try {
    const raw = await readJson<unknown>(entriesUri(workspaceRoot));
    if (Array.isArray(raw)) {
      pool = raw as EntryData[];
    }
  } catch {
    pool = [];
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
    await writeWorkspaceFile(workspaceRoot, entriesUri(workspaceRoot), jsonBytes(pool), original);
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'ok', id: targetId, references };
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
  const fsApi = vscode.workspace.fs;
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
  const fsApi = vscode.workspace.fs;
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
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
  const targetSlug = (slug ?? '').trim();
  if (!targetSlug) {
    return { status: 'invalid', message: 'slug is required' };
  }
  const dir = libraryDirUri(workspaceRoot, targetSlug);
  if (!(await exists(dir))) {
    return { status: 'notFound', slug: targetSlug };
  }
  try {
    // recursive=true so meta.json + graph.json + anything else the user has
    // dropped in there goes with the directory. useTrash=true so the user
    // can recover from the OS trash if they change their mind — a library
    // is a lot of typed content, worth being kinder than we are with a
    // single macro-package file.
    await withExtensionWriterLock(workspaceRoot, `delete ${dir.fsPath}`, async () => {
      await assertWorkspaceWritableOnDisk(workspaceRoot);
      await fsApi.delete(dir, { recursive: true, useTrash: true });
    });
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'ok', slug: targetSlug };
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
 * Missing / corrupt / wrong-shape → `[]` (defensive, matches readEntries).
 */
export async function readRelationships(
  workspaceRoot: vscode.Uri
): Promise<RelationshipData[]> {
  try {
    const raw = await readJson<unknown>(relationshipsUri(workspaceRoot));
    // Accept both `{ relationships: [...] }` (canonical) and a bare array
    // (defensive — a hand-edited file might drop the wrapper).
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as RelationshipsFile | null)?.relationships)
        ? (raw as RelationshipsFile).relationships!
        : [];
    return list.filter(
      (r): r is RelationshipData =>
        r !== null &&
        typeof r === 'object' &&
        typeof (r as RelationshipData).id === 'string' &&
        typeof (r as RelationshipData).from === 'string' &&
        typeof (r as RelationshipData).to === 'string' &&
        typeof (r as RelationshipData).label === 'string'
    );
  } catch {
    return [];
  }
}

/** Write the canonical `{ version, relationships }` shape to disk. */
async function writeRelationships(
  workspaceRoot: vscode.Uri,
  list: RelationshipData[],
  expectedOriginal: RelationshipData[]
): Promise<void> {
  const fsApi = vscode.workspace.fs;
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
  input: Omit<RelationshipData, 'id'>
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

  const next = list.slice();
  next[idx] = { id: targetId, from, to, label, metadata: input.metadata ?? null };
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

/**
 * @deprecated Prefer {@link extractSnlReferences} which also returns the
 * `x@foo` context-src target set. Retained for callers only interested
 * in macro names.
 */
export function extractMacroNamesFromSnl(snl: string): string[] {
  return extractSnlReferences(snl).macros;
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

/**
 * Regenerate the auto-managed subset of `relationships.json` for a scope.
 * Auto rows are identified by (label ∈ AUTO_LABELS) AND
 * (metadata.generator === "macro-source-scan"). User-authored rows and
 * out-of-scope auto rows are preserved verbatim.
 *
 * Two auto label kinds (cat 2026-07-10):
 *   - "depends"      — source: `macros[name].source.entries` for each
 *                      macro name used in the entry's SNL.
 *   - "uses_context" — source: the `<foo>` target of every `x@<foo>`
 *                      postfix in the entry's SNL (cross-entry context
 *                      binding, Stage 1 §src-postfix).
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
    const poolIds = new Set(entries.map((e) => e.id));
    const macros = await readAllMacros(workspaceRoot);
    const existing = await readRelationships(workspaceRoot);

    const isAutoRow = (r: RelationshipData): boolean =>
      AUTO_LABELS.includes(r.label) &&
      r.metadata !== null &&
      typeof r.metadata === 'object' &&
      (r.metadata as { generator?: unknown }).generator ===
        AUTO_GENERATOR_TAG;

    // Preserve: user-authored rows AND out-of-scope auto rows.
    // In-scope auto rows are indexed for id-stable regen.
    const preservedRows: RelationshipData[] = [];
    // key = "<label>|<from>|<to>"
    const inScopeAuto = new Map<string, RelationshipData>();
    for (const r of existing) {
      const inScope = scope.entryIds === null || scope.entryIds.has(r.from);
      if (isAutoRow(r) && inScope) {
        inScopeAuto.set(`${r.label}|${r.from}|${r.to}`, r);
      } else {
        preservedRows.push(r);
      }
    }
    const preservedUserOnly = preservedRows.filter((r) => !isAutoRow(r)).length;

    // Compute new in-scope auto rows for BOTH labels.
    const newAuto = new Map<
      string,
      { rel: RelationshipData; witnessSet: Set<string> }
    >();

    const idPrefix: Record<string, string> = {
      [AUTO_LABEL]: 'dep',
      [AUTO_LABEL_USES_CONTEXT]: 'ctx'
    };
    const witnessField: Record<string, string> = {
      [AUTO_LABEL]: 'macros',       // depends: which macros triggered
      [AUTO_LABEL_USES_CONTEXT]: 'postfixes' // uses_context: which local var names
    };
    const upsert = (
      label: string,
      from: string,
      to: string,
      witness: string
    ): void => {
      if (!to || from === to) return;
      if (!poolIds.has(to)) return;
      const key = `${label}|${from}|${to}`;
      let bucket = newAuto.get(key);
      if (!bucket) {
        const prev = inScopeAuto.get(key);
        bucket = {
          rel: {
            id: prev?.id ?? `${idPrefix[label]}.${from}.${to}`,
            from,
            to,
            label,
            metadata: {
              generator: AUTO_GENERATOR_TAG,
              [witnessField[label]]: [] as string[],
              isAtomic: true
            }
          },
          witnessSet: new Set<string>()
        };
        newAuto.set(key, bucket);
      }
      bucket.witnessSet.add(witness);
    };

    for (const e of entries) {
      if (scope.entryIds !== null && !scope.entryIds.has(e.id)) continue;
      const snl = e.content?.snl ?? '';
      if (!snl.trim()) continue;
      const refs = extractSnlReferences(snl);
      // "depends" via macro source resolution.
      for (const name of refs.macros) {
        const m = macros[name];
        if (!m || !Array.isArray(m.source?.entries)) continue;
        for (const src of m.source.entries) {
          upsert(AUTO_LABEL, e.id, src, name);
        }
      }
      // "uses_context" via x@foo direct-target references.
      for (const src of refs.contextSrcs) {
        // Use the entry's SNL scanner already collected the local-var
        // name via the `x` prefix; but we didn't return it, so witness
        // is the src itself. Good enough — the target IS the interesting
        // datum, and duplicates collapse naturally into one edge.
        upsert(AUTO_LABEL_USES_CONTEXT, e.id, src, src);
      }
    }

    // Freeze witness arrays into stable-sorted lists on metadata.
    for (const b of newAuto.values()) {
      const md = b.rel.metadata as Record<string, unknown>;
      md[witnessField[b.rel.label]] = Array.from(b.witnessSet).sort();
    }

    const merged: RelationshipData[] = [...preservedRows];
    for (const b of newAuto.values()) merged.push(b.rel);

    computeAtomicityInPlace(merged);

    merged.sort((a, b) => a.id.localeCompare(b.id));

    let added = 0;
    let updated = 0;
    for (const k of newAuto.keys()) {
      if (inScopeAuto.has(k)) updated += 1;
      else added += 1;
    }
    let removed = 0;
    for (const k of inScopeAuto.keys()) {
      if (!newAuto.has(k)) removed += 1;
    }
    const totalDepends = merged.filter(
      (r) => r.label === AUTO_LABEL
    ).length;
    const totalUsesContext = merged.filter(
      (r) => r.label === AUTO_LABEL_USES_CONTEXT
    ).length;
    const atomicCount = merged.filter(
      (r) =>
        AUTO_LABELS.includes(r.label) &&
        r.metadata !== null &&
        typeof r.metadata === 'object' &&
        (r.metadata as { isAtomic?: unknown }).isAtomic === true
    ).length;

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

    return {
      status: 'ok',
      report: {
        added,
        removed,
        updated,
        preservedUser: preservedUserOnly,
        totalDepends,
        totalUsesContext,
        atomicCount
      }
    };
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
export function computeAtomicityInPlace(rels: RelationshipData[]): void {
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
