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

/** Persisted shapes. Kept minimal and forward-compatible. */
export interface SnlConfig {
  version: string;
  libraries: Array<{ slug: string; title: string }>;
  /** Entry-kind catalog. May be missing in pre-v0.0.2 configs (see
   *  `normalizeConfig`). */
  entry_kinds?: EntryKind[];
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
  };
  const rawKinds = Array.isArray(cfg.entry_kinds) ? cfg.entry_kinds : [];
  return {
    version: typeof cfg.version === 'string' ? cfg.version : '0.0.1',
    libraries: Array.isArray(cfg.libraries) ? cfg.libraries : [],
    entry_kinds: rawKinds.map(normalizeEntryKind)
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
    entry_kinds: []
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
  libraries: LibrarySummary[];
  /** Term macro packages enumerated under `term_macros/`. */
  macroPackages: MacroPackageSummary[];
  /** Entry-kind catalog from `config.json#entry_kinds`. */
  entryKinds: EntryKind[];
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
      libraries: [],
      macroPackages: [],
      entryKinds: []
    };
  }

  let totalEntryCount: number | null = null;
  try {
    const entries = await readJson<unknown[]>(entriesUri(workspaceRoot));
    totalEntryCount = Array.isArray(entries) ? entries.length : null;
  } catch {
    totalEntryCount = null;
  }

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

  return {
    hasSnlDoc: true,
    totalEntryCount,
    libraries,
    macroPackages,
    entryKinds
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
// Entries write ops
// ---------------------------------------------------------------------------

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
