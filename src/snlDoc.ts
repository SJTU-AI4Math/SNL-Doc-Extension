import * as vscode from 'vscode';
import { slugify } from './slug';

/**
 * Filesystem helpers for the `.SNL_Doc/` tree.
 *
 * All operations go through `vscode.workspace.fs` so they keep working in
 * remote / virtual filesystems. The module is intentionally panel-free so
 * panels (`initPanel`, `createLibraryPanel`, `dashboardPanel`) and any
 * future MCP / CLI surface can reuse the same primitives.
 *
 * Layout produced (see Plan.md §"实装项目时的文件结构"):
 *
 *   .SNL_Doc/
 *   ├── config.json            { version, libraries: [{slug, title}] }
 *   ├── entries.json           shared entry pool (top-level, sibling of libraries/)
 *   ├── term_macros/
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

/** Persisted shapes. Kept minimal and forward-compatible. */
export interface SnlConfig {
  version: string;
  libraries: Array<{ slug: string; title: string }>;
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

  const termMacrosDir = vscode.Uri.joinPath(root, 'term_macros');
  const librariesDir = librariesDirUri(workspaceRoot);

  await fsApi.createDirectory(root);
  await fsApi.createDirectory(termMacrosDir);
  await fsApi.createDirectory(librariesDir);

  const config: SnlConfig = { version: '0.0.1', libraries: [] };
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
    config = await readJson<SnlConfig>(configUri(workspaceRoot));
  } catch (err) {
    throw new Error(
      `Failed to read .SNL_Doc/config.json: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!Array.isArray(config.libraries)) {
    config.libraries = [];
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
    return { hasSnlDoc: false, totalEntryCount: null, libraries: [] };
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
    config = await readJson<SnlConfig>(configUri(workspaceRoot));
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

  return { hasSnlDoc: true, totalEntryCount, libraries };
}
