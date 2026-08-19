import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseSnlSyntaxTree } from '@sjtu-ai4math/snl-basics/core';
import { CURRENT_DATA_VERSION } from './dataMigrationCore';
import {
  assertCurrentEntityStorageMetadata,
  readEntityStorageSnapshot,
  type EntityReadStorage,
} from './entityStorageIo';
import { assertThemedKindCatalogs } from './kindColoring';

export interface UiSpecVerificationReport {
  dataVersion: string;
  packages: number;
  entries: number;
  macros: number;
  usedMacros: number;
  contextEntries: number;
  libraries: number;
  graphNodes: number;
  assets: number;
}

type JsonRecord = Record<string, any>;

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value);

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return !!child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}

function createEntityStorage(root: string): EntityReadStorage {
  const entityRoot = resolve(root);
  const entityPath = (relativePath: string): string => {
    const path = resolve(entityRoot, relativePath);
    if (!inside(entityRoot, path)) throw new Error(`Entity path escapes .SNL_Doc: ${relativePath}.`);
    return path;
  };
  return {
    async listJsonFiles(directory): Promise<string[]> {
      const directoryPath = entityPath(directory);
      const directoryStat = await fs.lstat(directoryPath);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error(`${directory} must be a real directory.`);
      }
      const files: string[] = [];
      for (const item of await fs.readdir(directoryPath)) {
        if (!item.endsWith('.json')) continue;
        const stat = await fs.lstat(join(directoryPath, item));
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`${directory}/${item} must be a real JSON file.`);
        }
        files.push(item);
      }
      return files.sort((left, right) => left.localeCompare(right));
    },
    async readJson(relativePath): Promise<unknown | null> {
      try {
        return await readJson(entityPath(relativePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  };
}

export async function verifyUiSpecWorkspace(workspaceRoot = process.cwd()): Promise<UiSpecVerificationReport> {
  const root = resolve(workspaceRoot, '.SNL_Doc');
  const config = await readJson(join(root, 'config.json'));
  if (!isRecord(config) || config.version !== CURRENT_DATA_VERSION) {
    throw new Error(`Expected current data version ${CURRENT_DATA_VERSION}, found ${JSON.stringify(isRecord(config) ? config.version : null)}.`);
  }
  assertCurrentEntityStorageMetadata(config);
  assertThemedKindCatalogs(config);

  const snapshot = await readEntityStorageSnapshot(createEntityStorage(root), '11');
  const packageIds = new Set(snapshot.packages.map((record) => record.manifest.id));
  const entryKinds = new Set((config.entry_kinds as JsonRecord[]).map((kind) => kind.id));
  const macroKinds = new Set((config.macro_kinds as JsonRecord[]).map((kind) => kind.id));
  const entries = new Map(snapshot.entries.map((record) => [record.entry.id, record.entry]));
  const macros = new Map(snapshot.macros.map((record) => [record.macro.name, record.macro]));

  for (const record of snapshot.entries) {
    if (!entryKinds.has(record.entry.kind)) {
      throw new Error(`Entry ${record.entry.id} references unknown Entry Kind ${String(record.entry.kind)}.`);
    }
  }
  for (const record of snapshot.macros) {
    if (!macroKinds.has(record.macro.kind)) {
      throw new Error(`Macro ${record.macro.name} references unknown Macro Kind ${String(record.macro.kind)}.`);
    }
  }

  if (!Array.isArray(config.active_macro_packages) ||
      config.active_macro_packages.some((id) => typeof id !== 'string' || !packageIds.has(id)) ||
      new Set(config.active_macro_packages).size !== config.active_macro_packages.length) {
    throw new Error('config.json#active_macro_packages must contain unique existing Package identities.');
  }
  const activePackages = new Set(config.active_macro_packages as string[]);
  for (const record of snapshot.macros) {
    if (!activePackages.has(record.envelope.package)) {
      throw new Error(`Macro ${record.macro.name} belongs to inactive Package ${record.envelope.package}.`);
    }
    const source = record.macro.source as JsonRecord;
    for (const sourceId of source.entries as string[]) {
      if (!entries.has(sourceId)) {
        throw new Error(`Macro ${record.macro.name} has unresolved source Entry ${sourceId}.`);
      }
    }
  }

  const ownedEntries = new Map<string, string[]>([...packageIds].map((id) => [id, []]));
  for (const record of snapshot.entries) ownedEntries.get(record.envelope.package)!.push(record.entry.id);
  for (const record of snapshot.packages) {
    const actual = ownedEntries.get(record.manifest.id)!.sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(actual) !== JSON.stringify(record.manifest.entry_ids)) {
      throw new Error(`Package ${record.manifest.id} entry_ids do not exactly match owned Entry entities.`);
    }
  }

  const usedMacros = new Set<string>();
  const contextEntries = new Set<string>();
  const walk = (node: any, entryId: string): void => {
    const id = node.macro_name as string;
    if (!node.env_mode && !id.startsWith('#')) {
      if (!macros.has(id)) throw new Error(`Entry ${entryId} has unresolved Macro ${id}.`);
      usedMacros.add(id);
    }
    if (node.postfix?.name) {
      if (!entries.has(node.postfix.name)) {
        throw new Error(`Entry ${entryId} has unresolved context Entry ${node.postfix.name}.`);
      }
      contextEntries.add(node.postfix.name);
    }
    for (const child of node.children ?? []) walk(child, entryId);
  };

  const assetRefs = new Set<string>();
  const assetsRoot = resolve(root, 'assets');
  const realAssetsRoot = await fs.realpath(assetsRoot);
  for (const [entryId, entry] of entries) {
    const content = entry.content as JsonRecord;
    if (content.snl) walk(parseSnlSyntaxTree(content.snl), entryId);
    if (typeof content.markdown !== 'string') continue;
    for (const match of content.markdown.matchAll(/(?:^|[(/])assets\/([^\s)]+)/g)) {
      const authoredPath = match[1];
      const path = resolve(assetsRoot, authoredPath);
      if (!inside(assetsRoot, path)) throw new Error(`Entry ${entryId} has unsafe asset path assets/${authoredPath}.`);
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Entry ${entryId} asset ${authoredPath} must be a real file.`);
      }
      const realPath = await fs.realpath(path);
      if (!inside(realAssetsRoot, realPath)) {
        throw new Error(`Entry ${entryId} asset ${authoredPath} escapes the assets root.`);
      }
      assetRefs.add(relative(assetsRoot, path).split(sep).join('/'));
    }
  }

  let graphNodes = 0;
  let libraryCount = 0;
  const librariesRoot = join(root, 'libraries');
  for (const library of (await fs.readdir(librariesRoot)).sort((left, right) => left.localeCompare(right))) {
    const libraryPath = join(librariesRoot, library);
    const stat = await fs.lstat(libraryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Library ${library} must be a real directory.`);
    libraryCount += 1;
    const graph = await readJson(join(libraryPath, 'graph.json')) as JsonRecord;
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.relationships)) {
      throw new Error(`Library ${library} has an invalid graph shape.`);
    }
    const nodeIds = new Set<string>();
    for (const node of graph.nodes) {
      if (typeof node.id !== 'string' || !node.id || nodeIds.has(node.id)) {
        throw new Error(`Library ${library} has an invalid or duplicate node identity.`);
      }
      nodeIds.add(node.id);
      const entryId = node.props?.entryId;
      if (node.label !== 'Entry' || !entries.has(entryId)) {
        throw new Error(`Library ${library} node ${node.id} has unresolved Entry ${String(entryId)}.`);
      }
      graphNodes += 1;
    }
    for (const edge of graph.relationships) {
      if (edge.label !== 'branch' || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        throw new Error(`Library ${library} has an invalid branch ${String(edge.from)} -> ${String(edge.to)}.`);
      }
    }
  }

  return {
    dataVersion: config.version,
    packages: snapshot.packages.length,
    entries: snapshot.entries.length,
    macros: snapshot.macros.length,
    usedMacros: usedMacros.size,
    contextEntries: contextEntries.size,
    libraries: libraryCount,
    graphNodes,
    assets: assetRefs.size,
  };
}

if (require.main === module) {
  verifyUiSpecWorkspace(process.argv[2] ?? process.cwd())
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
