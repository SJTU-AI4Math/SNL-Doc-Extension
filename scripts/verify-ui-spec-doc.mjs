#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseSnlSyntaxTree } from '@sjtu-ai4math/snl-basics/core';

const workspaceRoot = resolve(process.argv[2] ?? process.cwd());
const root = join(workspaceRoot, '.SNL_Doc');
const fail = (message) => { throw new Error(message); };
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const jsonFiles = (directory) => readdirSync(directory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => join(directory, name));
const packageIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;
const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const assertPackageId = (id) => {
  if (id === '_unpackaged') return;
  if (typeof id !== 'string' || !packageIdPattern.test(id) || id.toLowerCase().endsWith('.json') || windowsReserved.test(id)) {
    fail(`Invalid Package identity ${JSON.stringify(id)}.`);
  }
};
const identityHash = (kind, ...segments) => createHash('sha256')
  .update(Buffer.from(`snl-doc/v1\0${kind}\0${segments.join('\0')}`, 'utf8'))
  .digest('hex').slice(0, 20);
const expectedPath = (kind, packageId, id = packageId) => {
  const directory = kind === 'package' ? 'packages' : kind === 'entry' ? 'entries' : 'macros';
  const hash = kind === 'package'
    ? identityHash(kind, packageId)
    : identityHash(kind, packageId, id);
  return `${directory}/${packageId}-${hash}.json`;
};
const assertCanonicalPath = (file, kind, packageId, id) => {
  const actual = relative(root, file).split(sep).join('/');
  const expected = expectedPath(kind, packageId, id);
  if (actual !== expected) fail(`${actual} is not the canonical owner/hash path ${expected}.`);
};
const assertString = (value, label) => {
  if (typeof value !== 'string') fail(`${label} must be a string.`);
};

const config = readJson(join(root, 'config.json'));
if (config.version !== '0.1.0') fail(`Expected current data version 0.1.0, found ${JSON.stringify(config.version)}.`);
const validateKindCatalog = (field) => {
  if (!Array.isArray(config[field])) fail(`config.json#${field} must be an array.`);
  const ids = new Set();
  for (const [index, kind] of config[field].entries()) {
    if (!kind || typeof kind !== 'object' || typeof kind.id !== 'string' || !kind.id || ids.has(kind.id)) {
      fail(`config.json#${field}[${index}] has an invalid or duplicate identity.`);
    }
    for (const theme of ['light', 'dark']) {
      if (typeof kind.coloring?.[theme]?.stroke !== 'string' || typeof kind.coloring?.[theme]?.background !== 'string') {
        fail(`config.json#${field}[${index}] has invalid ${theme} coloring.`);
      }
    }
    ids.add(kind.id);
  }
  return ids;
};
const entryKinds = validateKindCatalog('entry_kinds');
const macroKinds = validateKindCatalog('macro_kinds');

const manifests = new Map();
for (const file of jsonFiles(join(root, 'packages'))) {
  const manifest = readJson(file);
  assertPackageId(manifest.id);
  assertCanonicalPath(file, 'package', manifest.id, manifest.id);
  if (manifest.format !== 'snl-package' || manifest.version !== 1 || manifest.schema_version !== 2 ||
      typeof manifest.name !== 'string' || typeof manifest.description !== 'string' || !Array.isArray(manifest.entry_ids)) {
    fail(`${relative(root, file)} is not a canonical current Package manifest.`);
  }
  const sortedIds = [...manifest.entry_ids].sort((left, right) => left.localeCompare(right));
  if (manifest.entry_ids.some((id) => typeof id !== 'string' || !id || id !== id.trim()) ||
      new Set(manifest.entry_ids).size !== manifest.entry_ids.length ||
      JSON.stringify(manifest.entry_ids) !== JSON.stringify(sortedIds)) {
    fail(`${relative(root, file)} entry_ids must be unique, non-empty, and sorted.`);
  }
  if (manifests.has(manifest.id)) fail(`Duplicate Package identity ${JSON.stringify(manifest.id)}.`);
  manifests.set(manifest.id, manifest);
}

const entries = new Map();
const entriesByPackage = new Map([...manifests].map(([id]) => [id, []]));
for (const file of jsonFiles(join(root, 'entries'))) {
  const envelope = readJson(file);
  const entry = envelope.entry;
  assertPackageId(envelope.package);
  if (envelope.format !== 'snl-entry' || envelope.version !== 1 ||
      (envelope.schema_version !== undefined && envelope.schema_version !== 1) ||
      !entry || typeof entry.id !== 'string' || !entry.id || envelope.package !== entry.package ||
      !entryKinds.has(entry.kind)) {
    fail(`${relative(root, file)} is not a supported current Entry envelope.`);
  }
  assertCanonicalPath(file, 'entry', envelope.package, entry.id);
  if (!manifests.has(envelope.package)) fail(`Entry ${entry.id} has missing owner Package ${envelope.package}.`);
  if (entries.has(entry.id)) fail(`Duplicate Entry identity ${JSON.stringify(entry.id)}.`);
  entries.set(entry.id, entry);
  entriesByPackage.get(envelope.package).push(entry.id);
}
for (const [packageId, ids] of entriesByPackage) {
  ids.sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(ids) !== JSON.stringify(manifests.get(packageId).entry_ids)) {
    fail(`Package ${packageId} entry_ids do not exactly match owned Entry entities.`);
  }
}

