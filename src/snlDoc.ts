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
 * (e.g. "Definition", "Theorem", "Example"). The current `name` / `color` /
 * `numbering` fields are the minimum the Dashboard needs to render the
 * Kinds table; the type is intentionally open ({ [k]: unknown } not enforced
 * but tolerated) so future fields (icon, prefix, parent kind, scope) can be
 * added without breaking older configs. Unknown fields are preserved
 * verbatim by `JSON.stringify` round-trips and ignored by the current UI.
 */
export interface EntryKind {
  id: string;
  name: string;
  color: string;
  numbering: { pattern: string; start?: number };
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
 * `entry_kinds` existed should still load cleanly.
 */
function normalizeConfig(raw: unknown): SnlConfig {
  const cfg = (raw ?? {}) as Partial<SnlConfig>;
  return {
    version: typeof cfg.version === 'string' ? cfg.version : '0.0.1',
    libraries: Array.isArray(cfg.libraries) ? cfg.libraries : [],
    entry_kinds: Array.isArray(cfg.entry_kinds) ? cfg.entry_kinds : []
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
    version: '0.0.2',
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
