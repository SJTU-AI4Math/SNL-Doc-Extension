import * as vscode from 'vscode';
import { slugify } from './slug';

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
 *   ├── config.json            { version, libraries: [], entry_kinds: [] }
 *   ├── entries.json           shared entry pool (top-level, sibling of libraries/)
 *   ├── term_macros/<pkg>.json macro packages (one file = one package)
 *   └── libraries/<slug>/
 *       ├── relationships.json { nodes: [], edges: [] }
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

export function relationshipsUri(
  workspaceRoot: vscode.Uri,
  slug: string
): vscode.Uri {
  return vscode.Uri.joinPath(
    libraryDirUri(workspaceRoot, slug),
    'relationships.json'
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
 *  - `numbering`: a small Typst-inspired DSL string. Dots in the pattern
 *    denote hierarchical levels (e.g. `"1.1"` = two-level counter starting
 *    at 1.1). The Dashboard currently just displays the pattern verbatim;
 *    the actual counter engine will land with the Entry editor.
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
  numbering: string;
  style: string;
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
  libraries: Array<{ slug: string; title: string }>;
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

export interface RelationshipsFile {
  nodes: unknown[];
  edges: unknown[];
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
  const rawActive = cfg.active_macro_packages;
  const activeMacroPackages =
    Array.isArray(rawActive) && rawActive.every((v) => typeof v === 'string')
      ? (rawActive as string[])
      : undefined;
  const out: SnlConfig = {
    version: typeof cfg.version === 'string' ? cfg.version : '0.0.1',
    libraries: Array.isArray(cfg.libraries) ? cfg.libraries : [],
    entry_kinds: rawKinds.map(normalizeEntryKind),
    macro_kinds: rawMacroKinds.map(normalizeMacroKind)
  };
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
 *  - v0.0.2 `numbering: { pattern, start? }` → `numbering: pattern`
 *    (start is dropped; the Typst-DSL pattern already carries the initial
 *    counter value).
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

  // numbering: prefer the new plain-string DSL, fall back to the v0.0.2
  // `{ pattern, start? }` object (drop `start`, it's now encoded in the
  // DSL itself).
  let numbering = '';
  if (typeof obj.numbering === 'string') {
    numbering = obj.numbering;
  } else if (obj.numbering && typeof obj.numbering === 'object') {
    const n = obj.numbering as Record<string, unknown>;
    if (typeof n.pattern === 'string') numbering = n.pattern;
  }

  const style = typeof obj.style === 'string' ? obj.style : '';

  return {
    id,
    name,
    coloring: { stroke, background },
    numbering,
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
    version: '0.0.3',
    libraries: [],
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
 *  - a library with the same slug already exists (`duplicate`).
 *
 * On success creates `libraries/<slug>/{relationships.json,documents/...}`
 * and appends `{slug, title}` to `config.json#libraries`.
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

  // Read config first so we fail fast if it's missing/corrupt before any write.
  let config: SnlConfig;
  try {
    config = normalizeConfig(await readJson<unknown>(configUri(workspaceRoot)));
  } catch (err) {
    throw new Error(
      `Failed to read .SNL_Doc/config.json: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  // Also reject duplicates that exist in config even if the dir was deleted —
  // keeps the on-disk state consistent.
  if (config.libraries.some((l) => l.slug === slug)) {
    return { status: 'duplicate', slug };
  }

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

  await fsApi.writeFile(
    relationshipsUri(workspaceRoot, slug),
    jsonBytes({ nodes: [], edges: [] } satisfies RelationshipsFile)
  );

  const gitkeep = ENCODER.encode('');
  await fsApi.writeFile(vscode.Uri.joinPath(typstDir, '.gitkeep'), gitkeep);
  await fsApi.writeFile(vscode.Uri.joinPath(latexDir, '.gitkeep'), gitkeep);
  await fsApi.writeFile(
    vscode.Uri.joinPath(markdownDir, '.gitkeep'),
    gitkeep
  );

  // Append to config last so a partial failure above doesn't leave config
  // claiming a library that's missing files.
  config.libraries.push({ slug, title: trimmedTitle });
  await fsApi.writeFile(configUri(workspaceRoot), jsonBytes(config));

  return { status: 'created', slug, title: trimmedTitle };
}

/**
 * Best-effort macro count inside a single term-macro package file.
 *
 * The macro file schema isn't finalized yet (see Plan §"待定 / 待补充"). To
 * stay useful before then we sniff three common shapes:
 *  - bare array of macros            → length
 *  - `{ macros: [ ... ] }`           → length of macros array
 *  - top-level object of `{ uuid: macroDef }` → number of own keys
 * Anything else → `null` (Dashboard renders "—").
 */
function inferMacroCount(raw: unknown): number | null {
  if (Array.isArray(raw)) {
    return raw.length;
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.macros)) {
      return (obj.macros as unknown[]).length;
    }
    // Reserved metadata keys we don't want to count as macros.
    const reservedKeys = new Set(['version', 'name', 'description']);
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

  const out: MacroPackageSummary[] = [];
  for (const [name, type] of entries) {
    // Files only, json only, no dotfiles.
    if (type !== vscode.FileType.File) continue;
    if (!name.toLowerCase().endsWith('.json')) continue;
    if (name.startsWith('.')) continue;

    const summary: MacroPackageSummary = { file: name, macroCount: null };
    try {
      summary.macroCount = inferMacroCount(
        await readJson<unknown>(vscode.Uri.joinPath(dir, name))
      );
    } catch {
      // Leave macroCount null.
    }
    out.push(summary);
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

// ---------------------------------------------------------------------------
// Macro packages: canonical read/write ops
// ---------------------------------------------------------------------------

/**
 * Extended, on-disk macro shape — a superset of `@snl-basics/react`'s
 * render-only `SnlMacro` (0.4.0). It additionally carries the consumer-owned
 * output backends (typst / latex / markdown / text) that this extension writes
 * to disk. Renamed from `SnlMacro` to signal it is NOT the library type.
 *
 * We keep a local copy so the extension host (which cannot import the React/ESM
 * package cleanly in a CommonJS `out/` build) and the smoke test share one
 * canonical shape. The webviews import the real render type from
 * `@snl-basics/react` for previews and keep their own extended copy for saves.
 */
/**
 * One render style of a macro (v3, v6 on-disk) — mirrors
 * `@snl-basics/react`'s `SnlMacroStyle`, extended with the consumer-owned
 * output backends (typst / latex / markdown / text) which live *per style*.
 *
 * v3: `mode` is now 4 flat values (formula_inline / formula_display / text /
 * block); the `display?: inline|block` axis is folded in. `variadic_join`
 * is split into three optional delimiter/separator strings. Free-text
 * `tags` may be attached per style.
 */
export interface MacroPackageStyle {
  /** Style tag — the token used in `foo[tag](…)`. Must be unique per macro. */
  tag: string;
  /** Semantic render mode — 4 flat values (v3). */
  mode: 'formula_inline' | 'formula_display' | 'text' | 'block';
  template: string;
  /** Left delimiter for `#*` — ignored when the macro isn't dynamic_arity. */
  variadic_left?: string;
  /** Separator between `#*` children. Default: ', ' (formula), '' (text). */
  variadic_join?: string;
  /** Right delimiter for `#*` — ignored when the macro isn't dynamic_arity. */
  variadic_right?: string;
  react_renderer_key?: string;
  /** Free-text labels attached to this style (backslash forbidden). */
  tags?: string[];
  // Extended (consumer-owned) output backends per style:
  typst?: { built_in: string; synthesis: { mode: 'formula' | 'text'; macro: string } };
  latex?: { built_in: string; synthesis: { mode: 'formula' | 'text'; macro: string } };
  markdown?: string;
  text?: string;
}

export interface MacroPackageEntry {
  name: string;
  description: string;
  source: { entries: string[]; urls: string[] };
  /** Semantic kind (optional). Unset → rendered nodes default to `fvar`. */
  kind?: string;
  /**
   * True when the macro's child count is not fixed by its template (default
   * template must contain `#*`). Replaces the v2 `arity: 'fixed'|'variadic'`.
   */
  dynamic_arity: boolean;
  /**
   * Ordered list of render styles. `styles[0]` is the implicit default used
   * when the SNL source omits `[style]`. Every macro has at least one style
   * and tags must be unique.
   */
  styles: MacroPackageStyle[];
  /** Free-text labels attached to the macro itself (backslash forbidden). */
  tags?: string[];
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

/**
 * v5 → v6 (this-version) migration for a single macro. Called AFTER
 * {@link groupMacrosToStyles} has produced a v5-shape entry, so we know the
 * `styles` array exists and each style has `mode` / (optionally) `display`.
 *
 * Two orthogonal changes:
 *   1. `arity: 'fixed'|'variadic'` → `dynamic_arity: boolean`
 *   2. Each style's `mode: 'formula' | 'text' | 'block'` + optional
 *      `display: 'inline' | 'block'` → new flat `mode` in
 *      `'formula_inline' | 'formula_display' | 'text' | 'block'`.
 *
 * Idempotent: an already-v6 macro (has `dynamic_arity` and flat mode) passes
 * through untouched.
 */
function v5MacroToV6(entry: MacroPackageEntry): MacroPackageEntry {
  const raw = entry as unknown as Record<string, unknown>;
  const out: MacroPackageEntry = { ...entry };

  // Field 1: arity → dynamic_arity (idempotent).
  if (typeof out.dynamic_arity !== 'boolean') {
    const legacyArity = (raw.arity as string | undefined) ?? 'fixed';
    out.dynamic_arity = legacyArity === 'variadic';
    delete (out as unknown as Record<string, unknown>).arity;
  }

  // Field 2: each style's mode + display → flat mode.
  if (Array.isArray(out.styles)) {
    out.styles = out.styles.map((s) => {
      const rawS = s as unknown as Record<string, unknown>;
      const legacyMode = rawS.mode as string | undefined;
      const legacyDisplay = rawS.display as string | undefined;
      // Already-v6 modes pass through untouched.
      if (
        legacyMode === 'formula_inline' ||
        legacyMode === 'formula_display' ||
        legacyMode === 'text' ||
        legacyMode === 'block'
      ) {
        const next = { ...s };
        delete (next as unknown as Record<string, unknown>).display;
        return next;
      }
      let newMode: MacroPackageStyle['mode'];
      if (legacyMode === 'formula' || legacyMode === undefined) {
        newMode = legacyDisplay === 'block' ? 'formula_display' : 'formula_inline';
      } else if (legacyMode === 'text' || legacyMode === 'block') {
        newMode = legacyMode as MacroPackageStyle['mode'];
      } else {
        // Unknown mode string — default to formula_inline (best-effort).
        newMode = 'formula_inline';
      }
      const next: MacroPackageStyle = { ...s, mode: newMode };
      delete (next as unknown as Record<string, unknown>).display;
      return next;
    });
  }

  return out;
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
): MacroPackageEntry[] {
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
    // Final v5→v6 collapse for every group. Cast to MacroPackageEntry at
    // this boundary is safe because v5MacroToV6 guarantees v6 shape.
    return order.map((n) => {
      const g = groups.get(n) as Record<string, unknown>;
      return v5MacroToV6(g as unknown as MacroPackageEntry);
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[snlDoc] normalizeMacros: could not migrate legacy macros to the ` +
        `v6 styles array (${reason}); returning original entries`
    );
    return collected as unknown as MacroPackageEntry[];
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
function normalizeMacros(raw: unknown): MacroPackageEntry[] {
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
    version: '1',
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
    await fsApi.writeFile(target, jsonBytes(pkg));
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
    const active = await resolveActiveMacroPackages(workspaceRoot);
    await setActiveMacroPackages(workspaceRoot, [...active, bare]);
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
  | { status: 'ok'; pkg: MacroPackageFile; macros: MacroPackageEntry[] }
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

  const macros = normalizeMacros(raw);

  // Recover the package metadata (name/description/version) best-effort.
  let pkgName = bare;
  let pkgVersion = '1';
  let pkgDescription: string | undefined;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.name === 'string' && obj.name.trim()) {
      pkgName = obj.name;
    }
    if (typeof obj.version === 'string' && obj.version.trim()) {
      pkgVersion = obj.version;
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
    version: pkgVersion,
    name: pkgName,
    macros: macrosMap
  };
  if (pkgDescription) {
    pkg.description = pkgDescription;
  }

  return { status: 'ok', pkg, macros };
}

/**
 * Read every macro from every package under the workspace and return them
 * as a flat map keyed by macro name (last-writer-wins on collisions —
 * matches how consumers merge multiple package files into a single lookup
 * for parsing / rendering).
 *
 * Result rows use the extended v6 on-disk shape (typst / latex / markdown /
 * text backends included). Callers that need the lib-shape `SnlMacroDb`
 * should map via `extendedToLibShape` on the receiver side.
 *
 * Best-effort: individual packages that fail to load (missing file, JSON
 * parse error) are silently skipped so a single broken package can't
 * take out the whole editor.
 */
export async function readAllMacros(
  workspaceRoot: vscode.Uri
): Promise<Record<string, MacroPackageEntry>> {
  const packages = await readMacroPackages(workspaceRoot);
  const active = await resolveActiveMacroPackages(workspaceRoot);
  const activeSet = new Set(active);
  const out: Record<string, MacroPackageEntry> = {};
  // Track which active package first defined each name so we can report the
  // two colliding packages (Feature 3 will make this actionable).
  const origin: Record<string, string> = {};
  for (const summary of packages) {
    const bare = stripJsonExt(summary.file);
    if (!activeSet.has(bare)) continue;
    const read = await readMacroPackage(workspaceRoot, summary.file);
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
  return out;
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
  const packages = await readMacroPackages(workspaceRoot);
  const onDisk = packages.map((p) => stripJsonExt(p.file));
  let cfg: SnlConfig | null = null;
  try {
    cfg = normalizeConfig(await readJson<unknown>(configUri(workspaceRoot)));
  } catch {
    cfg = null;
  }
  if (!cfg || cfg.active_macro_packages === undefined) {
    // Missing field: all packages on disk are active.
    return Array.from(new Set(onDisk)).sort((a, b) => a.localeCompare(b));
  }
  const declared = new Set(cfg.active_macro_packages.map(stripJsonExt));
  // Garbage-collect on read: only surface packages still present on disk.
  const resolved = onDisk.filter((bare) => declared.has(bare));
  return Array.from(new Set(resolved)).sort((a, b) => a.localeCompare(b));
}

/**
 * Persist the active macro-package list to `config.json`, deduping and
 * sorting for stability. Preserves every unrelated config field by
 * round-tripping the raw JSON. Bare names (any `.json` suffix is stripped).
 */
export async function setActiveMacroPackages(
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
  const normalized = Array.from(
    new Set((Array.isArray(activeList) ? activeList : []).map(stripJsonExt))
  ).sort((a, b) => a.localeCompare(b));
  raw.active_macro_packages = normalized;
  await fsApi.writeFile(uri, jsonBytes(raw));
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
    await fsApi.delete(target, { useTrash: false });
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  try {
    const active = await resolveActiveMacroPackages(workspaceRoot);
    if (active.includes(bare)) {
      await setActiveMacroPackages(
        workspaceRoot,
        active.filter((b) => b !== bare)
      );
    }
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
    const tag = typeof style.tag === 'string' ? style.tag.trim() : '';
    if (!tag) {
      return `styles[${i}].tag is required`;
    }
    if (seen.has(tag)) {
      return `styles[${i}].tag "${tag}" is duplicated`;
    }
    seen.add(tag);
    if (
      style.mode !== 'formula_inline' &&
      style.mode !== 'formula_display' &&
      style.mode !== 'text' &&
      style.mode !== 'block'
    ) {
      return `styles[${i}].mode must be one of 'formula_inline', 'formula_display', 'text', 'block'`;
    }
    if (typeof style.template !== 'string' || style.template.trim().length === 0) {
      return `styles[${i}].template is required`;
    }
    // v6: no `display` field on a style. Reject if lingering (should have
    // been stripped by v5MacroToV6 during read).
    const raw = style as unknown as Record<string, unknown>;
    if (raw.display !== undefined) {
      return `styles[${i}].display is a v5 field — should have been folded into mode`;
    }
  }
  // Tags: strings, no backslashes.
  const macroTags = (macro as MacroPackageEntry).tags;
  if (macroTags !== undefined) {
    if (!Array.isArray(macroTags)) {
      return 'tags must be an array of strings';
    }
    for (const t of macroTags) {
      if (typeof t !== 'string') return 'tags entries must be strings';
      if (t.includes('\\')) return 'tags may not contain backslashes';
    }
  }
  for (let i = 0; i < styles.length; i++) {
    const styleTags = (styles[i] as MacroPackageStyle).tags;
    if (styleTags !== undefined) {
      if (!Array.isArray(styleTags)) {
        return `styles[${i}].tags must be an array of strings`;
      }
      for (const t of styleTags) {
        if (typeof t !== 'string') return `styles[${i}].tags entries must be strings`;
        if (t.includes('\\')) return `styles[${i}].tags may not contain backslashes`;
      }
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
    await fsApi.writeFile(
      macroPackageUri(workspaceRoot, file),
      jsonBytes(next)
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
  /** Entry-kind catalog from `config.json#entry_kinds`. */
  entryKinds: EntryKind[];
  /** Macro-kind catalog from `config.json#macro_kinds`. */
  macroKinds: MacroKind[];
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
 * each `relationships.json`.
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
      entryKinds: [],
      macroKinds: []
    };
  }

  const entries = await readEntries(workspaceRoot);
  const totalEntryCount: number | null = entries.length;

  let config: SnlConfig | null = null;
  try {
    config = normalizeConfig(await readJson<unknown>(configUri(workspaceRoot)));
  } catch {
    config = null;
  }

  const libraries: LibrarySummary[] = [];
  if (config?.libraries) {
    for (const entry of config.libraries) {
      const summary: LibrarySummary = {
        slug: entry.slug,
        title: entry.title,
        entryCount: null,
        relationshipCount: null
      };
      try {
        const rel = await readJson<RelationshipsFile>(
          relationshipsUri(workspaceRoot, entry.slug)
        );
        const nodes = Array.isArray(rel.nodes) ? rel.nodes : [];
        const edges = Array.isArray(rel.edges) ? rel.edges : [];
        summary.relationshipCount = edges.length;
        // Count distinct node ids that look like UUID references.
        const ids = new Set<string>();
        for (const n of nodes) {
          if (n && typeof n === 'object' && 'id' in n) {
            const id = (n as { id: unknown }).id;
            if (typeof id === 'string') {
              ids.add(id);
            }
          }
        }
        summary.entryCount = ids.size;
      } catch {
        // Leave both null — the dashboard renders "—" for unknown.
      }
      libraries.push(summary);
    }
  }

  const macroPackages = await readMacroPackages(workspaceRoot);
  const entryKinds: EntryKind[] = config?.entry_kinds ?? [];
  const macroKinds: MacroKind[] = config?.macro_kinds ?? [];

  // SNoogL search index: one entry per macro across every package.
  // Second per-package read is intentional — readMacroPackages only did
  // structure-detection and count-inference, we now need actual macro
  // rows. Cheap for our expected package counts.
  const allMacros: AllMacroIndexEntry[] = [];
  for (const summary of macroPackages) {
    const read = await readMacroPackage(workspaceRoot, summary.file);
    if (read.status !== 'ok') continue;
    for (const macro of read.macros) {
      if (typeof macro.name !== 'string' || macro.name.length === 0) continue;
      allMacros.push({
        id: macro.name,
        packageFile: summary.file,
        packageName: read.pkg?.name ?? summary.file.replace(/\.json$/i, ''),
        ...(typeof macro.kind === 'string' && macro.kind ? { kind: macro.kind } : {})
      });
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
    entryKinds,
    macroKinds
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
  raw.entry_kinds = kinds;
  await fsApi.writeFile(uri, jsonBytes(raw));
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
    numbering: k.numbering,
    style: k.style
  }));
  await writeEntryKinds(workspaceRoot, kinds);
  return { status: 'applied', count: kinds.length };
}

export type CreateEntryKindResult =
  | { status: 'created'; kind: EntryKind }
  | { status: 'noSnlDoc' }
  | { status: 'duplicate'; id: string }
  | { status: 'invalid'; message: string };

/**
 * Append a single new entry kind. Rejects duplicates by id and empty ids.
 * All other fields (colours, numbering DSL, style) are stored verbatim —
 * validation of the numbering DSL will land with the Entry editor.
 */
export async function createEntryKind(
  workspaceRoot: vscode.Uri,
  input: {
    id: string;
    name: string;
    stroke: string;
    background: string;
    numbering: string;
    style: string;
  }
): Promise<CreateEntryKindResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
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
    numbering: (input.numbering ?? '').trim(),
    style: (input.style ?? '').trim()
  };
  await writeEntryKinds(workspaceRoot, [...existing, kind]);
  return { status: 'created', kind };
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
  raw.macro_kinds = kinds;
  await fsApi.writeFile(uri, jsonBytes(raw));
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
    typst?: string;
    latex?: string;
    markdown?: string;
    text?: string;
  };
  contribution_info: unknown;
  pointer: unknown;
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
  const title = typeof entry?.title === 'string' ? entry.title.trim() : '';

  if (!id) {
    return { status: 'invalid', reason: 'id is required' };
  }
  if (!title) {
    return { status: 'invalid', reason: 'title is required' };
  }
  if (!kind) {
    return { status: 'invalid', reason: 'kind is required' };
  }
  if (entry.content === null || typeof entry.content !== 'object') {
    return { status: 'invalid', reason: 'content must be an object' };
  }

  // kind must reference an existing entry kind.
  const kinds = await readEntryKinds(workspaceRoot);
  if (!kinds.some((k) => k.id === kind)) {
    return { status: 'unknownKind', kind };
  }

  // Read the existing pool (tolerate missing/corrupt → empty).
  let pool: EntryData[] = [];
  try {
    const raw = await readJson<unknown>(entriesUri(workspaceRoot));
    if (Array.isArray(raw)) {
      pool = raw as EntryData[];
    }
  } catch {
    pool = [];
  }

  if (pool.some((e) => e && typeof e === 'object' && e.id === id)) {
    return { status: 'duplicate', id };
  }

  const record: EntryData = {
    id,
    kind,
    title,
    content: {
      snl: strOrUndef(entry.content.snl),
      typst: strOrUndef(entry.content.typst),
      latex: strOrUndef(entry.content.latex),
      markdown: strOrUndef(entry.content.markdown),
      text: strOrUndef(entry.content.text)
    },
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
    await fsApi.writeFile(entriesUri(workspaceRoot), jsonBytes([...pool, record]));
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'ok', id };
}

/** Coerce a value to a trimmed non-empty string, or `undefined`. */
function strOrUndef(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.length > 0 ? value : undefined;
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
 * Numbering DSL — Typst-inspired, dot-separated hierarchy:
 *  - `"1"`       → single flat counter starting at 1.
 *  - `"1.1"`     → two-level counter (parent.local), each part starts at 1.
 *  - `"1.1.1"`   → three-level counter.
 *  - `""` (empty)→ unnumbered entry.
 *
 * The FulcrumCN mapping used here:
 *  - `main` counter (定义/引理/定理/例/反例) → `"1.1.1"` (章.节.K)
 *  - `sub`  counter (推论/性质)             → `"1.1.1.1"` (章.节.K.j)
 *  - `single` counter (公理/题目)           → `"1"` (flat)
 *  - `none` (注/构造/证明)                  → `""`
 */
export const ENTRY_KIND_PRESETS: EntryKindPreset[] = [
  {
    id: 'fulcrum-math-notes',
    label: "Fulcrum's Math Notes",
    description:
      'The 12 entry kinds used by Fulcrum-Notes-Typst (Definition/Axiom/Lemma/Theorem/Corollary/Property/Remark/Example/Counterexample/Construction/Proof/Problem).',
    kinds: [
      {
        id: 'definition',
        name: 'Definition',
        coloring: { stroke: '#009C27', background: '#D6FEE0' },
        numbering: '1.1.1',
        style: ''
      },
      {
        id: 'axiom',
        name: 'Axiom',
        coloring: { stroke: '#C1C103', background: '#FFFFAC' },
        numbering: '1',
        style: ''
      },
      {
        id: 'lemma',
        name: 'Lemma',
        coloring: { stroke: '#005B9C', background: '#DAF0FF' },
        numbering: '1.1.1',
        style: ''
      },
      {
        id: 'theorem',
        name: 'Theorem',
        coloring: { stroke: '#005B9C', background: '#DAF0FF' },
        numbering: '1.1.1',
        style: ''
      },
      {
        id: 'corollary',
        name: 'Corollary',
        coloring: { stroke: '#005B9C', background: '#DAF0FF' },
        numbering: '1.1.1.1',
        style: ''
      },
      {
        id: 'property',
        name: 'Property',
        coloring: { stroke: '#AC00AF', background: '#FFEDFF' },
        numbering: '1.1.1.1',
        style: ''
      },
      {
        id: 'remark',
        name: 'Remark',
        coloring: { stroke: '#E07B00', background: '#FFEBD2' },
        numbering: '',
        style: 'remark'
      },
      {
        id: 'example',
        name: 'Example',
        coloring: { stroke: '#7700E4', background: '#EFDFFF' },
        numbering: '1.1.1',
        style: ''
      },
      {
        id: 'counterexample',
        name: 'Counterexample',
        coloring: { stroke: '#D20022', background: '#FFD6DC' },
        numbering: '1.1.1',
        style: ''
      },
      {
        id: 'construction',
        name: 'Construction',
        coloring: { stroke: '#787878', background: '#F0F0F0' },
        numbering: '',
        style: 'proof'
      },
      {
        id: 'proof',
        name: 'Proof',
        coloring: { stroke: '#787878', background: '#F0F0F0' },
        numbering: '',
        style: 'proof'
      },
      {
        id: 'problem',
        name: 'Problem',
        coloring: { stroke: '#005B9C', background: '#DAF0FF' },
        numbering: '1',
        style: 'problem'
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
    numbering: string;
    style: string;
  }
): Promise<UpdateEntryKindResult> {
  if (!(await exists(snlRootUri(workspaceRoot)))) {
    return { status: 'noSnlDoc' };
  }
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
    numbering: (input.numbering ?? '').trim(),
    style: (input.style ?? '').trim()
  };
  const kinds = existing.slice();
  kinds[idx] = next;
  await writeEntryKinds(workspaceRoot, kinds);
  return { status: 'updated', kind: next };
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
}

export type UpdateLibraryResult = UpdateResult<
  { status: 'updated'; slug: string; title: string }
>;

/**
 * Update a library's meta IN PLACE, keyed by `slug`. Currently only `title`
 * is editable; `slug` is the identity (directory name) and never changes.
 * Missing slugs → `notFound`.
 */
export async function updateLibrary(
  workspaceRoot: vscode.Uri,
  slug: string,
  input: { title: string }
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
  const libs = Array.isArray(raw.libraries)
    ? (raw.libraries as Array<{ slug?: unknown; title?: unknown }>).slice()
    : [];
  const idx = libs.findIndex((l) => l && l.slug === targetSlug);
  if (idx < 0) {
    return { status: 'notFound', id: targetSlug };
  }
  libs[idx] = { ...libs[idx], slug: targetSlug, title };
  raw.libraries = libs;
  await fsApi.writeFile(uri, jsonBytes(raw));
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
  const title = typeof entry?.title === 'string' ? entry.title.trim() : '';
  if (!title) {
    return { status: 'invalid', message: 'title is required' };
  }
  if (!kind) {
    return { status: 'invalid', message: 'kind is required' };
  }
  if (entry.content === null || typeof entry.content !== 'object') {
    return { status: 'invalid', message: 'content must be an object' };
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

  const record: EntryData = {
    id: targetId,
    kind,
    title,
    content: {
      snl: strOrUndef(entry.content.snl),
      typst: strOrUndef(entry.content.typst),
      latex: strOrUndef(entry.content.latex),
      markdown: strOrUndef(entry.content.markdown),
      text: strOrUndef(entry.content.text)
    },
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
    await fsApi.writeFile(entriesUri(workspaceRoot), jsonBytes(next));
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
    await fsApi.writeFile(macroPackageUri(workspaceRoot, bare), jsonBytes(next));
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
    await fsApi.writeFile(
      macroPackageUri(workspaceRoot, file),
      jsonBytes(next)
    );
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  return { status: 'updated', name };
}
