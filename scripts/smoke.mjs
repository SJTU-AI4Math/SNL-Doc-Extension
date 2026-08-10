// Node-only smoke test for the `.SNL_Doc/` filesystem helpers in
// `out/snlDoc.js`.
//
// `snlDoc.ts` imports the `vscode` module (for `workspace.fs` + `Uri`). We
// don't have a VS Code host here, so we install a tiny shim that backs
// `workspace.fs` with Node's `fs/promises` and models `Uri` as a plain
// filesystem path (option (b) from the task spec). The shim is injected into
// the CommonJS module loader BEFORE requiring `out/snlDoc.js`, so the
// module's internal `require('vscode')` resolves to it.
//
// Run: `npm run smoke` (compiles first, then executes this file).

import Module from 'node:module';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// vscode shim
// ---------------------------------------------------------------------------

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
let beforeWriteHook = null;
let failNextRename = false;
const fsEvents = [];

class Uri {
  constructor(fsPath, scheme = 'file', authority = '') {
    this.fsPath = fsPath;
    this.path = fsPath;
    this.scheme = scheme;
    this.authority = authority;
  }
  static file(p) {
    return new Uri(p);
  }
  static joinPath(base, ...segments) {
    return new Uri(nodePath.join(base.fsPath, ...segments), base.scheme, base.authority);
  }
  toString() {
    return `${this.scheme}://${this.authority}${this.fsPath}`;
  }
}