if (!Array.isArray(config.active_macro_packages) ||
    config.active_macro_packages.some((id) => typeof id !== 'string' || !manifests.has(id)) ||
    new Set(config.active_macro_packages).size !== config.active_macro_packages.length) {
  fail('config.json#active_macro_packages must contain unique existing Package identities.');
}
const activePackages = new Set(config.active_macro_packages);
const macros = new Map();
for (const file of jsonFiles(join(root, 'macros'))) {
  const envelope = readJson(file);
  const macro = envelope.macro;
  assertPackageId(envelope.package);
  if (envelope.format !== 'snl-macro' || envelope.version !== 1 || envelope.schema_version !== 1 ||
      !macro || typeof macro.name !== 'string' || !macro.name || !macroKinds.has(macro.kind) ||
      !Array.isArray(macro.styles) || macro.styles.some((style) =>
        !style || typeof style.style_name !== 'string' || !Array.isArray(style.tags) ||
        !style.template || typeof style.template !== 'object')) {
    fail(`${relative(root, file)} is not a canonical current Macro envelope.`);
  }
  assertCanonicalPath(file, 'macro', envelope.package, macro.name);
  if (!manifests.has(envelope.package)) fail(`Macro ${macro.name} has missing owner Package ${envelope.package}.`);
  if (!activePackages.has(envelope.package)) fail(`Macro ${macro.name} belongs to inactive Package ${envelope.package}.`);
  if (macros.has(macro.name)) fail(`Duplicate Macro identity ${JSON.stringify(macro.name)}.`);
  macros.set(macro.name, macro);
  if (!Array.isArray(macro.source?.entries) || !Array.isArray(macro.source?.urls)) {
    fail(`Macro ${macro.name} has an invalid source object.`);
  }
  for (const sourceId of macro.source.entries) {
    if (!entries.has(sourceId)) fail(`Macro ${macro.name} has unresolved source Entry ${sourceId}.`);
  }
}

const usedMacros = new Set();
const contextEntries = new Set();
const walk = (node, entryId) => {
  const id = node.macro_name;
  if (!node.env_mode && !id.startsWith('#')) {
    if (!macros.has(id)) fail(`Entry ${entryId} has unresolved Macro ${id}.`);
    usedMacros.add(id);
  }
  if (node.postfix?.name) {
    if (!entries.has(node.postfix.name)) fail(`Entry ${entryId} has unresolved context Entry ${node.postfix.name}.`);
    contextEntries.add(node.postfix.name);
  }
  for (const child of node.children ?? []) walk(child, entryId);
};

const assetRefs = new Set();
const assetsRoot = resolve(root, 'assets');
const realAssetsRoot = realpathSync(assetsRoot);
for (const [entryId, entry] of entries) {
  if (entry.content?.snl) walk(parseSnlSyntaxTree(entry.content.snl), entryId);
  if (typeof entry.content?.markdown === 'string') {
    for (const match of entry.content.markdown.matchAll(/(?:^|[(/])assets\/([^\s)]+)/g)) {
      const authoredPath = match[1];
      const path = resolve(assetsRoot, authoredPath);
      const relativePath = relative(assetsRoot, path);
      if (!relativePath || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
        fail(`Entry ${entryId} has unsafe asset path assets/${authoredPath}.`);
      }
      if (lstatSync(path).isSymbolicLink()) fail(`Entry ${entryId} asset ${relativePath} must not be a symlink.`);
      const realPath = realpathSync(path);
      const realRelative = relative(realAssetsRoot, realPath);
      if (!realRelative || isAbsolute(realRelative) || realRelative === '..' || realRelative.startsWith(`..${sep}`)) {
        fail(`Entry ${entryId} asset ${relativePath} escapes the assets root.`);
      }
      assetRefs.add(relativePath.split(sep).join('/'));
    }
  }
}

let graphNodes = 0;
let libraryCount = 0;
for (const library of readdirSync(join(root, 'libraries')).sort()) {
  const libraryPath = join(root, 'libraries', library);
  const stat = lstatSync(libraryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Library ${library} must be a real directory.`);
  libraryCount += 1;
  const graph = readJson(join(libraryPath, 'graph.json'));
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.relationships)) fail(`Library ${library} has an invalid graph shape.`);
  const nodeIds = new Set();
  for (const node of graph.nodes) {
    if (typeof node.id !== 'string' || !node.id || nodeIds.has(node.id)) fail(`Library ${library} has an invalid or duplicate node identity.`);
    nodeIds.add(node.id);
    const entryId = node.props?.entryId;
    if (node.label !== 'Entry' || !entries.has(entryId)) fail(`Library ${library} node ${node.id} has unresolved Entry ${entryId}.`);
    graphNodes += 1;
  }
  for (const edge of graph.relationships) {
    if (edge.label !== 'branch' || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      fail(`Library ${library} has an invalid branch ${edge.from} -> ${edge.to}.`);
    }
  }
}

console.log(JSON.stringify({
  dataVersion: config.version,
  packages: manifests.size,
  entries: entries.size,
  macros: macros.size,
  usedMacros: usedMacros.size,
  contextEntries: contextEntries.size,
  libraries: libraryCount,
  graphNodes,
  assets: assetRefs.size,
}, null, 2));
