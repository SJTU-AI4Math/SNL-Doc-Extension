#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseSnlSyntaxTree } from '@sjtu-ai4math/snl-basics/core';

const workspaceRoot = resolve(process.argv[2] ?? process.cwd());
const root = join(workspaceRoot, '.SNL_Doc');
const fail = (message) => { throw new Error(message); };
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const jsonFiles = (directory) => readdirSync(directory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => join(directory, name));

const config = readJson(join(root, 'config.json'));
if (config.version !== '0.1.0') fail(`Expected current data version 0.1.0, found ${JSON.stringify(config.version)}.`);

const manifests = new Map();
for (const file of jsonFiles(join(root, 'packages'))) {
  const manifest = readJson(file);
  if (manifests.has(manifest.id)) fail(`Duplicate Package identity ${JSON.stringify(manifest.id)}.`);
  if (manifest.schema_version !== 2 || !Array.isArray(manifest.entry_ids)) {
    fail(`${relative(root, file)} is not a current schema-v2 Package manifest.`);
  }
  manifests.set(manifest.id, manifest);
}

const entries = new Map();
const entriesByPackage = new Map([...manifests].map(([id]) => [id, []]));
for (const file of jsonFiles(join(root, 'entries'))) {
  const envelope = readJson(file);
  const entry = envelope.entry;
  if ((envelope.schema_version !== undefined && envelope.schema_version !== 1) ||
      !entry?.id || envelope.package !== entry.package) {
    fail(`${relative(root, file)} is not a supported current Entry envelope.`);
  }
  if (!manifests.has(envelope.package)) fail(`Entry ${entry.id} has missing owner Package ${envelope.package}.`);
  if (entries.has(entry.id)) fail(`Duplicate Entry identity ${JSON.stringify(entry.id)}.`);
  entries.set(entry.id, entry);
  entriesByPackage.get(envelope.package).push(entry.id);
}
for (const [packageId, ids] of entriesByPackage) {
  ids.sort();
  const declared = [...manifests.get(packageId).entry_ids].sort();
  if (JSON.stringify(ids) !== JSON.stringify(declared)) {
    fail(`Package ${packageId} entry_ids do not exactly match owned Entry entities.`);
  }
}

const activePackages = new Set(config.active_macro_packages ?? []);
const macros = new Map();
for (const file of jsonFiles(join(root, 'macros'))) {
  const envelope = readJson(file);
  const macro = envelope.macro;
  if (envelope.schema_version !== 1 || !macro?.name || !macro.kind || !Array.isArray(macro.styles)) {
    fail(`${relative(root, file)} is not a canonical current Macro envelope.`);
  }
  if (!manifests.has(envelope.package)) fail(`Macro ${macro.name} has missing owner Package ${envelope.package}.`);
  if (!activePackages.has(envelope.package)) fail(`Macro ${macro.name} belongs to inactive Package ${envelope.package}.`);
  if (macros.has(macro.name)) fail(`Duplicate Macro identity ${JSON.stringify(macro.name)}.`);
  macros.set(macro.name, macro);
  for (const sourceId of macro.source?.entries ?? []) {
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
for (const [entryId, entry] of entries) {
  if (entry.content?.snl) walk(parseSnlSyntaxTree(entry.content.snl), entryId);
  if (typeof entry.content?.markdown === 'string') {
    for (const match of entry.content.markdown.matchAll(/(?:^|[(/])assets\/([^\s)]+)/g)) {
      const name = basename(match[1]);
      const path = resolve(root, 'assets', name);
      if (relative(resolve(root, 'assets'), path).startsWith('..')) fail(`Entry ${entryId} has unsafe asset path.`);
      if (lstatSync(path).isSymbolicLink()) fail(`Entry ${entryId} asset ${name} must not be a symlink.`);
      assetRefs.add(name);
    }
  }
}

let graphNodes = 0;
for (const library of readdirSync(join(root, 'libraries')).sort()) {
  const graphPath = join(root, 'libraries', library, 'graph.json');
  const graph = readJson(graphPath);
  const nodeIds = new Set();
  for (const node of graph.nodes ?? []) {
    if (nodeIds.has(node.id)) fail(`Library ${library} has duplicate node ${node.id}.`);
    nodeIds.add(node.id);
    const entryId = node.props?.entryId;
    if (node.label !== 'Entry' || !entries.has(entryId)) fail(`Library ${library} node ${node.id} has unresolved Entry ${entryId}.`);
    graphNodes += 1;
  }
  for (const edge of graph.relationships ?? []) {
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
  libraries: readdirSync(join(root, 'libraries')).length,
  graphNodes,
  assets: assetRefs.size,
}, null, 2));