const workspace = {
  fs: {
    async stat(uri) {
      const link = await fs.lstat(uri.fsPath);
      let type;
      if (link.isSymbolicLink()) {
        const target = await fs.stat(uri.fsPath);
        type = FileType.SymbolicLink |
          (target.isDirectory() ? FileType.Directory : target.isFile() ? FileType.File : FileType.Unknown);
      } else {
        type = link.isDirectory() ? FileType.Directory : link.isFile() ? FileType.File : FileType.Unknown;
      }
      return {
        type,
        ctime: 0,
        mtime: 0,
        size: link.size
      };
    },
    async readFile(uri) {
      return new Uint8Array(await fs.readFile(uri.fsPath));
    },
    async writeFile(uri, data) {
      fsEvents.push(`write:${uri.fsPath}`);
      if (beforeWriteHook) await beforeWriteHook(uri);
      await fs.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
      await fs.writeFile(uri.fsPath, Buffer.from(data));
    },
    async createDirectory(uri) {
      await fs.mkdir(uri.fsPath, { recursive: true });
    },
    async rename(source, target, options = {}) {
      fsEvents.push(`rename:${source.fsPath}->${target.fsPath}`);
      if (failNextRename) {
        failNextRename = false;
        throw new Error('injected rename failure');
      }
      if (!options.overwrite) {
        try {
          await fs.stat(target.fsPath);
          const error = new Error('Target already exists');
          error.code = 'EEXIST';
          throw error;

        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      await fs.rename(source.fsPath, target.fsPath);
    },
    async delete(uri, options = {}) {
      await fs.rm(uri.fsPath, {
        recursive: options.recursive === true,
        force: options.useTrash !== true
      });
    },
    async readDirectory(uri) {
      const dirents = await fs.readdir(uri.fsPath, { withFileTypes: true });
      return dirents.map((d) => [
        d.name,
        d.isDirectory() ? FileType.Directory : FileType.File
      ]);
    }
  }
};

const vscodeShim = { Uri, FileType, workspace };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeShim;
  }
  return originalLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------
// assertion helpers
// ---------------------------------------------------------------------------

let passed = 0;
function assert(cond, label) {
  if (!cond) {
    console.error(`  x FAIL: ${label}`);
    throw new Error(`Assertion failed: ${label}`);
  }
  passed += 1;
  console.log(`  ok ${label}`);
}

function themedColoring(stroke, background, darkStroke = stroke, darkBackground = background) {
  return {
    light: { stroke, background },
    dark: { stroke: darkStroke, background: darkBackground }
  };
}

async function readConfig(root) {
  const raw = await fs.readFile(
    nodePath.join(root, '.SNL_Doc', 'config.json'),
    'utf8'
  );
  return JSON.parse(raw);
}

async function readEntries(root) {
  const raw = await fs.readFile(
    nodePath.join(root, '.SNL_Doc', 'entries.json'),
    'utf8'
  );
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const outUrl = pathToFileURL(
    nodePath.resolve(process.cwd(), 'out', 'snlDoc.js')
  ).href;
  const snlDoc = await import(outUrl);
  const { packageManifestPath } = await import(pathToFileURL(
    nodePath.resolve(process.cwd(), 'out', 'entityStorage.js')
  ).href);

  const {
    initSnlDoc,
    applyEntryKindsPreset,
    createEntryKind,
    updateEntryKind,
    readEntryKinds,
    readMacroKinds,
    applyMacroKindsPreset,
    createMacroKind,
    addEntry,
    rollbackCreatedEntry,
    updateEntry,
    entityRevision,
    macroPackageMetadataRevision,
    readEntries: readEntriesApi,
    readOverview,
    createMacroPackage,
    updateMacroPackage,
    deleteMacroPackage,
    readMacroPackage,
    readMacroPackages,
    addMacro,
    updateMacro,
    readAllMacros,
    setMacroPackageActive,
    batchDeleteMacros,
    batchMoveMacros,
    batchCopyMacros,
    batchPackageAsNew,
    batchMoveToNewPackage,
    createLibrary,
    deleteLibrary,
    updateLibrary,
    readLibraryGraph,
    writeLibraryGraph,
    mutateLibraryGraph,
    readLibraryCounters,
    listLibraries,
    readLibraryMeta,
    writeLibraryMeta,
    addRelationship,
    updateRelationship,
    readRelationships,
    readWorkspaceSupportedLanguages,
    addWorkspaceSupportedLanguage
  } = snlDoc;

  const tmpRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-'));
  const root = Uri.file(tmpRoot);
  console.log(`temp workspace: ${tmpRoot}`);

  const uninitializedLanguageRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-no-config-'));
  const uninitializedLanguages = await readWorkspaceSupportedLanguages(Uri.file(uninitializedLanguageRoot));
  assert(uninitializedLanguages.some((language) => language.id === 'en') &&
    uninitializedLanguages.some((language) => language.id === 'zh-CN'),
  'uninitialized workspace exposes built-in authoring languages without an error');
  await fs.rm(uninitializedLanguageRoot, { recursive: true, force: true });

  console.log('\n[0] initSnlDoc repairs an empty partial skeleton');
  const partialRootPath = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-partial-'));
  const partialSnlRoot = nodePath.join(partialRootPath, '.SNL_Doc');
  await fs.mkdir(partialSnlRoot, { recursive: true });
  const partialInit = await initSnlDoc(Uri.file(partialRootPath));
  assert(partialInit.status === 'created', 'partial init is repaired as created');
  assert((await readConfig(partialRootPath)).version === '0.0.9', 'partial init writes config marker');
  await fs.stat(nodePath.join(partialSnlRoot, 'entries'));
  await fs.stat(nodePath.join(partialSnlRoot, 'macros'));
  await fs.stat(nodePath.join(partialSnlRoot, 'packages'));
  await fs.stat(nodePath.join(partialSnlRoot, 'libraries'));
  assert(true, 'partial init completes entity directories');

  const futureInitRootPath = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-future-init-'));
  const futureInitSnlRoot = nodePath.join(futureInitRootPath, '.SNL_Doc');
  await fs.mkdir(futureInitSnlRoot, { recursive: true });
  await fs.writeFile(
    nodePath.join(futureInitSnlRoot, 'config.json'),
    JSON.stringify({ version: '999.0.0', entry_kinds: [], macro_kinds: [] })
  );
  let futureInitRejected = false;
  try {
    await initSnlDoc(Uri.file(futureInitRootPath));
  } catch {
    futureInitRejected = true;
  }
  assert(futureInitRejected, 'init rejects a future-version workspace');
  let futureEntriesCreated = false;
  try {
    await fs.stat(nodePath.join(futureInitSnlRoot, 'entries.json'));
    futureEntriesCreated = true;
  } catch {}
  assert(!futureEntriesCreated, 'rejected future-version init performs no repair writes');

  const concurrentRootPath = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-concurrent-init-'));
  const concurrentRoot = Uri.file(concurrentRootPath);
  const concurrentResults = await Promise.all([
    initSnlDoc(concurrentRoot),
    initSnlDoc(concurrentRoot)
  ]);
  assert(
    concurrentResults.every((result) => result.status === 'created'),
    'concurrent init callers share one successful initialization'
  );

  const conflictingRootPath = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-conflicting-init-'));
  const conflictingSnlRoot = nodePath.join(conflictingRootPath, '.SNL_Doc');
  await fs.mkdir(conflictingSnlRoot, { recursive: true });
  const conflictingEntries = '[{"id":"keep-me"}]\n';
  await fs.writeFile(nodePath.join(conflictingSnlRoot, 'entries.json'), conflictingEntries);
  let conflictingInitRejected = false;
  try {
    await initSnlDoc(Uri.file(conflictingRootPath));
  } catch {
    conflictingInitRejected = true;
  }
  assert(conflictingInitRejected, 'init refuses non-empty entries without config');
  assert(
    await fs.readFile(nodePath.join(conflictingSnlRoot, 'entries.json'), 'utf8') === conflictingEntries,
    'refused init preserves unknown entries byte-for-byte'
  );
  assert(
    (await fs.readdir(conflictingSnlRoot)).every((name) => name === 'entries.json'),
    'refused init creates no sibling entity directories'
  );

  const packageConflictRootPath = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-package-conflict-'));
  const packageConflictSnlRoot = nodePath.join(packageConflictRootPath, '.SNL_Doc');
  const packageConflictDir = nodePath.join(packageConflictSnlRoot, 'term_macros');
  await fs.mkdir(packageConflictDir, { recursive: true });
  await fs.writeFile(nodePath.join(packageConflictDir, 'keep.json'), '{"keep":true}\n');
  let packageConflictRejected = false;
  try {
    await initSnlDoc(Uri.file(packageConflictRootPath));
  } catch {
    packageConflictRejected = true;
  }
  assert(packageConflictRejected, 'init refuses Macro package data without config');
  let packageConflictEntriesCreated = false;
  try {
    await fs.stat(nodePath.join(packageConflictSnlRoot, 'entries.json'));
    packageConflictEntriesCreated = true;
  } catch {}
  assert(!packageConflictEntriesCreated, 'unknown-data rejection creates no entries payload');
  assert(
    await fs.readFile(nodePath.join(packageConflictDir, 'keep.json'), 'utf8') === '{"keep":true}\n',
    'unknown-data rejection preserves Macro package bytes'
  );
  assert(
    (await fs.readdir(packageConflictSnlRoot)).every((name) => name === 'term_macros'),
    'Macro backup conflict creates no sibling entity directories'
  );

  const manifestConflictRootPath = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-manifest-conflict-'));
  const manifestConflictSnlRoot = nodePath.join(manifestConflictRootPath, '.SNL_Doc');
  const manifestConflictPackages = nodePath.join(manifestConflictSnlRoot, 'packages');
  await fs.mkdir(manifestConflictPackages, { recursive: true });
  await fs.writeFile(
    nodePath.join(manifestConflictPackages, packageManifestPath('_unpackaged').split('/').at(-1)),
    '{"conflicting":true}\n'
  );
  let manifestConflictRejected = false;
  try { await initSnlDoc(Uri.file(manifestConflictRootPath)); }
  catch { manifestConflictRejected = true; }
  assert(manifestConflictRejected, 'init rejects a conflicting canonical _unpackaged manifest');
  assert(
    (await fs.readdir(manifestConflictSnlRoot)).every((name) => name === 'packages'),
    'manifest conflict is detected before sibling repair directories are created'
  );

  const renameFailureRootPath = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-init-rename-'));
  failNextRename = true;
  let renameInitRejected = false;
  try {
    await initSnlDoc(Uri.file(renameFailureRootPath));
  } catch {
    renameInitRejected = true;
  }
  const renameFailureFiles = await fs.readdir(nodePath.join(renameFailureRootPath, '.SNL_Doc'));
  assert(renameInitRejected, 'atomic config publish failure rejects init');
  assert(!renameFailureFiles.includes('config.json'), 'failed publish leaves no config completion marker');
  assert(
    renameFailureFiles.every((name) => !name.startsWith('.config.init-')),
    'failed publish removes its temporary config file'
  );
  assert(
    (await initSnlDoc(Uri.file(renameFailureRootPath))).status === 'created',
    'init retries successfully after atomic publish failure'
  );

  const remoteRootPath = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-remote-writer-'));
  const remoteRoot = new Uri(remoteRootPath, 'vscode-remote', 'ssh-remote+test');
  let releaseRemoteWrite;
  let announceRemoteWrite;
  const remoteWriteEntered = new Promise((resolve) => { announceRemoteWrite = resolve; });
  const remoteWriteRelease = new Promise((resolve) => { releaseRemoteWrite = resolve; });
  beforeWriteHook = async (uri) => {
    if (uri.fsPath.includes(nodePath.join(remoteRootPath, '.SNL_Doc', 'packages'))) {
      announceRemoteWrite();
      await remoteWriteRelease;
    }
  };
  const remoteInit = initSnlDoc(remoteRoot);
  await remoteWriteEntered;
  let remoteKindSettled = false;
  const remoteKind = createEntryKind(remoteRoot, {
    id: 'remote-kind',
    name: 'Remote Kind',
    coloring: themedColoring('#123456', '#abcdef'),
    defaultCounterName: '',
    style: ''
  }).then((result) => {
    remoteKindSettled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(!remoteKindSettled, 'remote mutation waits for in-process init writer lock');
  releaseRemoteWrite();
  beforeWriteHook = null;
  assert((await remoteInit).status === 'created', 'remote init completes after release');
  assert((await remoteKind).status === 'created', 'queued remote mutation runs after init');

  fsEvents.length = 0;
  const atomicOrderRootPath = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-init-order-'));
  await initSnlDoc(Uri.file(atomicOrderRootPath));
  const entriesWriteIndex = fsEvents.findIndex((event) => event.includes('/.SNL_Doc/packages/'));
  const configRenameIndex = fsEvents.findIndex((event) => event.includes('->') && event.endsWith('/.SNL_Doc/config.json'));
  assert(
    entriesWriteIndex >= 0 && configRenameIndex > entriesWriteIndex,
    'config completion marker is atomically renamed after payload writes'
  );

  console.log('\n[1] initSnlDoc');
  const init = await initSnlDoc(root);
  assert(init.status === 'created', 'initSnlDoc -> created');

  console.log('\n[1b] repo-level supported languages');
  assert(
    (await readWorkspaceSupportedLanguages(root)).map((language) => language.id).join(',') === 'zh-CN,en',
    'new workspace exposes built-in authoring languages'
  );
  const addFrench = await addWorkspaceSupportedLanguage(root, {
    id: 'fr_fr', display_name: ' Français '
  });
  assert(addFrench.status === 'added' && addFrench.language.id === 'fr-FR',
    'custom language is canonicalized and persisted');
  const languageConfig = await readConfig(tmpRoot);
  assert(Array.isArray(languageConfig.supported_languages) &&
    languageConfig.supported_languages.some((language) => language.id === 'fr-FR'),
  'custom language catalog lives in repo .SNL_Doc/config.json');
  assert((await readWorkspaceSupportedLanguages(root)).some((language) => language.id === 'fr-FR'),
    'persisted custom language is visible to later readers');
  const duplicateFrench = await addWorkspaceSupportedLanguage(root, {
    id: 'FR-fr', display_name: 'French duplicate'
  });
  assert(duplicateFrench.status === 'exists', 'language ids are unique after canonicalization');
  languageConfig.supported_languages.find((language) => language.id === 'fr-FR').vendor = { keep: true };
  await fs.writeFile(
    nodePath.join(tmpRoot, '.SNL_Doc', 'config.json'),
    `${JSON.stringify(languageConfig, null, 2)}\n`,
    'utf8'
  );
  const addGerman = await addWorkspaceSupportedLanguage(root, {
    id: 'de', display_name: 'Deutsch'
  });
  assert(addGerman.status === 'added', 'a second custom language is persisted');
  const extendedLanguageConfig = await readConfig(tmpRoot);
  assert(extendedLanguageConfig.supported_languages.find((language) => language.id === 'fr-FR')
    ?.vendor?.keep === true,
  'adding a language preserves unknown fields on existing language descriptors');

  console.log('\n[2] applyEntryKindsPreset(fulcrum-math-notes)');
  const applied = await applyEntryKindsPreset(root, 'fulcrum-math-notes');
  assert(applied.status === 'applied', 'applyEntryKindsPreset -> applied');
  assert(applied.count === 16, `preset applied 16 kinds (got ${applied.count})`);

  const cfg = await readConfig(tmpRoot);
  assert(
    cfg.version === '0.0.9',
    `config.version === "0.0.9" (got ${cfg.version})`
  );
  assert(
    Array.isArray(cfg.entry_kinds) && cfg.entry_kinds.length === 16,
    `config has 16 entry_kinds (got ${cfg.entry_kinds?.length})`
  );
  const defn = cfg.entry_kinds.find((k) => k.id === 'definition');
  assert(!!defn, 'definition kind present');
  assert(
    defn.coloring &&
      defn.coloring.light.stroke === '#00651B' &&
      defn.coloring.light.background === '#D6FEE0' &&
      typeof defn.coloring.dark.stroke === 'string' &&
      typeof defn.coloring.dark.background === 'string',
    'definition coloring matches Fulcrum preset'
  );
  // 2026-07-16: EntryKind.numbering renamed to defaultCounterName (a plain
  // counter NAME, not a DSL). The Fulcrum preset seeds the slug of the kind.
  assert(
    defn.defaultCounterName === 'definition',
    'definition defaultCounterName === "definition"'
  );
  assert(
    typeof cfg.entry_kinds[0].defaultCounterName === 'string',
    'entry_kinds[0].defaultCounterName is defined + a string'
  );
  // writeConfig (via applyEntryKindsPreset) must NOT emit the legacy
  // `numbering` field on any kind.
  assert(
    cfg.entry_kinds.every((k) => !('numbering' in k)),
    'no entry_kinds[i].numbering field written by writeConfig'
  );
  const kindsConfigPath = nodePath.join(tmpRoot, '.SNL_Doc', 'config.json');
  const kindsConfigWithExtension = JSON.parse(await fs.readFile(kindsConfigPath, 'utf8'));
  kindsConfigWithExtension.entry_kinds.find((kind) => kind.id === 'definition').vendor_kind = { keep: true };
  await fs.writeFile(kindsConfigPath, JSON.stringify(kindsConfigWithExtension, null, 2));

  console.log('\n[3] addEntryKind (createEntryKind) fresh id');
  const created = await createEntryKind(root, {
    id: 'scratch-note',
    name: 'Scratch Note',
    coloring: themedColoring('#123456', '#abcdef'),
    defaultCounterName: 'scratch',
    style: ''
  });
  assert(created.status === 'created', 'createEntryKind -> created');
  const cfg2 = await readConfig(tmpRoot);
  assert(cfg2.entry_kinds.length === 17, 'entry_kinds now 17 after append');
  assert(cfg2.entry_kinds.find((kind) => kind.id === 'definition').vendor_kind?.keep === true,
    'Entry Kind create preserves unknown fields on untouched catalog records');
  const cfg2Raw = JSON.parse(await fs.readFile(kindsConfigPath, 'utf8'));
  const scratchWithExtension = cfg2Raw.entry_kinds.find((kind) => kind.id === 'scratch-note');
  scratchWithExtension.vendor_kind = { editedRecord: true };
  await fs.writeFile(kindsConfigPath, JSON.stringify(cfg2Raw, null, 2));
  const scratchRevisionRecord = (await readEntryKinds(root)).find((kind) => kind.id === 'scratch-note');
  const staleKindRevision = entityRevision(scratchRevisionRecord);
  const newerKind = await updateEntryKind(root, 'scratch-note', {
    name: 'Scratch Note Newer', coloring: themedColoring('#123456', '#abcdef'),
    defaultCounterName: 'scratch', style: ''
  }, staleKindRevision);
  assert(newerKind.status === 'updated', 'concurrent Entry Kind edit fixture succeeds');
  const cfgAfterKindUpdate = await readConfig(tmpRoot);
  assert(cfgAfterKindUpdate.entry_kinds.find((kind) => kind.id === 'definition').vendor_kind?.keep === true,
    'Entry Kind update preserves unknown fields on untouched catalog records');
  assert(cfgAfterKindUpdate.entry_kinds.find((kind) => kind.id === 'scratch-note').vendor_kind?.editedRecord === true,
    'Entry Kind update overlays managed fields onto unknown fields of the edited record');
  assert((await updateEntryKind(root, 'scratch-note', {
    name: 'Scratch Note Stale', coloring: themedColoring('#123456', '#abcdef'),
    defaultCounterName: 'scratch', style: ''
  }, staleKindRevision)).status === 'conflict', 'stale Kind editor revision is rejected');

  console.log('\n[4] addEntryKind duplicate id');
  const dupKind = await createEntryKind(root, {
    id: 'scratch-note',
    name: 'Scratch Note Again',
    coloring: themedColoring('#000000', '#ffffff'),
    defaultCounterName: '',
    style: ''
  });
  assert(dupKind.status === 'duplicate', 'createEntryKind dup -> duplicate');

  console.log('\n[5] applyEntryKindsPreset again -> nonEmpty');
  const again = await applyEntryKindsPreset(root, 'fulcrum-math-notes');
  assert(again.status === 'nonEmpty', 'applyEntryKindsPreset re-run -> nonEmpty');

  console.log('\n[6] addEntry valid');
  const entry = {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    kind: 'definition',
    title: 'Group',
    content: { text: 'A set with an associative binary op...' },
    contribution_info: null,
    pointer: null
  };
  const addOk = await addEntry(root, entry);
  assert(addOk.status === 'ok', 'addEntry valid -> ok');
  const entries = await readEntriesApi(root);
  assert(
    entries.length === 1 && entries[0].id === entry.id && entries[0].package === '_unpackaged',
    'per-entity storage has the appended Entry in _unpackaged'
  );
  assert(addOk.revision === entityRevision(entries[0]),
    'addEntry returns the exact persisted canonical Entry revision');

  const rollbackLibrary = await createLibrary(root, 'Rollback Check');
  assert(rollbackLibrary.status === 'created', 'rollback fixture Library is created');
  const rollbackSlug = rollbackLibrary.slug;
  const rollbackEntry = {
    id: 'rollback-unreferenced-entry', kind: 'definition', title: 'Rollback',
    content: {}, contribution_info: null, pointer: null
  };
  const rollbackAdd = await addEntry(root, rollbackEntry);
  assert(rollbackAdd.status === 'ok', 'rollback fixture Entry is created');
  const rollbackResult = await rollbackCreatedEntry(root, rollbackEntry.id, rollbackAdd.revision);
  assert(rollbackResult.status === 'ok',
    `unchanged unreferenced created Entry rolls back (${JSON.stringify(rollbackResult)})`);
  assert(!(await readEntriesApi(root)).some((candidate) => candidate.id === rollbackEntry.id),
    'successful rollback removes the exact persisted Entry');

  const referencedEntry = { ...rollbackEntry, id: 'rollback-referenced-entry' };
  const referencedAdd = await addEntry(root, referencedEntry);
  assert(referencedAdd.status === 'ok', 'referenced rollback fixture Entry is created');
  assert((await writeLibraryGraph(root, rollbackSlug, {
    nodes: [{ id: 'ref', label: 'Entry', props: { entryId: referencedEntry.id } }],
    relationships: []
  })).status === 'ok', 'referenced rollback fixture graph is written');
  const referencedRollback = await rollbackCreatedEntry(
    root, referencedEntry.id, referencedAdd.revision
  );
  assert(referencedRollback.status === 'referenced', 'rollback refuses a referenced Entry');
  assert((await readEntriesApi(root)).some((candidate) => candidate.id === referencedEntry.id),
    'referenced rollback refusal preserves the Entry');

  const malformedEntry = { ...rollbackEntry, id: 'rollback-malformed-graph-entry' };
  const malformedAdd = await addEntry(root, malformedEntry);
  assert(malformedAdd.status === 'ok', 'malformed-census rollback fixture Entry is created');
  const rollbackGraphPath = nodePath.join(
    tmpRoot, '.SNL_Doc', 'libraries', rollbackSlug, 'graph.json'
  );
  await fs.writeFile(rollbackGraphPath, JSON.stringify({
    nodes: [{ props: { entryId: malformedEntry.id } }], relationships: []
  }));
  const malformedRollback = await rollbackCreatedEntry(
    root, malformedEntry.id, malformedAdd.revision
  );
  assert(malformedRollback.status === 'invalid',
    'rollback fails closed when exhaustive raw Library graph census is malformed');
  assert((await readEntriesApi(root)).some((candidate) => candidate.id === malformedEntry.id),
    'malformed graph census never deletes the candidate Entry');
  await fs.writeFile(rollbackGraphPath, JSON.stringify({ nodes: [], relationships: [] }));
  assert((await rollbackCreatedEntry(root, referencedEntry.id, referencedAdd.revision)).status === 'ok',
    'referenced rollback fixture cleans up after removing its graph reference');
  assert((await rollbackCreatedEntry(root, malformedEntry.id, malformedAdd.revision)).status === 'ok',
    'malformed-census rollback fixture cleans up after restoring its graph');

  const graphLinkEntry = { ...rollbackEntry, id: 'rollback-graph-link-entry' };
  const graphLinkAdd = await addEntry(root, graphLinkEntry);
  assert(graphLinkAdd.status === 'ok', 'graph-link rollback fixture Entry is created');
  const externalGraphPath = nodePath.join(
    await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-census-graph-link-')),
    'external-graph.json'
  );
  await fs.writeFile(externalGraphPath, JSON.stringify({ nodes: [], relationships: [] }));
  await fs.unlink(rollbackGraphPath);
  await fs.symlink(externalGraphPath, rollbackGraphPath, 'file');
  const graphLinkRollback = await rollbackCreatedEntry(
    root, graphLinkEntry.id, graphLinkAdd.revision
  );
  assert(graphLinkRollback.status === 'invalid',
    'symlinked graph target cannot redirect the rollback census');
  assert((await readEntriesApi(root)).some((candidate) => candidate.id === graphLinkEntry.id),
    'symlinked graph census preserves the candidate Entry');
  await fs.unlink(rollbackGraphPath);
  await fs.writeFile(rollbackGraphPath, JSON.stringify({ nodes: [], relationships: [] }));
  assert((await rollbackCreatedEntry(root, graphLinkEntry.id, graphLinkAdd.revision)).status === 'ok',
    'graph-link rollback fixture cleans up after restoring its graph');

  for (const dangling of [
    { id: 'dangling-source', from: 'missing-node', to: 'known-node', label: 'edge' },
    { id: 'dangling-target', from: 'known-node', to: 'missing-node', label: 'edge' }
  ]) {
    const danglingEntry = {
      ...rollbackEntry,
      id: `rollback-${dangling.id}-entry`
    };
    const danglingAdd = await addEntry(root, danglingEntry);
    assert(danglingAdd.status === 'ok', `${dangling.id} rollback fixture Entry is created`);
    await fs.writeFile(rollbackGraphPath, JSON.stringify({
      nodes: [{ id: 'known-node', label: 'Branch', props: {} }],
      relationships: [dangling]
    }));
    let danglingMutationCallbackRan = false;
    const danglingMutation = await mutateLibraryGraph(root, rollbackLibrary.slug, () => {
      danglingMutationCallbackRan = true;
      return false;
    });
    assert(danglingMutation.status === 'invalid',
      `${dangling.id} relationship is rejected by raw graph mutation`);
    assert(!danglingMutationCallbackRan,
      `${dangling.id} relationship is rejected before graph mutation callback`);
    const danglingRollback = await rollbackCreatedEntry(
      root, danglingEntry.id, danglingAdd.revision
    );
    assert(danglingRollback.status === 'invalid',
      `${dangling.id} relationship makes rollback census fail closed`);
    assert((await readEntriesApi(root)).some((candidate) => candidate.id === danglingEntry.id),
      `${dangling.id} census preserves the candidate Entry`);
    await fs.writeFile(rollbackGraphPath, JSON.stringify({ nodes: [], relationships: [] }));
    assert((await rollbackCreatedEntry(root, danglingEntry.id, danglingAdd.revision)).status === 'ok',
      `${dangling.id} rollback fixture cleans up after restoring its graph`);
  }

  const censusEntry = { ...rollbackEntry, id: 'rollback-census-failure-entry' };
  const censusAdd = await addEntry(root, censusEntry);
  assert(censusAdd.status === 'ok', 'directory-census rollback fixture Entry is created');
  const rollbackLibrariesPath = nodePath.join(tmpRoot, '.SNL_Doc', 'libraries');
  const heldLibrariesPath = nodePath.join(tmpRoot, '.SNL_Doc', 'libraries-held-for-test');
  await fs.rename(rollbackLibrariesPath, heldLibrariesPath);
  const censusFailure = await rollbackCreatedEntry(root, censusEntry.id, censusAdd.revision);
  assert(censusFailure.status === 'invalid', 'Library directory enumeration failure blocks rollback');
  assert((await readEntriesApi(root)).some((candidate) => candidate.id === censusEntry.id),
    'Library census failure preserves the candidate Entry');
  const externalCensusRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-census-root-link-'));
  await fs.symlink(externalCensusRoot, rollbackLibrariesPath, 'dir');
  const symlinkCensusFailure = await rollbackCreatedEntry(
    root, censusEntry.id, censusAdd.revision
  );
  assert(symlinkCensusFailure.status === 'invalid',
    'symlinked libraries root cannot redirect the rollback census');
  assert((await readEntriesApi(root)).some((candidate) => candidate.id === censusEntry.id),
    'symlinked rollback census preserves the candidate Entry');
  await fs.unlink(rollbackLibrariesPath);
  await fs.rename(heldLibrariesPath, rollbackLibrariesPath);
  assert((await rollbackCreatedEntry(root, censusEntry.id, censusAdd.revision)).status === 'ok',
    'directory-census rollback fixture cleans up after restoring libraries');

  const changedEntry = { ...rollbackEntry, id: 'rollback-changed-entry' };
  const changedAdd = await addEntry(root, changedEntry);
  assert(changedAdd.status === 'ok', 'changed rollback fixture Entry is created');
  const changedUpdate = await updateEntry(root, changedEntry.id, {
    ...changedEntry, title: 'Changed after creation'
  }, changedAdd.revision);
  assert(changedUpdate.status === 'updated', 'changed rollback fixture is updated');
  assert((await rollbackCreatedEntry(root, changedEntry.id, changedAdd.revision)).status === 'conflict',
    'stale created revision cannot roll back a changed Entry');
  assert((await rollbackCreatedEntry(root, changedEntry.id, changedUpdate.revision)).status === 'ok',
    'changed rollback fixture cleans up with its current exact revision');

  const partialLocalizedEntry = {
    id: 'partial-localized-entry',
    kind: 'definition',
    title: { type: 'i18n', default_language: 'en', values: { 'zh-CN': '局部标题' } },
    content: {
      text: { type: 'i18n', default_language: 'en', values: { 'zh-CN': '条目' } }
    },
    contribution_info: null,
    pointer: null
  };
  assert((await addEntry(root, partialLocalizedEntry)).status === 'ok',
    'Entry write accepts a partial localized content map');
  const partialLocalizedRoundTrip = (await readEntriesApi(root))
    .find((candidate) => candidate.id === partialLocalizedEntry.id);
  assert(
    partialLocalizedRoundTrip?.content?.text?.values?.['zh-CN'] === '条目' &&
      !Object.prototype.hasOwnProperty.call(partialLocalizedRoundTrip.content.text.values, 'en'),
    'Entry partial localized content survives write then current-topology read'
  );
  assert(
    partialLocalizedRoundTrip?.title?.values?.['zh-CN'] === '局部标题' &&
      !Object.prototype.hasOwnProperty.call(partialLocalizedRoundTrip.title.values, 'en'),
    'Entry partial localized title survives write then current-topology read'
  );

  console.log('\n[7] addEntry duplicate id');
  const dupEntry = await addEntry(root, { ...entry, title: 'Group (dup)' });
  assert(dupEntry.status === 'duplicate', 'addEntry dup id -> duplicate');

  console.log('\n[8] addEntry unknown kind');
  const unknown = await addEntry(root, {
    id: 'a1b2c3d4-0000-4000-8000-000000000002',
    kind: 'nonexistent',
    title: 'Bad Kind',
    content: {},
    contribution_info: null,
    pointer: null
  });
  assert(unknown.status === 'unknownKind', 'addEntry bad kind -> unknownKind');

  console.log('\n[9] addEntry with only whitespace title is accepted (v2)');
  // Title is now optional (cat 2026-07-06). Whitespace-only trims to '' and
  // is stored as empty; the entry is valid.
  const noTitle = await addEntry(root, {
    id: 'a1b2c3d4-0000-4000-8000-000000000003',
    kind: 'definition',
    title: '   ',
    content: {
      markdown: {
        type: 'i18n',
        default_language: 'en',
        values: { en: 'Definition', 'zh-CN': '定义' }
      }
    },
    contribution_info: null,
    pointer: null
  });
  assert(noTitle.status === 'ok', 'addEntry with empty/whitespace title -> ok (v2)');

  console.log('\n[10] readEntries + readOverview.entries');
  const readBack = await readEntriesApi(root);
  // Three entries now: the base, partial-I18n, and empty-title fixtures.
  assert(
    Array.isArray(readBack) && readBack.length === 3,
    `readEntries returns 3-element array (got ${readBack?.length})`
  );
  const firstEntry = readBack.find((e) => e.id === entry.id);
  assert(
    firstEntry &&
      firstEntry.kind === entry.kind &&
      firstEntry.title === entry.title,
    'readEntries record matches what was written'
  );
  const localizedEntry = readBack.find(
    (e) => e.id === 'a1b2c3d4-0000-4000-8000-000000000003'
  );
  assert(
    localizedEntry?.content?.markdown?.values?.['zh-CN'] === '定义',
    'addEntry preserves I18n content without projecting it'
  );
  const updateLocalized = await updateEntry(root, localizedEntry.id, {
    ...localizedEntry,
    content: {
      text: {
        type: 'i18n',
        default_language: 'en',
        values: { en: 'Axiom', 'zh-CN': '公理' }
      }
    }
  }, entityRevision(localizedEntry));
  assert(updateLocalized.status === 'updated', 'updateEntry accepts I18n content');
  const afterLocalizedUpdate = await readEntriesApi(root);
  const localizedAfterUpdate = afterLocalizedUpdate.find((e) => e.id === localizedEntry.id);
  assert(
    updateLocalized.status === 'updated' &&
      updateLocalized.revision === entityRevision(localizedAfterUpdate),
    'updateEntry returns the exact committed revision'
  );
  assert(
    localizedAfterUpdate?.content?.text?.values?.['zh-CN'] === '公理',
    'updateEntry round-trips I18n content without deleting it'
  );
  const overview = await readOverview(root);
  assert(
    Array.isArray(overview.entries) &&
      overview.entries.length === 3 &&
      overview.entries.some((e) => e.id === entry.id),
    'readOverview.entries includes the entry with the same id'
  );

  console.log('\n[11] createMacroPackage(test_pkg)');
  const mkPkg = await createMacroPackage(root, 'test_pkg', 'Test Package', 'desc');
  assert(mkPkg.status === 'ok', 'createMacroPackage -> ok');
  assert(mkPkg.file === 'test_pkg.json', 'createMacroPackage file === test_pkg.json');

  console.log('\n[11b] move Entry from _unpackaged to a named Package');
  const entryBeforeMove = (await readEntriesApi(root)).find((candidate) => candidate.id === entry.id);
  const movedEntry = await updateEntry(root, entry.id, {
    ...entryBeforeMove,
    package: 'test_pkg'
  }, entityRevision(entryBeforeMove));
  assert(movedEntry.status === 'updated', `updateEntry moves an Entry between Packages (${JSON.stringify(movedEntry)})`);
  const entryAfterMove = (await readEntriesApi(root)).find((candidate) => candidate.id === entry.id);
  assert(entryAfterMove?.package === 'test_pkg', 'moved Entry round-trips with its new Package');
  const entityFilesAfterMove = (await fs.readdir(nodePath.join(tmpRoot, '.SNL_Doc', 'entries')))
    .filter((name) => name.endsWith('.json'));
  assert(
    entityFilesAfterMove.some((name) => name.startsWith('test_pkg-')) &&
      !entityFilesAfterMove.some((name) => name.includes(entry.id)),
    'Entry move uses the stable hashed target path rather than embedding the Entry ID'
  );
  const movedEntityFile = entityFilesAfterMove.find((name) => name.startsWith('test_pkg-'));
  const movedEntityPath = nodePath.join(tmpRoot, '.SNL_Doc', 'entries', movedEntityFile);
  const movedEnvelope = JSON.parse(await fs.readFile(movedEntityPath, 'utf8'));
  movedEnvelope.entry.vendor_extension = { keep: true };
  movedEnvelope.entry.content.vendor_format = { opaque: 7 };
  await fs.writeFile(movedEntityPath, JSON.stringify(movedEnvelope, null, 2) + '\n');
  const extendedBeforeUpdate = (await readEntriesApi(root)).find((candidate) => candidate.id === entry.id);
  const preserveUnknown = await updateEntry(root, entry.id, {
    ...extendedBeforeUpdate,
    title: 'Group with extensions'
  }, entityRevision(extendedBeforeUpdate));
  assert(preserveUnknown.status === 'updated', 'updateEntry accepts a migrated Entry with unknown fields');
  const extendedAfterUpdate = (await readEntriesApi(root)).find((candidate) => candidate.id === entry.id);
  assert(
    extendedAfterUpdate.vendor_extension?.keep === true &&
      extendedAfterUpdate.content.vendor_format?.opaque === 7,
    'updateEntry preserves unknown top-level and content extension fields'
  );
  const staleRevision = entityRevision(extendedAfterUpdate);
  const externallyEditedEnvelope = JSON.parse(await fs.readFile(movedEntityPath, 'utf8'));
  externallyEditedEnvelope.entry.title = 'External edit';
  await fs.writeFile(movedEntityPath, JSON.stringify(externallyEditedEnvelope, null, 2) + '\n');
  const staleUpdate = await updateEntry(root, entry.id, {
    ...extendedAfterUpdate,
    title: 'Stale editor overwrite'
  }, staleRevision);
  assert(staleUpdate.status === 'error' && /changed after/.test(staleUpdate.message),
    'updateEntry rejects a stale editor revision');
  assert(
    (await readEntriesApi(root)).find((candidate) => candidate.id === entry.id)?.title === 'External edit',
    'stale Entry save leaves the external edit intact'
  );
  const blockedPackageDelete = await deleteMacroPackage(root, 'test_pkg');
  assert(
    blockedPackageDelete.status === 'error' && /contains 1 Entry/.test(blockedPackageDelete.message),
    'Package deletion refuses to orphan an Entry assigned to that Package'
  );

  console.log('\n[12] createMacroPackage duplicate');
  const dupPkg = await createMacroPackage(root, 'test_pkg', 'Test Package');
  assert(dupPkg.status === 'duplicate', 'createMacroPackage dup -> duplicate');
  const dottedPkg = await createMacroPackage(root, 'logic.extra', 'Dotted Package');
  assert(dottedPkg.status === 'ok', 'dotted Package ID can be created');
  const dottedRead = await readMacroPackage(root, 'logic.extra');
  assert(dottedRead.status === 'ok', 'dotted Package fixture can be read for revision');
  const dottedUpdate = await updateMacroPackage(
    root,
    'logic.extra',
    { name: 'Dotted Updated', description: '' },
    macroPackageMetadataRevision(dottedRead.raw)
  );
  assert(dottedUpdate.status === 'updated',
    `dotted Package ID can be updated (${JSON.stringify(dottedUpdate)})`);
  assert((await deleteMacroPackage(root, 'logic.extra')).status === 'ok',
    'dotted Package ID can be deleted');
  const jsonSuffixPackage = await createMacroPackage(root, 'foo.json', 'Must Reject');
  assert(jsonSuffixPackage.status === 'invalid',
    'Package ID ending in .json is rejected rather than silently normalized to foo');
  const caseFoldDupPkg = await createMacroPackage(root, 'TEST_PKG', 'Case-fold duplicate');
  assert(
    caseFoldDupPkg.status === 'duplicate',
    'createMacroPackage rejects case-fold-equivalent Package identities'
  );

  console.log('\n[13] createMacroPackage invalid file name');
  const badPkg = await createMacroPackage(root, '../evil', 'Evil');
  assert(badPkg.status === 'invalid', 'createMacroPackage bad file -> invalid');

  console.log('\n[14] readMacroPackage empty');
  const readEmpty = await readMacroPackage(root, 'test_pkg');
  assert(readEmpty.status === 'ok', 'readMacroPackage -> ok');
  assert(
    Array.isArray(readEmpty.macros) && readEmpty.macros.length === 0,
    'readMacroPackage macros is empty array'
  );
  assert(
    readEmpty.pkg.name === 'Test Package' && readEmpty.pkg.version === '11',
    'readMacroPackage pkg metadata round-trips at canonical version 11'
  );

  const validMacro = {
    name: 'Add.add.infix',
    description: 'addition (infix)',
    source: { entries: [], urls: [] },
    kind: 'const',
    dynamic_arity: false,
    tags: [],
    styles: [
      {
        style_name: 'infix',
        tags: [],
        template: {
          mode: 'formula_inline', body: '#0 + #1',
          typst: { built_in: '', synthesis: { mode: 'formula', macro: '' } },
          latex: { built_in: '', synthesis: { mode: 'formula', macro: '' } },
          markdown: '', text: ''
        }
      }
    ]
  };

  console.log('\n[15] addMacro valid');
  const addOkMacro = await addMacro(root, 'test_pkg', validMacro);
  assert(addOkMacro.status === 'ok', `addMacro valid -> ok (${JSON.stringify(addOkMacro)})`);
  assert(addOkMacro.name === 'Add.add.infix', 'addMacro returns name');

  console.log('\n[15b] addMacro language-specific text styles');
  const localizedMacro = {
    ...validMacro,
    name: 'Group.prose',
    styles: [{
      style_name: 'prose',
      template: { type: 'i18n', default_language: 'en', values: {
        en: { mode: 'text', body: '#0 is a group' },
        'zh-CN': { mode: 'text', body: '#0 是群' }
      } },
      tags: []
    }]
  };
  const addLocalizedMacro = await addMacro(root, 'test_pkg', localizedMacro);
  assert(addLocalizedMacro.status === 'ok', `addMacro accepts localized text template (${JSON.stringify(addLocalizedMacro)})`);
  const localizedMacroRead = await readMacroPackage(root, 'test_pkg');
  assert(
    localizedMacroRead.macros.find((m) => m.name === 'Group.prose')?.styles?.[0]?.template?.values?.['zh-CN']?.body === '#0 是群',
    'localized text template round-trips without changing style identity'
  );

  console.log('\n[16] addMacro duplicate');
  const dupMacro = await addMacro(root, 'test_pkg', validMacro);
  assert(dupMacro.status === 'duplicate', 'addMacro dup -> duplicate');

  console.log('\n[17] addMacro empty template -> invalid');
  const badMacro = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'Bad.macro',
    styles: [{ style_name: 'default', template: { mode: 'formula_inline', body: '   ' }, tags: [] }]
  });
  assert(badMacro.status === 'invalid', 'addMacro empty template -> invalid');

  console.log('\n[17b] addMacro with legacy per-style mode "math" -> invalid');
  const legacyModeMacro = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'Legacy.mode',
    styles: [{ style_name: 'default', mode: 'math', template: '#0', tags: [] }]
  });
  assert(
    legacyModeMacro.status === 'invalid',
    'addMacro legacy per-style mode:"math" -> invalid (renamed to formula_inline in v6)'
  );

  console.log('\n[17c] addMacro forbidden-char names -> invalid');
  // Shared SNL identifier rule: ASCII is allow-listed; visible Unicode is broad.
  for (const badName of [
    'bad@name', 'bad#name', 'bad$name', 'bad%name', 'bad name', ' bad', 'bad ',
    'bad(name)', 'bad[name]', 'bad{name}',
    'bad!name', 'bad&name', 'bad+name', 'bad,name', 'bad/name',
    'bad:name', 'bad;name', 'bad=name', 'bad?name', 'bad^name',
    'bad`name', 'bad|name', 'bad~name', 'bad\\name',
    `bad\u200bname`, `bad\u202ename`,
  ]) {
    const r = await addMacro(root, 'test_pkg', { ...validMacro, name: badName });
    assert(r.status === 'invalid', `addMacro rejects reserved char in name: ${JSON.stringify(badName)}`);
  }
  // Allowed: backslash, dot, hyphen, Unicode letters.
  for (const okName of ['\\foo', 'foo.bar', 'foo-bar', 'δελτα', '中文名']) {
    const r = await addMacro(root, 'test_pkg', { ...validMacro, name: okName });
    assert(r.name === okName, `addMacro accepts non-ASCII / backslash / hyphen / dotted name: ${okName}`);
  }

  console.log('\n[17c] addMacro missing style_name -> invalid');
  const noTagMacro = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'NoTag.macro',
    styles: [{ mode: 'formula_inline', template: '#0', tags: [] }]
  });
  assert(noTagMacro.status === 'invalid', 'addMacro missing style_name -> invalid');
  const spacedStyleName = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'BadStyleName',
    styles: [{ ...validMacro.styles[0], style_name: 'default ' }]
  });
  assert(spacedStyleName.status === 'invalid', 'addMacro rejects a whitespace-normalized style_name');

  console.log('\n[17d] addMacro with duplicate style tags -> invalid');
  const dupTagMacro = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'DupTag.macro',
    styles: [
      { style_name: 'x', template: { mode: 'formula_inline', body: '#0' }, tags: [] },
      { style_name: 'x', template: { mode: 'text', body: '#0 (text)' }, tags: [] }
    ]
  });
  assert(dupTagMacro.status === 'invalid', 'addMacro duplicate tags -> invalid');

  console.log('\n[17e] Macro v11 localization invariants');
  const localizedFormula = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'Bad.localizedFormula',
    styles: [{
      style_name: 'default',
      template: {
        type: 'i18n',
        default_language: 'en',
        values: {
          en: { mode: 'formula_inline', body: '#0' },
          'zh-CN': { mode: 'formula_inline', body: '#0' }
        }
      },
      tags: []
    }]
  });
  assert(localizedFormula.status === 'ok', 'formula Macro accepts whole-template I18n');
  const localizedText = await addMacro(root, 'test_pkg', {
    ...localizedMacro,
    name: 'Bad.localizedText',
    styles: [{
      style_name: 'default',
      template: {
        type: 'i18n',
        default_language: 'en',
        values: {
          en: { mode: 'text', body: '#0 is a group' },
          'zh-CN': { mode: 'text', body: '#0 是群' }
        }
      },
      tags: []
    }]
  });
  assert(
    localizedText.status === 'ok',
    'text Macro accepts I18n template'
  );
  const missingMacroDefault = await addMacro(root, 'test_pkg', {
    ...localizedMacro,
    name: 'Bad.missingMacroDefault',
    styles: [{
      style_name: 'default', tags: [],
      template: { type: 'i18n', default_language: 'en', values: {
        'zh-CN': { mode: 'text', body: '#0 是群' }
      } }
    }]
  });
  assert(
    missingMacroDefault.status === 'invalid',
    'Macro I18n template requires its declared default projection'
  );
  const incompleteDynamic = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'Bad.dynamicTemplate',
    dynamic_arity: true,
    styles: [{ style_name: 'default', template: { mode: 'text', body: 'all' }, tags: [] }]
  });
  assert(
    incompleteDynamic.status === 'invalid',
    'dynamic Macro requires #*'
  );

  console.log('\n[18] addMacro to missing package -> noFile');
  const noFileMacro = await addMacro(root, 'no_such_pkg', validMacro);
  assert(noFileMacro.status === 'noFile', 'addMacro missing pkg -> noFile');

  console.log('\n[19] readMacroPackage after add -> 1 macro');
  const readOne = await readMacroPackage(root, 'test_pkg.json');
  assert(readOne.status === 'ok', 'readMacroPackage (with .json) -> ok');
  assert(
    // 1 initial + 3 localized whole-template Macros + 5 allowed names.
    readOne.macros.length === 9 &&
      readOne.macros.some((m) => m.name === 'Add.add.infix') &&
      readOne.macros.some((m) => m.name === 'Group.prose'),
    'readMacroPackage returns all 9 appended macros including localized whole-template Macros'
  );

  console.log('\n[20] readMacroPackage missing -> noFile');
  const readMissing = await readMacroPackage(root, 'does_not_exist');
  assert(readMissing.status === 'noFile', 'readMacroPackage missing -> noFile');

  console.log('\n[20a] readMacroPackage rejects an explicit future package version');
  const futureTmpRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-future-macro-'));
  const futureRoot = Uri.file(futureTmpRoot);
  await fs.mkdir(nodePath.join(futureTmpRoot, '.SNL_Doc', 'term_macros'), { recursive: true });
  await fs.writeFile(
    nodePath.join(futureTmpRoot, '.SNL_Doc', 'config.json'),
    JSON.stringify({ version: '0.0.4', entry_kinds: [], macro_kinds: [] }, null, 2)
  );
  const futureMacroPackageUri = Uri.joinPath(
    futureRoot, '.SNL_Doc', 'term_macros', 'future_pkg.json'
  );
  const futureMacroPackageBytes = JSON.stringify({
    version: '12', name: 'Future', macros: {}
  }, null, 2);
  await fs.writeFile(futureMacroPackageUri.fsPath, futureMacroPackageBytes);
  const readFutureMacro = await readMacroPackage(futureRoot, 'future_pkg');
  assert(readFutureMacro.status === 'error', 'readMacroPackage future package -> error');
  assert(
    await fs.readFile(futureMacroPackageUri.fsPath, 'utf8') === futureMacroPackageBytes,
    'future Macro package rejection is byte-preserving'
  );

  console.log('\n[20b] readMacroPackage normalizes a legacy-shape package on load');
  // Write an OLD-shape package straight to disk: two macros sharing a base name
  // (Mul.mul.infix + Mul.mul.implicit), each with katex_react.mode === 'math'
  // and typst/latex.synthesis.output_type (pre-0.4.0). readMacroPackage must
  // normalize them in-memory all the way to strict Macro v9: a single
  // `Mul.mul` macro with a styles array and canonical style_name/tags.
  const legacyTmpRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-legacy-'));
  const legacyRoot = Uri.file(legacyTmpRoot);
  await fs.mkdir(nodePath.join(legacyTmpRoot, '.SNL_Doc', 'term_macros'), { recursive: true });
  await fs.writeFile(
    nodePath.join(legacyTmpRoot, '.SNL_Doc', 'config.json'),
    JSON.stringify({ version: '0.0.4', entry_kinds: [], macro_kinds: [] }, null, 2)
  );
  const legacyPkgUri = Uri.joinPath(
    legacyRoot,
    '.SNL_Doc',
    'term_macros',
    'legacy_pkg.json'
  );
  const legacyPkg = {
    version: '1',
    name: 'Legacy Pkg',
    macros: {
      'Mul.mul.infix': {
        description: 'multiplication (infix, cdot)',
        source: { entries: [], urls: [] },
        typst: { built_in: '', synthesis: { output_type: 'text', macro: '#0 * #1' } },
        latex: { built_in: '', synthesis: { output_type: 'formula', macro: '' } },
        katex_react: { arity: 'fixed', mode: 'math', kind: 'const', template: '#0 \\cdot #1' }
      },
      'Mul.mul.implicit': {
        description: 'multiplication (implicit)',
        source: { entries: [], urls: [] },
        katex_react: { arity: 'fixed', mode: 'math', kind: 'const', template: '#0#1' }
      }
    }
  };
  await fs.mkdir(nodePath.dirname(legacyPkgUri.fsPath), { recursive: true });
  await fs.writeFile(legacyPkgUri.fsPath, JSON.stringify(legacyPkg, null, 2));
  const readLegacy = await readMacroPackage(legacyRoot, 'legacy_pkg');
  assert(readLegacy.status === 'ok', 'readMacroPackage legacy -> ok');
  const oldMacro = readLegacy.macros.find((m) => m.name === 'Mul.mul');
  assert(!!oldMacro, 'legacy macros grouped into base "Mul.mul"');
  assert(
    !('katex_react' in oldMacro),
    'katex_react dropped from normalized macro'
  );
  assert(oldMacro.dynamic_arity === false, 'v9: dynamic_arity=false (was arity=fixed)');
  assert(!('arity' in oldMacro), 'legacy arity field dropped in v9');
  assert(oldMacro.kind === 'const', 'kind lifted to top-level');
  assert(Array.isArray(oldMacro.styles), 'styles is a v11 array');
  assert(
    oldMacro.styles.length === 2,
    `both dotted suffixes became styles (got ${oldMacro.styles.length})`
  );
  const infixStyle = oldMacro.styles.find((s) => s.style_name === 'infix');
  const implicitStyle = oldMacro.styles.find((s) => s.style_name === 'implicit');
  assert(!!infixStyle && !!implicitStyle, 'infix and implicit styles present');
  assert(
    oldMacro.styles[0].style_name === 'infix',
    `styles[0] (default) is the first legacy sibling (got ${oldMacro.styles[0].style_name})`
  );
  assert(!('default_style' in oldMacro), 'legacy Macro normalizes without a language-to-style map');
  assert(
    infixStyle.template.mode === 'formula_inline',
    "v11: template mode 'math'->'formula_inline' (no display=block on legacy)"
  );
  assert(!('display' in infixStyle), 'v6: display axis folded into mode');
  assert(
    infixStyle.template.body === '#0 \\cdot #1',
    'style template preserved'
  );
  assert(Array.isArray(oldMacro.tags) && oldMacro.tags.length === 0, 'v8 macro tags default to []');
  assert(oldMacro.styles.every((style) => Array.isArray(style.tags)), 'v8 style tags default to []');
  assert(
    infixStyle.template.typst.synthesis.mode === 'text' &&
      !('output_type' in infixStyle.template.typst.synthesis),
    'template typst.synthesis.output_type moved to .mode'
  );
  assert(
    infixStyle.template.latex.synthesis.mode === 'formula' &&
      !('output_type' in infixStyle.template.latex.synthesis),
    'template latex.synthesis.output_type moved to .mode'
  );

  console.log('\n[20c] macro kinds: read empty -> apply preset -> create -> readback');
  const emptyMacroKinds = await readMacroKinds(root);
  assert(
    Array.isArray(emptyMacroKinds) && emptyMacroKinds.length === 0,
    'readMacroKinds empty -> []'
  );
  const mkApplied = await applyMacroKindsPreset(root, 'snl-basics-defaults');
  assert(
    mkApplied.status === 'applied',
    'applyMacroKindsPreset -> applied'
  );
  assert(
    mkApplied.count === 6,
    `snl-basics-defaults seeds 6 kinds (5 Lean-Expr + sub) (got ${mkApplied.count})`
  );
  const mkAfterPreset = await readMacroKinds(root);
  assert(mkAfterPreset.length === 6, 'readMacroKinds now 6 after preset');
  const ruleKind = mkAfterPreset.find((k) => k.id === 'rule');
  assert(!!ruleKind, 'rule macro kind present');
  assert(
    ruleKind.coloring.light.stroke === '#00651B' &&
      ruleKind.coloring.light.background === '#D6FEE0' &&
      ruleKind.coloring.dark.stroke === '#4ADE80' &&
      ruleKind.coloring.dark.background === '#14532D',
    'rule kind colors match the themed green preset'
  );
  const subKind = mkAfterPreset.find((k) => k.id === 'sub');
  assert(!!subKind, 'sub macro kind present in preset');
  assert(
    subKind.coloring.light.stroke === 'inherit' &&
      subKind.coloring.light.background === 'transparent' &&
      subKind.coloring.dark.stroke === 'inherit' &&
      subKind.coloring.dark.background === 'transparent',
    'sub kind uses inherit / transparent in both themes (no visual frame)'
  );

  const mkPresetAgain = await applyMacroKindsPreset(root, 'snl-basics-defaults');
  assert(
    mkPresetAgain.status === 'nonEmpty',
    'applyMacroKindsPreset re-run -> nonEmpty'
  );

  const mkCreated = await createMacroKind(root, {
    id: 'custom',
    name: 'Custom',
    description: 'A user-defined macro kind.',
    coloring: themedColoring('#123456', '#abcdef')
  });
  assert(mkCreated.status === 'created', 'createMacroKind -> created');
  const mkAfterCreate = await readMacroKinds(root);
  assert(mkAfterCreate.length === 7, 'readMacroKinds now 7 after create');
  const custom = mkAfterCreate.find((k) => k.id === 'custom');
  assert(
    !!custom &&
      custom.name === 'Custom' &&
      custom.description === 'A user-defined macro kind.' &&
      custom.coloring.light.stroke === '#123456' &&
      custom.coloring.light.background === '#abcdef' &&
      custom.coloring.dark.stroke === '#123456' &&
      custom.coloring.dark.background === '#abcdef',
    'created macro kind round-trips'
  );

  const mkDup = await createMacroKind(root, {
    id: 'rule',
    name: 'Dupe',
    description: '',
    coloring: themedColoring('#000000', '#ffffff')
  });
  assert(mkDup.status === 'duplicate', 'createMacroKind dup id -> duplicate');

  const overviewMk = await readOverview(root);
  assert(
    Array.isArray(overviewMk.macroKinds) && overviewMk.macroKinds.length === 7,
    'readOverview surfaces 7 macroKinds (5 Lean-Expr + sub + custom)'
  );
  // SNoogL index: overview.allMacros = flat index of every macro across every
  // package. This test root has multiple macros in test_pkg (Add.add.infix
  // from [15] plus 4 more allowed-name macros from [17c]). Assert non-empty
  // and that Add.add.infix is present with correct package origin.
  assert(
    Array.isArray(overviewMk.allMacros),
    'readOverview.allMacros is an array (SNoogL index)'
  );
  // SNoogL index: overview.allMacros = flat index of every macro across every
  // package. This test root has multiple macros in test_pkg (Add.add.infix
  // from [15] plus 4 more allowed-name macros from [17c]). Assert non-empty
  // and that Add.add.infix is present with correct package origin.
  assert(
    Array.isArray(overviewMk.allMacros),
    'readOverview.allMacros is an array (SNoogL index)'
  );
  const idx = overviewMk.allMacros.find((m) => m.id === 'Add.add.infix');
  assert(!!idx, 'SNoogL index contains Add.add.infix from test_pkg');
  assert(
    idx.packageFile === 'test_pkg.json' && idx.packageName === 'Test Package',
    'SNoogL entry carries packageFile + packageName from disk'
  );

  console.log('\n[20d] active_macro_packages: create -> membership -> filtered readAllMacros');
  const mkFoo = await createMacroPackage(root, 'foo', 'Foo Package');
  assert(mkFoo.status === 'ok', 'createMacroPackage(foo) -> ok');
  const cfgActive = await readConfig(tmpRoot);
  assert(
    Array.isArray(cfgActive.active_macro_packages) &&
      cfgActive.active_macro_packages.includes('foo'),
    'config.active_macro_packages includes foo after create'
  );
  const packageDir = nodePath.join(tmpRoot, '.SNL_Doc', 'packages');
  const fooManifestName = (await fs.readdir(packageDir)).find((name) => name.startsWith('foo-'));
  const fooManifestPath = nodePath.join(packageDir, fooManifestName);
  const fooManifestBytes = await fs.readFile(fooManifestPath, 'utf8');
  const configBeforeCorruption = await fs.readFile(nodePath.join(tmpRoot, '.SNL_Doc', 'config.json'), 'utf8');
  const corruptManifest = JSON.parse(fooManifestBytes);
  corruptManifest.id = 'wrong-id';
  await fs.writeFile(fooManifestPath, JSON.stringify(corruptManifest, null, 2) + '\n');
  let malformedActiveRejected = false;
  try {
    await setMacroPackageActive(root, 'foo', true);
  } catch {
    malformedActiveRejected = true;
  }
  assert(malformedActiveRejected, 'active-package mutation propagates malformed manifest storage');
  assert(
    await fs.readFile(nodePath.join(tmpRoot, '.SNL_Doc', 'config.json'), 'utf8') === configBeforeCorruption,
    'malformed manifest cannot overwrite active_macro_packages'
  );
  await fs.writeFile(fooManifestPath, fooManifestBytes);
  // foo starts empty; give it one macro, then flip the active list to prove
  // readAllMacros gates purely on active-list membership.
  await addMacro(root, 'foo', { ...validMacro, name: 'Foo.only' });
  const allActive = await readAllMacros(root);
  assert(
    Object.prototype.hasOwnProperty.call(allActive, 'Foo.only'),
    'readAllMacros includes Foo.only while foo is active'
  );
  // Deactivate foo -> its macro disappears from readAllMacros.
  await setMacroPackageActive(root, 'foo', false);
  const allFiltered = await readAllMacros(root);
  assert(
    !Object.prototype.hasOwnProperty.call(allFiltered, 'Foo.only'),
    'readAllMacros excludes Foo.only after foo removed from active list'
  );
  assert(
    Object.prototype.hasOwnProperty.call(allFiltered, 'Add.add.infix'),
    'readAllMacros still includes test_pkg macros (test_pkg active)'
  );

  console.log('\n[20e] atomic per-entity Macro batch operations');
  assert((await createMacroPackage(root, 'batch_dest', 'Batch Destination')).status === 'ok',
    'create destination Package for batch operations');
  const copiedBatch = await batchCopyMacros(root, 'test_pkg', 'batch_dest', ['Add.add.infix']);
  assert(copiedBatch.status === 'ok' && copiedBatch.copiedCount === 1,
    'batchCopyMacros commits one copied Macro');
  const batchMacroDir = nodePath.join(tmpRoot, '.SNL_Doc', 'macros');
  let groupProsePath;
  for (const name of await fs.readdir(batchMacroDir)) {
    if (!name.endsWith('.json')) continue;
    const candidatePath = nodePath.join(batchMacroDir, name);
    const candidate = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
    if (candidate.package === 'test_pkg' && candidate.macro?.name === 'Group.prose') {
      groupProsePath = candidatePath;
      candidate.vendor_envelope = { provenance: 'preserve-across-move' };
      await fs.writeFile(candidatePath, JSON.stringify(candidate, null, 2) + '\n');
      break;
    }
  }
  assert(typeof groupProsePath === 'string', 'locates source Macro envelope for move extension fixture');
  const movedBatch = await batchMoveMacros(root, 'test_pkg', 'batch_dest', ['Group.prose']);
  assert(movedBatch.status === 'ok' && movedBatch.movedCount === 1,
    'batchMoveMacros atomically moves one Macro between existing Packages');
  let movedGroupEnvelope;
  for (const name of await fs.readdir(batchMacroDir)) {
    if (!name.endsWith('.json')) continue;
    const candidate = JSON.parse(await fs.readFile(nodePath.join(batchMacroDir, name), 'utf8'));
    if (candidate.package === 'batch_dest' && candidate.macro?.name === 'Group.prose') {
      movedGroupEnvelope = candidate;
      break;
    }
  }
  assert(movedGroupEnvelope?.vendor_envelope?.provenance === 'preserve-across-move',
    'batchMoveMacros preserves unknown source envelope fields at the destination');
  const packagedBatch = await batchPackageAsNew(
    root, 'test_pkg', ['Add.add.infix'], 'batch_copy', 'Batch Copy'
  );
  assert(packagedBatch.status === 'ok' && packagedBatch.copiedCount === 1,
    'batchPackageAsNew atomically creates and populates a Package');
  const movedNewBatch = await batchMoveToNewPackage(
    root, 'batch_dest', ['Group.prose'], 'batch_move', 'Batch Move'
  );
  assert(movedNewBatch.status === 'ok' && movedNewBatch.movedCount === 1,
    'batchMoveToNewPackage atomically creates destination and removes source Macro');
  const deletedBatch = await batchDeleteMacros(root, 'batch_dest', ['Add.add.infix']);
  assert(deletedBatch.status === 'ok' && deletedBatch.deletedCount === 1,
    'batchDeleteMacros deletes an entity Macro');
  assert(
    (await readMacroPackage(root, 'batch_move')).macros.some((macro) => macro.name === 'Group.prose') &&
      !(await readMacroPackage(root, 'batch_dest')).macros.some((macro) => macro.name === 'Group.prose'),
    'batch operations leave exactly the intended Macro ownership'
  );

  const entityEntryFiles = (await fs.readdir(nodePath.join(tmpRoot, '.SNL_Doc', 'entries')))
    .filter((name) => name.endsWith('.json'));
  const extensionEntryPath = nodePath.join(tmpRoot, '.SNL_Doc', 'entries', entityEntryFiles[0]);
  const extensionEntryEnvelope = JSON.parse(await fs.readFile(extensionEntryPath, 'utf8'));
  extensionEntryEnvelope.vendor_envelope = { keep: true };
  extensionEntryEnvelope.entry.contribution_info = { name: 'Legacy Contributor' };
  await fs.writeFile(extensionEntryPath, JSON.stringify(extensionEntryEnvelope));
  const extensionEntry = extensionEntryEnvelope.entry;
  assert((await updateEntry(root, extensionEntry.id, extensionEntry, entityRevision(extensionEntry))).status === 'updated',
    'Entry edit succeeds with an envelope extension');
  assert(JSON.parse(await fs.readFile(extensionEntryPath, 'utf8')).vendor_envelope?.keep === true,
    'Entry edit preserves unknown envelope fields');
  assert(JSON.parse(await fs.readFile(extensionEntryPath, 'utf8')).entry.contribution_info?.name === 'Legacy Contributor',
    'Entry edit preserves an untouched legacy structured Contributor');

  const macroDirPath = nodePath.join(tmpRoot, '.SNL_Doc', 'macros');
  let extensionMacroName;
  for (const name of await fs.readdir(macroDirPath)) {
    if (!name.endsWith('.json')) continue;
    try {
      const envelope = JSON.parse(await fs.readFile(nodePath.join(macroDirPath, name), 'utf8'));
      if (envelope.package === 'batch_move') {
        extensionMacroName = name;
        break;
      }
    } catch { /* strict reader tests malformed files separately below */ }
  }
  const extensionMacroPath = nodePath.join(macroDirPath, extensionMacroName);
  const extensionMacroEnvelope = JSON.parse(await fs.readFile(extensionMacroPath, 'utf8'));
  extensionMacroEnvelope.vendor_envelope = { keep: true };
  await fs.writeFile(extensionMacroPath, JSON.stringify(extensionMacroEnvelope));
  const batchMovePackage = await readMacroPackage(root, 'batch_move');
  assert(batchMovePackage.status === 'ok', 'Macro Package fixture loads for envelope extension test');
  assert((await updateMacroPackage(root, 'batch_move', {
    name: batchMovePackage.pkg.name,
    description: batchMovePackage.pkg.description ?? ''
  }, macroPackageMetadataRevision(batchMovePackage.raw))).status === 'updated', 'Package metadata edit succeeds with Macro envelope extensions');
  assert(JSON.parse(await fs.readFile(extensionMacroPath, 'utf8')).vendor_envelope?.keep === true,
    'Package metadata edit preserves unknown Macro envelope fields');
  assert((await batchMoveMacros(root, 'batch_move', 'batch_dest', ['Group.prose'])).status === 'ok',
    'Macro move fixture succeeds with an envelope extension');
  let movedMacroEnvelope;
  for (const name of await fs.readdir(macroDirPath)) {
    try {
      const envelope = JSON.parse(await fs.readFile(nodePath.join(macroDirPath, name), 'utf8'));
      if (envelope.package === 'batch_dest' && envelope.macro?.name === 'Group.prose') {
        movedMacroEnvelope = envelope;
        break;
      }
    } catch { /* ignore non-JSON residue fixtures */ }
  }
  assert(movedMacroEnvelope?.vendor_envelope?.keep === true,
    'moving a Macro to an existing Package preserves source envelope extensions');

  const originalWriteFile = workspace.fs.writeFile;
  const originalDeleteFile = workspace.fs.delete;
  let injectedCommitFailure = true;
  workspace.fs.writeFile = async (uri, data) => {
    if (injectedCommitFailure && uri.fsPath.endsWith(nodePath.join('.SNL_Doc', 'config.json'))) {
      injectedCommitFailure = false;
      throw new Error('injected transaction commit failure');
    }
    return originalWriteFile(uri, data);
  };
  workspace.fs.delete = async (uri, options) => {
    if (uri.fsPath.includes(nodePath.join('.SNL_Doc', 'macros')) &&
        uri.fsPath.includes('rollback_target-')) {
      throw new Error('injected rollback failure');
    }
    return originalDeleteFile(uri, options);
  };
  let rollbackFailureResult;
  try {
    rollbackFailureResult = await batchPackageAsNew(
      root, 'test_pkg', ['Add.add.infix'], 'rollback_target', 'Rollback Target'
    );
  } finally {
    workspace.fs.writeFile = originalWriteFile;
    workspace.fs.delete = originalDeleteFile;
  }
  assert(
    rollbackFailureResult.status === 'error' && /rollback was incomplete|inconsistent/i.test(rollbackFailureResult.message),
    'batch transaction surfaces guarded rollback failure and inconsistent-state warning'
  );
  const rollbackResidue = (await fs.readdir(nodePath.join(tmpRoot, '.SNL_Doc', 'macros')))
    .find((name) => name.startsWith('rollback_target-') && name.endsWith('.json'));
  assert(!!rollbackResidue, 'injected rollback failure leaves the expected guarded residue');
  await fs.writeFile(
    nodePath.join(tmpRoot, '.SNL_Doc', 'macros', rollbackResidue),
    '{ malformed macro entity'
  );
  let malformedMacroSurfaced = false;
  try {
    await readAllMacros(root);
  } catch (error) {
    malformedMacroSurfaced = /Macro|JSON|entity/i.test(error instanceof Error ? error.message : String(error));
  }
  assert(malformedMacroSurfaced,
    'readAllMacros surfaces malformed per-entity Macro storage instead of returning an empty collection');

  // Cleanup.
  await fs.rm(tmpRoot, { recursive: true, force: true });

  console.log('\n[21] SNL-Basics does not ship a Macro database');
  const basicsPackage = JSON.parse(
    await fs.readFile(
      nodePath.resolve(process.cwd(), 'node_modules/@sjtu-ai4math/snl-basics/package.json'),
      'utf8'
    )
  );
  assert(
    basicsPackage.exports?.['./snl-macro-db.json'] === undefined,
    'SNL-Basics has no ./snl-macro-db.json package export'
  );
  await fs.access(
    nodePath.resolve(process.cwd(), 'node_modules/@sjtu-ai4math/snl-basics/dist-lib/snl-macro-db.json')
  ).then(
    () => assert(false, 'SNL-Basics tarball must not contain dist-lib/snl-macro-db.json'),
    () => assert(true, 'SNL-Basics tarball contains no bundled Macro DB')
  );

  console.log('\n[22] v5/v6 package input auto-migrates to strict v9 on read');
  // A fresh temp workspace so we can drop a v5-shape file straight to disk
  // and confirm readMacroPackage rewrites it in memory to v9. This is the
  // "Edit panel should map old data to new schema" story (猫猫 req).
  const tmpRoot2 = nodePath.join(os.tmpdir(), `snl-smoke-v5-${Date.now()}`);
  await fs.mkdir(nodePath.join(tmpRoot2, '.SNL_Doc', 'term_macros'), {
    recursive: true
  });
  const root2 = { fsPath: tmpRoot2, path: tmpRoot2, scheme: 'file' };
  // Two macros written in v5 shape:
  //   - Add.add: fixed arity, formula + display=inline (should → formula_inline)
  //   - Rel.matrix: variadic arity, formula + display=block (should → formula_display)
  const v5Pkg = {
    version: '1',
    name: 'v5-test',
    macros: {
      'Add.add': {
        description: 'legacy v5 add',
        source: { entries: [], urls: [] },
        arity: 'fixed',
        styles: [
          { tag: 'infix', mode: 'formula', display: 'inline', template: '#0 + #1' }
        ]
      },
      'Rel.matrix': {
        description: 'legacy v5 matrix (display)',
        source: { entries: [], urls: [] },
        arity: 'variadic',
        styles: [
          {
            tag: 'default',
            mode: 'formula',
            display: 'block',
            template: '\\begin{pmatrix}#*\\end{pmatrix}',
            variadic_join: ' \\\\ '
          }
        ]
      }
    }
  };
  const v5PkgUri = {
    fsPath: nodePath.join(
      tmpRoot2,
      '.SNL_Doc',
      'term_macros',
      'v5_test.json'
    )
  };
  await fs.writeFile(v5PkgUri.fsPath, JSON.stringify(v5Pkg, null, 2));

  const readV5 = await readMacroPackage(root2, 'v5_test');
  assert(readV5.status === 'ok', 'readMacroPackage v5-shape -> ok');
  assert(readV5.macros.length === 2, 'v5 pkg has 2 macros after migration');
  const migAdd = readV5.macros.find((m) => m.name === 'Add.add');
  const migMatrix = readV5.macros.find((m) => m.name === 'Rel.matrix');
  assert(!!migAdd && !!migMatrix, 'both v5 macros visible after migration');
  assert(
    migAdd.dynamic_arity === false && !('arity' in migAdd),
    'v5→v9: arity=fixed → dynamic_arity=false, arity removed'
  );
  assert(
    migMatrix.dynamic_arity === true && !('arity' in migMatrix),
    'v5→v9: arity=variadic → dynamic_arity=true'
  );
  assert(
    migAdd.styles[0].template.mode === 'formula_inline' &&
      !('display' in migAdd.styles[0]),
    'v5→v9: formula+display=inline → formula_inline, display axis removed'
  );
  assert(
    migMatrix.styles[0].template.mode === 'formula_display' &&
      !('display' in migMatrix.styles[0]),
    'v5→v9: formula+display=block → formula_display, display axis removed'
  );
  assert(
    migMatrix.styles[0].template.separator === ' \\\\ ' &&
      migMatrix.styles[0].template.body === '#*',
    'v5→v9: variadic_join becomes separator and legacy dynamic fields compose #*'
  );
  assert(
    !('default_style' in migAdd) && !('default_style' in migMatrix),
    'v5→v9 uses styles[0] as the sole implicit default'
  );
  assert(readV5.pkg.version === '11', 'readMacroPackage exposes canonical package version 11');

  // Regression: Dashboard's per-package macroCount used to always report 1
  // for v6 packages because inferMacroCount only recognized v5's array shape
  // and then fell through to a keys-minus-metadata count where {version,
  // name, description, macros} minus {version,name,description} = ['macros']
  // → 1. Verify both v5 and v6 shapes now report the right count via
  // readMacroPackages (which is what Dashboard consumes).
  console.log('\n[23] readMacroPackages reports accurate macroCount');
  // v6 shape: write a fresh package with 3 macros into the same tmp root2.
  const v6Pkg = {
    version: '6',
    name: 'v6-count',
    description: 'v6 shape count test',
    macros: {
      a: {
        description: '', source: { entries: [], urls: [] }, dynamic_arity: true,
        tags: ['macro-tag'], extension_data: { keep: true },
        styles: [{
          tag: 'default', mode: 'block', template: 'ignored',
          variadic_left: '[', variadic_join: '', variadic_right: ']',
          react_renderer_key: 'list', tags: ['style-tag'],
          typst: { built_in: 'legacy', synthesis: { mode: 'formula', macro: '#0' } },
          extension_style_data: 42
        }]
      },
      b: { description: '', source: { entries: [], urls: [] }, dynamic_arity: false, styles: [{ tag: 'default', mode: 'formula_inline', template: 'b' }] },
      c: { description: '', source: { entries: [], urls: [] }, dynamic_arity: false, styles: [{ tag: 'default', mode: 'formula_inline', template: 'c' }] }
    }
  };
  const tmpRoot3 = nodePath.join(os.tmpdir(), `snl-smoke-count-${Date.now()}`);
  await fs.mkdir(nodePath.join(tmpRoot3, '.SNL_Doc', 'term_macros'), {
    recursive: true
  });
  const root3 = { fsPath: tmpRoot3, path: tmpRoot3, scheme: 'file' };
  await fs.writeFile(
    nodePath.join(tmpRoot3, '.SNL_Doc', 'config.json'),
    JSON.stringify({ version: '0.0.3', entry_kinds: [], macro_kinds: [] }, null, 2)
  );
  await fs.writeFile(
    nodePath.join(tmpRoot3, '.SNL_Doc', 'term_macros', 'v6_count.json'),
    JSON.stringify(v6Pkg, null, 2)
  );
  // v5 shape alongside — historically was counted correctly (via the
  // Array.isArray branch), but re-assert to lock it in.
  await fs.writeFile(
    nodePath.join(tmpRoot3, '.SNL_Doc', 'term_macros', 'v5_count.json'),
    JSON.stringify({ version: '1', name: 'v5-count', macros: [{ name: 'x' }, { name: 'y' }] }, null, 2)
  );
  const summaries = await readMacroPackages(root3);
  const summaryByFile = Object.fromEntries(summaries.map((s) => [s.file, s]));
  assert(
    summaryByFile['v6_count.json']?.macroCount === 3,
    `v6 macroCount should be 3, got ${summaryByFile['v6_count.json']?.macroCount}`
  );
  assert(
    summaryByFile['v5_count.json']?.macroCount === 2,
    `v5 macroCount should be 2, got ${summaryByFile['v5_count.json']?.macroCount}`
  );
  const readV6 = await readMacroPackage(root3, 'v6_count');
  assert(readV6.status === 'ok', 'explicit v6 package input reads successfully');
  const migratedV6 = readV6.macros.find((macro) => macro.name === 'a');
  assert(
    migratedV6.styles[0].style_name === 'default' &&
      migratedV6.styles[0].template.body === '[#*]' &&
      migratedV6.styles[0].template.separator === '' &&
      migratedV6.styles[0].template.block_template_name === 'list',
    'v6→v11 maps style/dynamic/block fields and preserves empty separator'
  );
  assert(
    migratedV6.extension_data.keep === true &&
      !('extension_style_data' in migratedV6.styles[0]) &&
      migratedV6.styles[0].template.extension_style_data === 42 &&
      migratedV6.styles[0].template.typst.built_in === 'legacy',
    'v6→v11 moves style extensions and output backends into the template projection'
  );
  const rewriteV7 = await updateMacro(root3, 'v6_count', migratedV6, entityRevision(migratedV6));
  assert(
    rewriteV7.status === 'error' && /requires migration/i.test(rewriteV7.message),
    'predecessor Macro update is blocked until workspace migration'
  );
  const unchangedV6 = JSON.parse(await fs.readFile(
    nodePath.join(tmpRoot3, '.SNL_Doc', 'term_macros', 'v6_count.json'), 'utf8'
  ));
  assert(unchangedV6.version === '6', 'blocked predecessor update leaves the package byte-semantically unchanged');
  await fs.rm(tmpRoot3, { recursive: true, force: true });
  await fs.rm(tmpRoot2, { recursive: true, force: true });

  // --- [24] libraryGraph v2: kind-driven numbering + DFS reading order ----
  console.log('\n[24] libraryGraph v2 numbering engine');
  const graphMod = await import(
    pathToFileURL(nodePath.resolve(process.cwd(), 'out', 'libraryGraph.js')).href
  );
  const { formatNumbering, numberFor, readingOrder } = graphMod;

  // §5 magic-string formatter (unchanged from v1 semantics)
  assert(formatNumbering('1', 3) === '3', 'formatNumbering("1", 3) → "3"');
  assert(formatNumbering('.1', 3) === '.3', 'formatNumbering(".1", 3) → ".3"');
  assert(formatNumbering('A', 3) === 'C', 'formatNumbering("A", 3) → "C"');
  assert(formatNumbering('A', 27) === 'AA', 'formatNumbering("A", 27) → "AA"');
  assert(formatNumbering('a', 3) === 'c', 'formatNumbering("a", 3) → "c"');
  assert(formatNumbering('I', 4) === 'IV', 'formatNumbering("I", 4) → "IV"');
  assert(formatNumbering('i', 9) === 'ix', 'formatNumbering("i", 9) → "ix"');
  assert(formatNumbering('(1)', 12) === '(12)', 'formatNumbering("(1)", 12) → "(12)"');
  assert(formatNumbering('Ex. A.', 2) === 'Ex. B.', 'formatNumbering("Ex. A.", 2) → "Ex. B."');
  assert(formatNumbering('§I.', 4) === '§IV.', 'formatNumbering("§I.", 4) → "§IV."');
  assert(formatNumbering('Foo', 3) === 'Foo', 'formatNumbering("Foo", 3) → "Foo" (no slot)');
  assert(formatNumbering('1.1', 3) === '3.1', 'formatNumbering("1.1", 3) → "3.1" (second slot literal)');

  // §6 numberFor — cat's 1.3B.5 example, 2026-07-16 counter-tree shape.
  // Kinds now name a Library-scoped counter (defaultCounterName) instead of
  // carrying a numbering DSL; the counter tree supplies the DSL by name.
  //
  //   chapter kind → counter 'chapter' numbering '1'
  //   section kind → counter 'section' numbering '.1'
  //   theorem kind → counter 'theorem' numbering 'A'
  //   remark  kind → counter 'remark'  numbering '.1'
  const counters1 = [
    { id: 'c-chapter', name: 'chapter', numbering: '1', children: [
      { id: 'c-section', name: 'section', numbering: '.1', children: [
        { id: 'c-theorem', name: 'theorem', numbering: 'A', children: [
          { id: 'c-remark', name: 'remark', numbering: '.1', children: [] }
        ] }
      ] }
    ] }
  ];
  const kindsById = new Map([
    ['chapter', { defaultCounterName: 'chapter' }],
    ['section', { defaultCounterName: 'section' }],
    ['theorem', { defaultCounterName: 'theorem' }],
    ['remark', { defaultCounterName: 'remark' }]
  ]);
  const entriesById = new Map([
    ['uuid-chap1', { kind: 'chapter' }],
    ['uuid-1_1', { kind: 'section' }],
    ['uuid-1_2', { kind: 'section' }],
    ['uuid-1_3', { kind: 'section' }],
    ['uuid-1_3_A', { kind: 'theorem' }],
    ['uuid-1_3_B', { kind: 'theorem' }],
    ['uuid-1_3_B_1', { kind: 'remark' }],
    ['uuid-1_3_B_2', { kind: 'remark' }],
    ['uuid-1_3_B_3', { kind: 'remark' }],
    ['uuid-1_3_B_4', { kind: 'remark' }],
    ['uuid-1_3_B_5', { kind: 'remark' }]
  ]);
  const graph1 = {
    nodes: [
      { id: 'chap1', label: 'Entry', props: { entryId: 'uuid-chap1' } },
      { id: 's1_1', label: 'Entry', props: { entryId: 'uuid-1_1' } },
      { id: 's1_2', label: 'Entry', props: { entryId: 'uuid-1_2' } },
      { id: 's1_3', label: 'Entry', props: { entryId: 'uuid-1_3' } },
      { id: 't_A', label: 'Entry', props: { entryId: 'uuid-1_3_A' } },
      { id: 't_B', label: 'Entry', props: { entryId: 'uuid-1_3_B' } },
      { id: 'r_1', label: 'Entry', props: { entryId: 'uuid-1_3_B_1' } },
      { id: 'r_2', label: 'Entry', props: { entryId: 'uuid-1_3_B_2' } },
      { id: 'r_3', label: 'Entry', props: { entryId: 'uuid-1_3_B_3' } },
      { id: 'r_4', label: 'Entry', props: { entryId: 'uuid-1_3_B_4' } },
      { id: 'r_5', label: 'Entry', props: { entryId: 'uuid-1_3_B_5' } }
    ],
    relationships: [
      { from: 'chap1', to: 's1_1', label: 'branch' },
      { from: 'chap1', to: 's1_2', label: 'branch' },
      { from: 'chap1', to: 's1_3', label: 'branch' },
      { from: 's1_3', to: 't_A', label: 'branch' },
      { from: 's1_3', to: 't_B', label: 'branch' },
      { from: 't_B', to: 'r_1', label: 'branch' },
      { from: 't_B', to: 'r_2', label: 'branch' },
      { from: 't_B', to: 'r_3', label: 'branch' },
      { from: 't_B', to: 'r_4', label: 'branch' },
      { from: 't_B', to: 'r_5', label: 'branch' }
    ]
  };

  // The full cat example.
  const n_r_5 = numberFor(graph1, 'r_5', entriesById, kindsById, counters1);
  assert(n_r_5 === '1.3B.5', `numberFor(r_5) → "1.3B.5" (got ${JSON.stringify(n_r_5)})`);
  // Intermediate numbers per spec §6.
  assert(numberFor(graph1, 'chap1', entriesById, kindsById, counters1) === '1', 'numberFor(chap1) → "1"');
  assert(numberFor(graph1, 's1_3', entriesById, kindsById, counters1) === '1.3', 'numberFor(s1_3) → "1.3"');
  assert(numberFor(graph1, 't_B', entriesById, kindsById, counters1) === '1.3B', 'numberFor(t_B) → "1.3B"');
  assert(numberFor(graph1, 't_A', entriesById, kindsById, counters1) === '1.3A', 'numberFor(t_A) → "1.3A"');
  assert(numberFor(graph1, 'r_1', entriesById, kindsById, counters1) === '1.3B.1', 'numberFor(r_1) → "1.3B.1"');
  // Missing node → null.
  assert(numberFor(graph1, 'nope', entriesById, kindsById, counters1) === null, 'numberFor(missing) → null');

  // Linear Counter invariant: changing s1_1 to theorem leaves section
  // uninitialized at that point. The later s1_2 and s1_3 entries advance the
  // section Counter to 1 and 2, independently of their Entry-tree siblinghood.
  const entriesTweak = new Map(entriesById);
  entriesTweak.set('uuid-1_1', { kind: 'theorem' });
  assert(
    numberFor(graph1, 's1_3', entriesTweak, kindsById, counters1) === '1.2',
    'different Counter is excluded from the section sequence (s1_3 → "1.2")'
  );

  // An unresolved Entry is likewise excluded from the linear section sequence.
  const entriesGap = new Map(entriesById);
  entriesGap.delete('uuid-1_1');
  assert(
    numberFor(graph1, 's1_3', entriesGap, kindsById, counters1) === '1.2',
    'unresolved sibling is excluded from this counter sequence (s1_3 → "1.2")'
  );
  // If the target's own kind resolves to no counter → numberFor returns null.
  const kindsMissing = new Map(kindsById);
  kindsMissing.delete('section');
  assert(
    numberFor(graph1, 's1_3', entriesById, kindsMissing, counters1) === null,
    'target that resolves to no counter → numberFor returns null'
  );
  // No counters at all → every node is unnumbered.
  assert(
    numberFor(graph1, 'r_5', entriesById, kindsById, []) === null,
    'empty counter tree → numberFor returns null (no counter resolves)'
  );

  // §4 reading order = DFS of branch in declaration order.
  const order = readingOrder(graph1);
  const expectedOrder = ['chap1', 's1_1', 's1_2', 's1_3', 't_A', 't_B', 'r_1', 'r_2', 'r_3', 'r_4', 'r_5'];
  assert(
    JSON.stringify(order) === JSON.stringify(expectedOrder),
    `readingOrder DFS → ${JSON.stringify(expectedOrder)} (got ${JSON.stringify(order)})`
  );

  // Multiple roots → root-declaration order + DFS each.
  const graph2 = {
    nodes: [
      { id: 'A', label: 'Entry', props: { entryId: 'x1' } },
      { id: 'B', label: 'Entry', props: { entryId: 'x2' } },
      { id: 'A1', label: 'Entry', props: { entryId: 'x3' } },
      { id: 'B1', label: 'Entry', props: { entryId: 'x4' } }
    ],
    relationships: [
      { from: 'A', to: 'A1', label: 'branch' },
      { from: 'B', to: 'B1', label: 'branch' }
    ]
  };
  assert(
    JSON.stringify(readingOrder(graph2)) === JSON.stringify(['A', 'A1', 'B', 'B1']),
    'readingOrder handles multiple roots (declaration order + DFS each)'
  );

  // Root-level numbering: two chapter roots → '1' and '2'.
  const entriesById2 = new Map([
    ['x1', { kind: 'chapter' }],
    ['x2', { kind: 'chapter' }],
    ['x3', { kind: 'section' }],
    ['x4', { kind: 'section' }]
  ]);
  assert(numberFor(graph2, 'A', entriesById2, kindsById, counters1) === '1', 'root A → "1"');
  assert(numberFor(graph2, 'B', entriesById2, kindsById, counters1) === '2', 'root B → "2"');
  assert(numberFor(graph2, 'A1', entriesById2, kindsById, counters1) === '1.1', 'A1 → "1.1"');

  // Empty graph & orphan corner cases.
  assert(
    JSON.stringify(readingOrder({ nodes: [], relationships: [] })) === '[]',
    'readingOrder(empty) → []'
  );
  assert(
    numberFor({ nodes: [], relationships: [] }, 'anything', entriesById, kindsById, counters1) === null,
    'numberFor(empty, anything) → null'
  );
  const orphanGraph = {
    nodes: [{ id: 'e1', label: 'Entry', props: { entryId: 'uuid-chap1' } }],
    relationships: []
  };
  // Lone Entry node with no siblings is itself a root — root position 1,
  // chapter counter → numbering '1' → returns "1".
  assert(
    numberFor(orphanGraph, 'e1', entriesById, kindsById, counters1) === '1',
    'lone root entry → "1" (numbered by its resolved counter at root level)'
  );

  // --- [24b] per-entry counterId override (2026-07-16) --------------------
  console.log('\n[24b] per-entry counterId override + name lookup');
  // Spec Commit 3 scenario: counter 'theorem' numbering '1.' + kind Theorem
  // with defaultCounterName 'theorem' + one entry → numberFor === '1.'.
  const countersOverride = [
    { id: 'ct-theorem', name: 'theorem', numbering: '1.', children: [] },
    { id: 'ct-roman', name: 'section', numbering: '§I', children: [] }
  ];
  const kindsOverride = new Map([['Theorem', { defaultCounterName: 'theorem' }]]);
  const entriesOverride = new Map([['e-thm', { kind: 'Theorem' }]]);
  const graphOverride = {
    nodes: [{ id: 'n-thm', label: 'Entry', props: { entryId: 'e-thm' } }],
    relationships: []
  };
  assert(
    numberFor(graphOverride, 'n-thm', entriesOverride, kindsOverride, countersOverride) === '1.',
    'name lookup: defaultCounterName "theorem" → counter numbering "1." → "1."'
  );
  // Now pin an explicit counterId to a different counter (§I) — override wins.
  const graphOverride2 = {
    nodes: [{ id: 'n-thm', label: 'Entry', props: { entryId: 'e-thm', counterId: 'ct-roman' } }],
    relationships: []
  };
  assert(
    numberFor(graphOverride2, 'n-thm', entriesOverride, kindsOverride, countersOverride) === '§I',
    'explicit counterId override → counter numbering "§I" → "§I"'
  );
  // Dangling counterId (not in the tree) → falls back to name lookup.
  const graphOverride3 = {
    nodes: [{ id: 'n-thm', label: 'Entry', props: { entryId: 'e-thm', counterId: 'does-not-exist' } }],
    relationships: []
  };
  assert(
    numberFor(graphOverride3, 'n-thm', entriesOverride, kindsOverride, countersOverride) === '1.',
    'dangling counterId → treated as unset → falls back to name lookup ("1.")'
  );

  // --- [25] readLibraryGraph / writeLibraryGraph host API ------------------
  console.log('\n[25] library graph host API (createLibrary → graph.json)');
  // Fresh workspace: init + create a library, verify graph.json exists at
  // the expected path.
  const tmpRoot4 = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-graph-'));
  const root4 = Uri.file(tmpRoot4);
  const init4 = await initSnlDoc(root4);
  assert(init4.status === 'created', 'initSnlDoc -> created (graph test root)');
  const mkLib = await createLibrary(root4, 'graphtest', 'Graph Test');
  assert(mkLib.status === 'created', 'createLibrary -> created');
  const graphPath = nodePath.join(
    tmpRoot4,
    '.SNL_Doc',
    'libraries',
    'graphtest',
    'graph.json'
  );
  const graphRaw = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  assert(
    Array.isArray(graphRaw.nodes) && graphRaw.nodes.length === 0,
    'createLibrary writes graph.json with empty nodes'
  );
  assert(
    Array.isArray(graphRaw.relationships) && graphRaw.relationships.length === 0,
    'createLibrary writes graph.json with empty relationships (not "edges")'
  );
  // 2026-07-16: createLibrary also seeds an empty counters.json.
  const countersPath = nodePath.join(
    tmpRoot4,
    '.SNL_Doc',
    'libraries',
    'graphtest',
    'counters.json'
  );
  const countersRaw = JSON.parse(await fs.readFile(countersPath, 'utf8'));
  assert(
    Array.isArray(countersRaw.counters) && countersRaw.counters.length === 0,
    'createLibrary writes counters.json with { counters: [] }'
  );
  const freshCounters = await readLibraryCounters(root4, 'graphtest');
  assert(
    Array.isArray(freshCounters) && freshCounters.length === 0,
    'readLibraryCounters on a fresh library returns []'
  );
  const missingCounters = await readLibraryCounters(root4, 'nonexistent-slug');
  assert(
    Array.isArray(missingCounters) && missingCounters.length === 0,
    'readLibraryCounters on a missing library returns [] (tolerant)'
  );
  // Old relationships.json must NOT exist.
  const oldPath = nodePath.join(
    tmpRoot4,
    '.SNL_Doc',
    'libraries',
    'graphtest',
    'relationships.json'
  );
  let oldExists = true;
  try {
    await fs.access(oldPath);
  } catch {
    oldExists = false;
  }
  assert(!oldExists, 'legacy relationships.json is NOT created');

  // writeLibraryGraph round-trip with valid v2 shape.
  const write1 = await writeLibraryGraph(root4, 'graphtest', {
    nodes: [
      { id: 'root', label: 'Entry', props: { entryId: 'some-uuid' } },
      { id: 'child', label: 'Entry', props: { entryId: 'other-uuid' } }
    ],
    relationships: [{ from: 'root', to: 'child', label: 'branch' }]
  });
  assert(write1.status === 'ok', 'writeLibraryGraph -> ok');
  const read1 = await readLibraryGraph(root4, 'graphtest');
  assert(read1.status === 'ok', 'readLibraryGraph -> ok after write');
  assert(
    read1.result.graph.nodes.length === 2 &&
      read1.result.graph.relationships.length === 1,
    'round-trip preserves 2 nodes + 1 rel'
  );
  // Warnings are non-empty because entryIds don't resolve — no shared-pool
  // entries in this workspace yet. But no LABEL warnings.
  assert(
    !read1.result.warnings.some((w) => w.includes('is not an object') || w.includes('is missing string')),
    'no structural warnings on well-formed v2 graph'
  );
  const graphWithExtensions = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  graphWithExtensions.wrapper_extension = { keep: true };
  graphWithExtensions.nodes[0].node_extension = { keep: true };
  graphWithExtensions.relationships[0].relationship_extension = { keep: true };
  await fs.writeFile(graphPath, JSON.stringify(graphWithExtensions));
  const rawMutation = await mutateLibraryGraph(root4, 'graphtest', ({ nodes }) => {
    nodes[0] = { ...nodes[0], props: { ...nodes[0].props, edited: true } };
    return true;
  });
  assert(rawMutation.status === 'ok' && rawMutation.changed,
    'writer-locked raw graph mutation completes on a real file workspace');
  const graphAfterRawMutation = JSON.parse(await fs.readFile(graphPath, 'utf8'));
  assert(
    graphAfterRawMutation.wrapper_extension?.keep === true &&
      graphAfterRawMutation.nodes[0].node_extension?.keep === true &&
      graphAfterRawMutation.relationships[0].relationship_extension?.keep === true &&
      graphAfterRawMutation.nodes[0].props.edited === true,
    'raw graph mutation preserves wrapper/node/relationship extensions'
  );

  // Legacy v1 shape (Counter / Section / count relationships) surfaces
  // v2-migration warnings but doesn't fail the read.
  const writeLegacy = await writeLibraryGraph(root4, 'graphtest', {
    nodes: [
      { id: 'c', label: 'Counter', props: { numbering: '1' } },
      { id: 's', label: 'Section', props: { name: 'Chapter' } }
    ],
    relationships: [{ from: 'c', to: 's', label: 'count' }]
  });
  assert(writeLegacy.status === 'ok', 'writeLibraryGraph accepts legacy shape too');
  const readLegacyGraph = await readLibraryGraph(root4, 'graphtest');
  assert(readLegacyGraph.status === 'ok', 'readLibraryGraph -> ok on legacy shape');
  assert(
    readLegacyGraph.result.warnings.some((w) => w.includes('Counter') && w.includes('only "Entry" is supported')),
    'legacy Counter label surfaces v2-migration warning'
  );
  assert(
    readLegacyGraph.result.warnings.some((w) => w.includes('count') && w.includes('only "branch" is supported')),
    'legacy count relationship surfaces v2-migration warning'
  );

  // Dangling entryId → warning (spec §8).
  const write2 = await writeLibraryGraph(root4, 'graphtest', {
    nodes: [
      { id: 'e1', label: 'Entry', props: { entryId: 'does-not-exist' } }
    ],
    relationships: []
  });
  assert(write2.status === 'ok', 'writeLibraryGraph with dangling entryId -> ok');
  const read2 = await readLibraryGraph(root4, 'graphtest');
  assert(read2.status === 'ok', 'readLibraryGraph returns ok even with dangling entryId');
  // Note: knownEntryIds may be empty (this workspace has no entries yet), in
  // which case the read side skips validation. Write an entry then re-read
  // to actually exercise the dangling-warning path.
  const entryKindsInit = await applyEntryKindsPreset(root4, 'fulcrum-math-notes');
  assert(entryKindsInit.status === 'applied', 'applyEntryKindsPreset -> applied (root4)');
  const addProbe = await addEntry(root4, {
    id: 'real-entry',
    kind: 'definition',
    title: 'Real Entry',
    tags: [],
    content: { snl: '' }
  });
  assert(addProbe.status === 'ok', 'addEntry -> ok (real entry for dangling test)');
  const read3 = await readLibraryGraph(root4, 'graphtest');
  assert(read3.status === 'ok', 'readLibraryGraph -> ok after adding a real entry');
  assert(
    read3.result.warnings.some((w) => w.includes('does-not-exist')),
    `dangling entryId surfaces as warning (got ${JSON.stringify(read3.result.warnings)})`
  );

  // Stub-path (2026-07-16): the outline Add form's dual-action inserts a node
  // referencing an id that isn't in the pool yet (isStub). At the data layer
  // that's simply a graph node whose entryId dangles — it must PERSIST (not be
  // rejected) and read back as a real node carrying a dangling-id warning, so
  // the ⚠ pending tag can render until the entry lands. Emulate the host's
  // isStub addNode by writing the node directly and re-reading.
  const writeStub = await writeLibraryGraph(root4, 'graphtest', {
    nodes: [
      { id: 'real-node', label: 'Entry', props: { entryId: 'real-entry' } },
      { id: 'stub-node', label: 'Entry', props: { entryId: 'not-in-pool' } }
    ],
    relationships: [{ from: 'real-node', to: 'stub-node', label: 'branch' }]
  });
  assert(writeStub.status === 'ok', 'stub node persists via writeLibraryGraph -> ok');
  const readStub = await readLibraryGraph(root4, 'graphtest');
  assert(readStub.status === 'ok', 'readLibraryGraph -> ok with a stub node present');
  assert(
    readStub.result.graph.nodes.some((n) => n.id === 'stub-node'),
    'stub node round-trips into the graph (not dropped)'
  );
  assert(
    readStub.result.warnings.some((w) => w.includes('not-in-pool')),
    `stub node's dangling entryId surfaces as a warning (got ${JSON.stringify(readStub.result.warnings)})`
  );

  // No graph.json in a non-existent library slug -> noFile.
  const read4 = await readLibraryGraph(root4, 'nonexistent-slug');
  assert(read4.status === 'noFile', 'readLibraryGraph on missing lib -> noFile');

  await fs.rm(tmpRoot4, { recursive: true, force: true });

  // --- [26] filesystem is source of truth for libraries -------------------
  console.log('\n[26] libraries decoupled from config (fs is source of truth)');
  const tmpRoot5 = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-libs-'));
  const root5 = Uri.file(tmpRoot5);
  const init5 = await initSnlDoc(root5);
  assert(init5.status === 'created', 'initSnlDoc -> created (libs test root)');

  // After init, listLibraries returns empty.
  const libs0 = await listLibraries(root5);
  assert(libs0.length === 0, `fresh workspace -> [] libraries (got ${libs0.length})`);

  // Also, init's config.json must NOT carry a libraries field.
  const configPath5 = nodePath.join(tmpRoot5, '.SNL_Doc', 'config.json');
  const cfg5 = JSON.parse(await fs.readFile(configPath5, 'utf8'));
  assert(
    !('libraries' in cfg5),
    `init writes config without a libraries field (got keys: ${JSON.stringify(Object.keys(cfg5))})`
  );

  // createLibrary → shows up in listLibraries with meta.json title.
  const mk5 = await createLibrary(root5, 'My First Library');
  assert(mk5.status === 'created', 'createLibrary -> created');
  const cfg5After = JSON.parse(await fs.readFile(configPath5, 'utf8'));
  assert(
    !('libraries' in cfg5After),
    'createLibrary did NOT write config.libraries (fs is source of truth)'
  );
  const libs1 = await listLibraries(root5);
  assert(libs1.length === 1, `after create, listLibraries -> 1 (got ${libs1.length})`);
  assert(libs1[0].slug === 'My_First_Library', `slug slugified (got "${libs1[0].slug}")`);
  assert(libs1[0].title === 'My First Library', `title from meta.json (got "${libs1[0].title}")`);
  assert(libs1[0].hasMeta === true, 'hasMeta true after createLibrary');

  // Bug cat reported: delete the folder → library disappears (config was
  // sticky before).
  await fs.rm(
    nodePath.join(tmpRoot5, '.SNL_Doc', 'libraries', 'My_First_Library'),
    { recursive: true, force: true }
  );
  const libs2 = await listLibraries(root5);
  assert(
    libs2.length === 0,
    `deleting library folder makes it disappear (got ${libs2.length})`
  );

  // Import-by-paste: mkdir a new library folder externally with a meta.json
  // and NO createLibrary call — listLibraries picks it up.
  const pastedDir = nodePath.join(tmpRoot5, '.SNL_Doc', 'libraries', 'pasted-lib');
  await fs.mkdir(pastedDir, { recursive: true });
  await fs.writeFile(
    nodePath.join(pastedDir, 'meta.json'),
    JSON.stringify({ title: 'Pasted Library', description: 'imported from elsewhere' }, null, 2)
  );
  await fs.writeFile(
    nodePath.join(pastedDir, 'graph.json'),
    JSON.stringify({ nodes: [], relationships: [] }, null, 2)
  );
  const libs3 = await listLibraries(root5);
  assert(libs3.length === 1, `pasted folder auto-discovered (got ${libs3.length})`);
  assert(libs3[0].slug === 'pasted-lib', `pasted slug (got "${libs3[0].slug}")`);
  assert(libs3[0].title === 'Pasted Library', `pasted title from its meta.json (got "${libs3[0].title}")`);
  assert(libs3[0].description === 'imported from elsewhere', 'description round-trips through listLibraries');

  // Folder without meta.json → still discovered, title falls back to slug.
  await fs.mkdir(nodePath.join(tmpRoot5, '.SNL_Doc', 'libraries', 'nometa'), { recursive: true });
  const libs4 = await listLibraries(root5);
  const noMetaEntry = libs4.find((l) => l.slug === 'nometa');
  assert(noMetaEntry !== undefined, 'meta-less folder is still discovered');
  assert(noMetaEntry.title === 'nometa', 'meta-less folder title falls back to slug');
  assert(noMetaEntry.hasMeta === false, 'hasMeta false when meta.json missing');

  // updateLibrary edits meta.json in place.
  const pastedBeforeUpdate = await readLibraryMeta(root5, 'pasted-lib');
  assert(pastedBeforeUpdate.status === 'ok', 'Library fixture loads with a revision');
  const upd = await updateLibrary(root5, 'pasted-lib', {
    title: 'Renamed Library',
    description: 'renamed via updateLibrary'
  }, entityRevision(pastedBeforeUpdate.meta));
  assert(upd.status === 'updated', 'updateLibrary -> updated');
  const readMeta = await readLibraryMeta(root5, 'pasted-lib');
  assert(readMeta.status === 'ok', 'readLibraryMeta -> ok');
  assert(readMeta.meta.title === 'Renamed Library', 'title changed on disk');
  assert(readMeta.meta.description === 'renamed via updateLibrary', 'description changed on disk');
  const staleLibraryRevision = entityRevision(readMeta.meta);
  assert((await updateLibrary(root5, 'pasted-lib', { title: 'Newer Library' }, staleLibraryRevision)).status === 'updated',
    'concurrent Library metadata edit fixture succeeds');
  assert((await updateLibrary(root5, 'pasted-lib', { title: 'Stale Library' }, staleLibraryRevision)).status === 'conflict',
    'stale Library editor revision is rejected');
  const pastedMetaPath = nodePath.join(tmpRoot5, '.SNL_Doc', 'libraries', 'pasted-lib', 'meta.json');
  const validPastedMeta = await fs.readFile(pastedMetaPath, 'utf8');
  await fs.writeFile(pastedMetaPath, '{ malformed');
  let malformedLibraryRejected = false;
  try { await updateLibrary(root5, 'pasted-lib', { title: 'Must Not Save' }); }
  catch { malformedLibraryRejected = true; }
  assert(malformedLibraryRejected, 'Library edit refuses malformed meta.json instead of replacing it');
  assert(await fs.readFile(pastedMetaPath, 'utf8') === '{ malformed',
    'malformed Library metadata remains byte-preserving');
  await fs.writeFile(pastedMetaPath, validPastedMeta);
  // And config.json is STILL clean.
  const cfg5Final = JSON.parse(await fs.readFile(configPath5, 'utf8'));
  assert(
    !('libraries' in cfg5Final),
    'updateLibrary did NOT write config.libraries either'
  );

  // updateLibrary on missing library slug -> notFound.
  const badUpd = await updateLibrary(root5, 'does-not-exist', { title: 'x' });
  assert(badUpd.status === 'notFound', 'updateLibrary on missing slug -> notFound');

  // writeLibraryMeta directly.
  const wMeta = await writeLibraryMeta(root5, 'nometa', { title: 'Now Has Title' });
  assert(wMeta.status === 'ok', 'writeLibraryMeta -> ok');
  const libs5 = await listLibraries(root5);
  const nowMeta = libs5.find((l) => l.slug === 'nometa');
  assert(nowMeta.hasMeta === true, 'after writeLibraryMeta, hasMeta is true');
  assert(nowMeta.title === 'Now Has Title', 'after writeLibraryMeta, title reflects it');

  // Legacy config with a stale `libraries` field is IGNORED by listLibraries.
  const cfgWithStale = { ...cfg5Final, libraries: [{ slug: 'ghost', title: 'ghost lib' }] };
  await fs.writeFile(configPath5, JSON.stringify(cfgWithStale, null, 2));
  const libs6 = await listLibraries(root5);
  assert(
    !libs6.some((l) => l.slug === 'ghost'),
    'stale config.libraries entry is ignored (fs is source of truth)'
  );

  // readOverview also sees only fs-discovered libraries.
  const ov = await readOverview(root5);
  assert(
    ov.libraries.length === libs6.length,
    `readOverview library count matches listLibraries (${ov.libraries.length} vs ${libs6.length})`
  );
  assert(
    !ov.libraries.some((l) => l.slug === 'ghost'),
    'readOverview also ignores stale config.libraries'
  );

  await fs.rm(tmpRoot5, { recursive: true, force: true });

  // --- [27] Entry v2: title / content are optional -----------------------
  console.log('\n[27] entry title and content are optional (cat 2026-07-06)');
  const tmpRoot6 = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-entryopt-'));
  const root6 = Uri.file(tmpRoot6);
  await initSnlDoc(root6);
  await applyEntryKindsPreset(root6, 'fulcrum-math-notes');

  // No title, no content — just kind + id.
  const addNoTitle = await addEntry(root6, {
    id: 'placeholder',
    kind: 'definition',
    title: '',
    content: {}
  });
  assert(addNoTitle.status === 'ok', 'addEntry with empty title -> ok');

  // No content object at all.
  const addNoContent = await addEntry(root6, {
    id: 'placeholder2',
    kind: 'section',
    title: 'Just a section title'
    // no `content` field
  });
  assert(addNoContent.status === 'ok', 'addEntry with no content field -> ok');

  // Verify both entries persisted correctly.
  const persisted = await readEntriesApi(root6);
  const p1 = persisted.find((e) => e.id === 'placeholder');
  const p2 = persisted.find((e) => e.id === 'placeholder2');
  assert(p1 && p1.title === '', 'empty title round-trips as ""');
  assert(p1 && !p1.content.snl, 'empty content stays empty');
  assert(p2 && p2.title === 'Just a section title', 'section-style entry (title-only) persists');

  await fs.rm(tmpRoot6, { recursive: true, force: true });

  // --- [28] Corrupt Entry pool must never be overwritten ------------------
  console.log('\n[28] addEntry refuses to overwrite a corrupt pool');
  const tmpRoot7 = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-entry-corrupt-'));
  const root7 = Uri.file(tmpRoot7);
  await initSnlDoc(root7);
  await applyEntryKindsPreset(root7, 'fulcrum-math-notes');
  const seed = await addEntry(root7, {
    id: 'seed', kind: 'definition', title: 'Seed', content: {}
  });
  assert(seed.status === 'ok', 'seed Entry created before corrupt-envelope test');
  const entityDir = nodePath.join(tmpRoot7, '.SNL_Doc', 'entries');
  const entityFile = (await fs.readdir(entityDir)).find((name) => name.endsWith('.json'));
  const corruptPath = nodePath.join(entityDir, entityFile);
  const corruptBytes = '{ this is not valid JSON';
  await fs.writeFile(corruptPath, corruptBytes);
  const corruptWrite = await addEntry(root7, {
    id: 'must-not-write',
    kind: 'definition',
    title: 'Should fail',
    content: {}
  });
  assert(corruptWrite.status === 'error', 'addEntry rejects a corrupt current topology');
  assert(
    (await fs.readFile(corruptPath, 'utf8')) === corruptBytes,
    'addEntry leaves the corrupt Entry envelope byte-for-byte untouched'
  );
  await fs.rm(tmpRoot7, { recursive: true, force: true });

  // --- [29] Future workspace schemas are read-only -------------------------
  console.log('\n[29] ordinary writes refuse future workspace data versions');
  const tmpRoot8 = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-future-version-'));
  const root8 = Uri.file(tmpRoot8);
  await initSnlDoc(root8);
  await applyEntryKindsPreset(root8, 'fulcrum-math-notes');
  const futureConfigPath = nodePath.join(tmpRoot8, '.SNL_Doc', 'config.json');
  const futureEntriesDir = nodePath.join(tmpRoot8, '.SNL_Doc', 'entries');
  const futureConfig = JSON.parse(await fs.readFile(futureConfigPath, 'utf8'));
  futureConfig.version = '9.0.0';
  await fs.writeFile(futureConfigPath, JSON.stringify(futureConfig, null, 2));
  const entriesBeforeFutureWrite = await Promise.all(
    (await fs.readdir(futureEntriesDir)).sort().map(async (name) => [name, await fs.readFile(nodePath.join(futureEntriesDir, name), 'utf8')])
  );
  const futureWrite = await addEntry(root8, {
    id: 'must-not-downgrade', kind: 'definition', title: 'Blocked', content: {}
  });
  assert(futureWrite.status === 'error', 'addEntry rejects a future workspace version');
  const futureUnknownKindWrite = await addEntry(root8, {
    id: 'must-not-downgrade-unknown-kind', kind: 'not-a-kind', title: 'Blocked', content: {}
  });
  assert(futureUnknownKindWrite.status === 'error',
    'future workspace validation precedes Entry kind business validation');
  const entriesAfterFutureWrite = await Promise.all(
    (await fs.readdir(futureEntriesDir)).sort().map(async (name) => [name, await fs.readFile(nodePath.join(futureEntriesDir, name), 'utf8')])
  );
  assert(
    JSON.stringify(entriesAfterFutureWrite) === JSON.stringify(entriesBeforeFutureWrite),
    'future-version write leaves per-entity Entry storage untouched'
  );
  await fs.rm(tmpRoot8, { recursive: true, force: true });

  // --- [30] Current topology metadata gates ordinary writes -----------------
  console.log('\n[30] ordinary writes refuse invalid current topology receipts');
  const tmpRoot9 = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-invalid-topology-'));
  const root9 = Uri.file(tmpRoot9);
  await initSnlDoc(root9);
  await applyEntryKindsPreset(root9, 'fulcrum-math-notes');
  const topologyConfigPath = nodePath.join(tmpRoot9, '.SNL_Doc', 'config.json');
  const topologyConfig = JSON.parse(await fs.readFile(topologyConfigPath, 'utf8'));
  const validTopologyConfig = JSON.parse(JSON.stringify(topologyConfig));
  delete topologyConfig.entity_storage.receipt;
  await fs.writeFile(topologyConfigPath, JSON.stringify(topologyConfig, null, 2));
  const topologyWrite = await addEntry(root9, {
    id: 'must-not-write', kind: 'definition', title: 'Blocked', content: {}
  });
  assert(topologyWrite.status === 'error', 'addEntry rejects missing current-topology receipt');
  const topologyUnknownKindWrite = await addEntry(root9, {
    id: 'must-not-write-unknown-topology', kind: 'not-a-kind', title: 'Blocked', content: {}
  });
  assert(topologyUnknownKindWrite.status === 'error',
    'invalid current topology validation precedes unknown kind');
  assert((await fs.readdir(nodePath.join(tmpRoot9, '.SNL_Doc', 'entries')))
    .filter((name) => name.endsWith('.json')).length === 0,
    'invalid current topology remains byte-preserving and unwritten');
  const badCatalogConfig = JSON.parse(JSON.stringify(validTopologyConfig));
  badCatalogConfig.entry_kinds = {};
  await fs.writeFile(topologyConfigPath, JSON.stringify(badCatalogConfig, null, 2));
  const badCatalogUnknownKindWrite = await addEntry(root9, {
    id: 'must-not-write-bad-catalog', kind: 'not-a-kind', title: 'Blocked', content: {}
  });
  assert(badCatalogUnknownKindWrite.status === 'error',
    'malformed Entry kind catalog validation precedes unknown kind');
  await fs.writeFile(topologyConfigPath, '{ malformed config');
  const malformedUnknownKindWrite = await addEntry(root9, {
    id: 'must-not-write-unknown-kind', kind: 'not-a-kind', title: 'Blocked', content: {}
  });
  assert(malformedUnknownKindWrite.status === 'error',
    'malformed config validation precedes Entry kind business validation');
  let malformedConfigSurfaced = false;
  try { await readOverview(root9); }
  catch { malformedConfigSurfaced = true; }
  assert(malformedConfigSurfaced,
    'Dashboard read surfaces malformed current config instead of falling back to frozen backups');
  await fs.rm(tmpRoot9, { recursive: true, force: true });

  // --- [31] Legacy Package wrapper extensions survive edits -----------------
  console.log('\n[31] legacy Package wrapper extensions survive metadata edits');
  const tmpRoot10 = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-legacy-wrapper-'));
  const root10 = Uri.file(tmpRoot10);
  const legacyDataDir = nodePath.join(tmpRoot10, '.SNL_Doc');
  await fs.mkdir(nodePath.join(legacyDataDir, 'term_macros'), { recursive: true });
  await fs.writeFile(nodePath.join(legacyDataDir, 'config.json'), JSON.stringify({
    version: '0.0.4',
    entry_kinds: [{ id: 'definition', label: 'Definition' }],
    macro_kinds: [],
    active_macro_packages: ['legacy.ext']
  }));
  await fs.writeFile(nodePath.join(legacyDataDir, 'entries.json'), JSON.stringify([
    { id: 'legacy-entry', kind: 'definition', title: 'Before', content: {} }
  ]));
  const legacyWrapperPath = nodePath.join(legacyDataDir, 'term_macros', 'legacy.ext.json');
  const legacyWrapperFixture = {
    version: '7', name: 'Legacy', description: 'before', vendor_extension: { keep: true },
    macros: {
      'Legacy.macro': {
        source: { entries: [], urls: [], vendor_source: { keep: true } },
        styles: []
      }
    }
  };
  Object.defineProperty(legacyWrapperFixture, '__proto__', {
    value: { keep: 'prototype-sensitive-wrapper-extension' },
    enumerable: true,
    configurable: true,
    writable: true
  });
  await fs.writeFile(legacyWrapperPath, JSON.stringify(legacyWrapperFixture));
  const legacyConfigPath = nodePath.join(legacyDataDir, 'config.json');
  const legacyConfigValid = await fs.readFile(legacyConfigPath, 'utf8');
  await fs.writeFile(legacyConfigPath, JSON.stringify({
    ...JSON.parse(legacyConfigValid), active_macro_packages: [' legacy.ext ']
  }));
  const invalidActiveEdit = await createMacroPackage(root10, 'must-not-save', 'Must Not Save');
  assert(invalidActiveEdit.status === 'error',
    'legacy mutation rejects noncanonical active Package IDs instead of garbage-collecting them');
  assert(JSON.parse(await fs.readFile(legacyWrapperPath, 'utf8')).name === 'Legacy',
    'invalid legacy active config leaves Package bytes unchanged');
  await fs.writeFile(legacyConfigPath, legacyConfigValid);
  const malformedKindsConfig = JSON.stringify({
    ...JSON.parse(legacyConfigValid), entry_kinds: { vendor: true }
  });
  await fs.writeFile(legacyConfigPath, malformedKindsConfig);
  let malformedKindsRejected = false;
  try {
    const result = await createEntryKind(root10, {
      id: 'must-not-save', name: 'Must Not Save', coloring: themedColoring('#000', '#fff'),
      defaultCounterName: '', style: ''
    });
    malformedKindsRejected = result.status === 'error';
  } catch { malformedKindsRejected = true; }
  assert(malformedKindsRejected, 'legacy mutation rejects malformed present entry_kinds');
  assert(await fs.readFile(legacyConfigPath, 'utf8') === malformedKindsConfig,
    'malformed entry_kinds remains byte-preserving');
  const malformedManagedKindConfig = JSON.stringify({
    ...JSON.parse(legacyConfigValid),
    entry_kinds: [{ id: 'definition', name: 7, coloring: { stroke: 42, background: '#fff' } }]
  });
  await fs.writeFile(legacyConfigPath, malformedManagedKindConfig);
  let malformedManagedKindRejected = false;
  try { await readEntryKinds(root10); } catch { malformedManagedKindRejected = true; }
  assert(malformedManagedKindRejected, 'malformed managed Kind fields are rejected before normalization');
  assert(await fs.readFile(legacyConfigPath, 'utf8') === malformedManagedKindConfig,
    'malformed managed Kind fields remain byte-preserving');
  await fs.writeFile(legacyConfigPath, legacyConfigValid);
  const legacyPackageBeforeUpdate = await readMacroPackage(root10, 'legacy.ext');
  assert(legacyPackageBeforeUpdate.status === 'ok', 'legacy Package fixture loads with a revision');
  assert(
    legacyPackageBeforeUpdate.status === 'ok' &&
      Object.prototype.hasOwnProperty.call(legacyPackageBeforeUpdate.pkg, '__proto__') &&
      legacyPackageBeforeUpdate.pkg.__proto__?.keep === 'prototype-sensitive-wrapper-extension' &&
      JSON.parse(JSON.stringify(legacyPackageBeforeUpdate.pkg)).__proto__?.keep ===
        'prototype-sensitive-wrapper-extension',
    'prototype-sensitive Package wrapper extension survives read and serialization'
  );
  const legacyUpdated = await updateMacroPackage(root10, 'legacy.ext', {
    name: 'Legacy Updated', description: 'after'
  }, macroPackageMetadataRevision(legacyPackageBeforeUpdate.raw));
  assert(
    legacyUpdated.status === 'error' && /requires migration/i.test(legacyUpdated.message),
    'predecessor Package metadata update is blocked until migration'
  );
  const legacyWrapperAfter = JSON.parse(await fs.readFile(legacyWrapperPath, 'utf8'));
  assert(legacyWrapperAfter.name === 'Legacy' && legacyWrapperAfter.vendor_extension?.keep === true,
    'blocked predecessor Package update preserves the complete wrapper');
  assert(legacyWrapperAfter.macros?.['Legacy.macro']?.source?.vendor_source?.keep === true,
    'blocked predecessor Package update preserves nested Macro extensions');
  const legacyEntriesBefore = await fs.readFile(nodePath.join(legacyDataDir, 'entries.json'), 'utf8');
  const legacyEntryCreated = await addEntry(root10, {
    id: 'legacy-created', kind: 'definition', title: 'Created', content: {}
  });
  assert(
    legacyEntryCreated.status === 'error' && /requires migration/i.test(legacyEntryCreated.message),
    'predecessor Entry create is blocked until migration'
  );
  const legacyEntryBeforeUpdate = (await readEntriesApi(root10)).find((item) => item.id === 'legacy-entry');
  const legacyEntryUpdated = await updateEntry(root10, 'legacy-entry', {
    id: 'legacy-entry', kind: 'definition', title: 'After', content: {}
  }, entityRevision(legacyEntryBeforeUpdate));
  assert(
    legacyEntryUpdated.status === 'error' && /requires migration/i.test(legacyEntryUpdated.message),
    'predecessor Entry update is blocked until migration'
  );
  assert(await fs.readFile(nodePath.join(legacyDataDir, 'entries.json'), 'utf8') === legacyEntriesBefore,
    'blocked predecessor Entry writes preserve the frozen aggregate backup');
  const relationshipCreated = await addRelationship(root10, {
    id: 'legacy-rel', from: 'legacy-entry', to: 'legacy-entry', label: 'depends', metadata: null
  });
  assert(
    relationshipCreated.status === 'error' && /requires migration/i.test(relationshipCreated.message),
    'predecessor Relationship create is blocked until migration'
  );
  const predecessorLibrary = await createLibrary(root10, 'Predecessor Library');
  assert(predecessorLibrary.status === 'created',
    'predecessor Library creation remains allowed outside frozen migration sources');
  const predecessorLibraryDelete = await deleteLibrary(root10, predecessorLibrary.slug);
  assert(predecessorLibraryDelete.status === 'ok',
    'predecessor Library deletion remains allowed outside frozen migration sources');
  for (const unsafeSlug of ['.', '..', '../outside', 'nested/path', 'nested\\path']) {
    const unsafeDelete = await deleteLibrary(root10, unsafeSlug);
    assert(unsafeDelete.status === 'invalid',
      `Library deletion rejects unsafe path segment ${JSON.stringify(unsafeSlug)}`);
  }
  await fs.stat(nodePath.join(root10.fsPath, '.SNL_Doc', 'config.json'));
  assert(true, 'unsafe Library deletion leaves the workspace root intact');
  const unsafeGraphWrite = await writeLibraryGraph(root10, '../../target', {
    nodes: [], relationships: []
  });
  assert(unsafeGraphWrite.status === 'error',
    'Library graph writer rejects a traversal slug through the shared path gate');
  let escapedGraphExists = true;
  try {
    await fs.stat(nodePath.join(root10.fsPath, 'target', 'graph.json'));
  } catch (error) {
    escapedGraphExists = error?.code !== 'ENOENT';
  }
  assert(!escapedGraphExists, 'unsafe Library graph write creates nothing outside libraries');
  const missingLibraryGraphWrite = await writeLibraryGraph(root10, 'Missing_Library', {
    nodes: [], relationships: []
  });
  assert(missingLibraryGraphWrite.status === 'error',
    'Library graph writer requires an existing direct-child Library directory');
  let missingLibraryCreated = true;
  try {
    await fs.stat(nodePath.join(root10.fsPath, '.SNL_Doc', 'libraries', 'Missing_Library'));
  } catch (error) {
    missingLibraryCreated = error?.code !== 'ENOENT';
  }
  assert(!missingLibraryCreated, 'Library writer never synthesizes an incomplete Library');

  const preflightTmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-library-preflight-'));
  const preflightRoot = Uri.file(preflightTmp);
  assert((await initSnlDoc(preflightRoot)).status === 'created',
    'Library preflight fixture workspace is initialized');
  const preflightData = nodePath.join(preflightTmp, '.SNL_Doc');
  const preflightLibraries = nodePath.join(preflightData, 'libraries');
  await fs.rm(preflightLibraries, { recursive: true, force: true });
  const preflightConfigPath = nodePath.join(preflightData, 'config.json');
  const preflightConfig = JSON.parse(await fs.readFile(preflightConfigPath, 'utf8'));
  preflightConfig.version = '99.0.0';
  await fs.writeFile(preflightConfigPath, JSON.stringify(preflightConfig));
  let preflightRejected = false;
  try {
    const result = await createLibrary(preflightRoot, 'Must Not Materialize');
    preflightRejected = result.status !== 'created';
  } catch { preflightRejected = true; }
  assert(preflightRejected, 'future workspace rejects Library creation');
  let preflightLibrariesExist = true;
  try { await fs.stat(preflightLibraries); } catch (error) {
    preflightLibrariesExist = error?.code !== 'ENOENT';
  }
  assert(!preflightLibrariesExist,
    'Library creation validates workspace before materializing a missing libraries root');

  const revalidateTmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-library-revalidate-'));
  const revalidateRoot = Uri.file(revalidateTmp);
  assert((await initSnlDoc(revalidateRoot)).status === 'created',
    'Library publication revalidation fixture is initialized');
  const revalidateConfigPath = nodePath.join(revalidateTmp, '.SNL_Doc', 'config.json');
  let invalidatedDuringStaging = false;
  beforeWriteHook = async (uri) => {
    if (!invalidatedDuringStaging &&
        uri.fsPath.includes(`${nodePath.sep}.creating-Revalidate_Library-`) &&
        uri.fsPath.endsWith(`${nodePath.sep}.gitkeep`)) {
      invalidatedDuringStaging = true;
      const config = JSON.parse(await fs.readFile(revalidateConfigPath, 'utf8'));
      config.version = '99.0.0';
      await fs.writeFile(revalidateConfigPath, JSON.stringify(config));
    }
  };
  let revalidationRejected = false;
  try {
    const result = await createLibrary(revalidateRoot, 'Revalidate Library');
    revalidationRejected = result.status !== 'created';
  } catch { revalidationRejected = true; }
  beforeWriteHook = null;
  assert(invalidatedDuringStaging, 'Library publication revalidation seam is exercised');
  assert(revalidationRejected, 'Library publication revalidates workspace after staging writes');
  const revalidateLibraries = await fs.readdir(
    nodePath.join(revalidateTmp, '.SNL_Doc', 'libraries')
  );
  assert(!revalidateLibraries.includes('Revalidate_Library'),
    'failed publication revalidation does not publish the staged Library');
  assert(!revalidateLibraries.some((name) => name.startsWith('.creating-Revalidate_Library-')),
    'failed publication revalidation removes its private staging directory');

  const librariesRootPath = nodePath.join(root10.fsPath, '.SNL_Doc', 'libraries');
  const symlinkOutside = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-library-symlink-'));
  const childOutside = nodePath.join(symlinkOutside, 'child-target');
  await fs.mkdir(childOutside);
  const childLink = nodePath.join(librariesRootPath, 'Child_Link');
  await fs.symlink(childOutside, childLink, 'dir');
  const childLinkWrite = await writeLibraryGraph(root10, 'Child_Link', {
    nodes: [], relationships: []
  });
  assert(childLinkWrite.status === 'error', 'Library writer rejects a symlinked direct-child Library');
  let childEscaped = true;
  try { await fs.stat(nodePath.join(childOutside, 'graph.json')); } catch (error) {
    childEscaped = error?.code !== 'ENOENT';
  }
  assert(!childEscaped, 'child Library symlink cannot redirect graph writes outside the workspace');
  await fs.unlink(childLink);

  const heldLibrariesRoot = nodePath.join(root10.fsPath, '.SNL_Doc', 'libraries-real');
  const outsideLibrariesRoot = nodePath.join(symlinkOutside, 'root-target');
  await fs.mkdir(nodePath.join(outsideLibrariesRoot, 'Root_Link'), { recursive: true });
  await fs.rename(librariesRootPath, heldLibrariesRoot);
  await fs.symlink(outsideLibrariesRoot, librariesRootPath, 'dir');
  const rootLinkWrite = await writeLibraryGraph(root10, 'Root_Link', {
    nodes: [], relationships: []
  });
  assert(rootLinkWrite.status === 'error', 'Library writer rejects a symlinked libraries root');
  let rootEscaped = true;
  try { await fs.stat(nodePath.join(outsideLibrariesRoot, 'Root_Link', 'graph.json')); } catch (error) {
    rootEscaped = error?.code !== 'ENOENT';
  }
  assert(!rootEscaped, 'libraries-root symlink cannot redirect graph writes outside the workspace');
  await fs.unlink(librariesRootPath);
  await fs.rename(heldLibrariesRoot, librariesRootPath);

  const targetLinkLibrary = await createLibrary(root10, 'Target Link Library');
  assert(targetLinkLibrary.status === 'created', 'target-file symlink fixture Library is created');
  const targetLinkGraph = nodePath.join(
    librariesRootPath, targetLinkLibrary.slug, 'graph.json'
  );
  const outsideGraph = nodePath.join(symlinkOutside, 'outside-graph.json');
  const outsideGraphContents = JSON.stringify({ nodes: [], relationships: [] });
  await fs.writeFile(outsideGraph, outsideGraphContents);
  await fs.unlink(targetLinkGraph);
  await fs.symlink(outsideGraph, targetLinkGraph, 'file');
  let symlinkMutationCallbackRan = false;
  const targetLinkMutation = await mutateLibraryGraph(
    root10,
    targetLinkLibrary.slug,
    () => {
      symlinkMutationCallbackRan = true;
      return true;
    }
  );
  assert(targetLinkMutation.status === 'error',
    'Library graph mutation rejects a symlink before reading it');
  assert(!symlinkMutationCallbackRan,
    'Library graph mutation rejects a symlink before invoking its callback');
  const targetLinkWrite = await writeLibraryGraph(root10, targetLinkLibrary.slug, {
    nodes: [], relationships: []
  });
  assert(targetLinkWrite.status === 'error', 'Library writer rejects a symlinked graph target');
  assert(await fs.readFile(outsideGraph, 'utf8') === outsideGraphContents,
    'target-file symlink cannot overwrite an external graph');
  await fs.unlink(targetLinkGraph);
  await fs.writeFile(targetLinkGraph, JSON.stringify({ nodes: [], relationships: [] }));
  assert((await deleteLibrary(root10, targetLinkLibrary.slug)).status === 'ok',
    'target-file symlink fixture Library cleans up');

  let injectedLibraryFailure = false;
  beforeWriteHook = async (uri) => {
    if (uri.fsPath.includes(`${nodePath.sep}.creating-Retry_Library-`) &&
        uri.fsPath.endsWith(nodePath.join('', 'counters.json'))) {
      injectedLibraryFailure = true;
      throw new Error('injected Library payload failure');
    }
  };
  let failedLibraryCreate = false;
  try {
    await createLibrary(root10, 'Retry Library');
  } catch {
    failedLibraryCreate = true;
  } finally {
    beforeWriteHook = null;
  }
  assert(injectedLibraryFailure && failedLibraryCreate,
    'injected Library payload failure is surfaced');
  let partialLibraryExists = true;
  try {
    await fs.stat(nodePath.join(root10.fsPath, '.SNL_Doc', 'libraries', 'Retry_Library'));
  } catch (error) {
    partialLibraryExists = error?.code !== 'ENOENT';
  }
  assert(!partialLibraryExists, 'failed Library creation rolls back its entire directory');
  const librariesPath = nodePath.join(root10.fsPath, '.SNL_Doc', 'libraries');
  assert(
    !(await fs.readdir(librariesPath)).some((name) => name.startsWith('.creating-Retry_Library-')),
    'failed Library creation leaves no private staging directory'
  );

  const collisionTarget = nodePath.join(librariesPath, 'Collision_Library');
  let collisionInjected = false;
  beforeWriteHook = async (uri) => {
    if (!collisionInjected &&
        uri.fsPath.includes(`${nodePath.sep}.creating-Collision_Library-`) &&
        uri.fsPath.endsWith(nodePath.join('Markdown', '.gitkeep'))) {
      collisionInjected = true;
      await fs.mkdir(collisionTarget, { recursive: true });
      await fs.writeFile(nodePath.join(collisionTarget, 'foreign.txt'), 'foreign');
    }
  };
  let collisionCreateFailed = false;
  try {
    await createLibrary(root10, 'Collision Library');
  } catch {
    collisionCreateFailed = true;
  } finally {
    beforeWriteHook = null;
  }
  assert(collisionInjected && collisionCreateFailed,
    'atomic no-replace publish rejects a target that appears during Library creation');
  assert(await fs.readFile(nodePath.join(collisionTarget, 'foreign.txt'), 'utf8') === 'foreign',
    'failed Library publish never deletes or overwrites a foreign target directory');
  assert(
    !(await fs.readdir(librariesPath)).some((name) => name.startsWith('.creating-Collision_Library-')),
    'collision cleanup removes only the private staging directory'
  );
  await fs.rm(collisionTarget, { recursive: true, force: true });

  const retriedLibrary = await createLibrary(root10, 'Retry Library');
  assert(retriedLibrary.status === 'created', 'failed Library creation can be retried safely');
  assert((await deleteLibrary(root10, retriedLibrary.slug)).status === 'ok',
    'retried Library cleanup succeeds');

  const deleteActivePackage = await deleteMacroPackage(root10, 'legacy.ext');
  assert(
    deleteActivePackage.status === 'error' && /requires migration/i.test(deleteActivePackage.message),
    'predecessor active Package deletion reports failure when config cannot be updated'
  );
  assert(JSON.parse(await fs.readFile(legacyWrapperPath, 'utf8')).name === 'Legacy',
    'failed predecessor Package deletion leaves the active package file intact');
  const relationshipsPath = nodePath.join(tmpRoot10, '.SNL_Doc', 'relationships.json');
  for (const [payload, label] of [
    ['{not-json', 'malformed Relationship JSON is rejected'],
    [JSON.stringify({ version: 1 }), 'wrong Relationship wrapper shape is rejected'],
    [JSON.stringify({ version: 1, relationships: [{ id: 7, from: 'a', to: 'b', label: 'x' }] }),
      'invalid Relationship record is rejected']
  ]) {
    await fs.writeFile(relationshipsPath, payload);
    let rejected = false;
    try { await readRelationships(root10); } catch { rejected = true; }
    assert(rejected, label);
  }
  await fs.rm(tmpRoot10, { recursive: true, force: true });

  // --- [32] Initialization is config-last and retryable ---------------------
  console.log('\n[32] initialization is config-last and retryable');
  const tmpRoot11 = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-init-retry-'));
  const root11 = Uri.file(tmpRoot11);
  const originalInitWrite = workspace.fs.writeFile;
  let failInitPayload = true;
  workspace.fs.writeFile = async (uri, data) => {
    if (failInitPayload && uri.fsPath.includes(nodePath.join('.SNL_Doc', 'packages'))) {
      failInitPayload = false;
      throw new Error('injected init payload failure');
    }
    return originalInitWrite(uri, data);
  };
  let initFailed = false;
  try {
    await initSnlDoc(root11);
  } catch {
    initFailed = true;
  } finally {
    workspace.fs.writeFile = originalInitWrite;
  }
  assert(initFailed, 'injected initialization payload failure is surfaced');
  let configCreatedEarly = true;
  try { await fs.stat(nodePath.join(tmpRoot11, '.SNL_Doc', 'config.json')); }
  catch { configCreatedEarly = false; }
  assert(!configCreatedEarly, 'failed initialization does not commit config.json');
  assert((await initSnlDoc(root11)).status === 'created', 'partial initialization can be retried safely');
  assert((await readConfig(tmpRoot11)).version === '0.0.9', 'retry commits the current config last');
  await fs.rm(tmpRoot11, { recursive: true, force: true });

  console.log(`\nALL SMOKE ASSERTS PASSED (${passed} checks).`);
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err.message);
  process.exit(1);
});
