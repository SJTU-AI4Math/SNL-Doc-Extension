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

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
  }
  static file(p) {
    return new Uri(p);
  }
  static joinPath(base, ...segments) {
    return new Uri(nodePath.join(base.fsPath, ...segments));
  }
}

const workspace = {
  fs: {
    async stat(uri) {
      const s = await fs.stat(uri.fsPath);
      return {
        type: s.isDirectory() ? FileType.Directory : FileType.File,
        ctime: 0,
        mtime: 0,
        size: s.size
      };
    },
    async readFile(uri) {
      return new Uint8Array(await fs.readFile(uri.fsPath));
    },
    async writeFile(uri, data) {
      await fs.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
      await fs.writeFile(uri.fsPath, Buffer.from(data));
    },
    async createDirectory(uri) {
      await fs.mkdir(uri.fsPath, { recursive: true });
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

  const {
    initSnlDoc,
    applyEntryKindsPreset,
    createEntryKind,
    readMacroKinds,
    applyMacroKindsPreset,
    createMacroKind,
    addEntry,
    readEntries: readEntriesApi,
    readOverview,
    createMacroPackage,
    readMacroPackage,
    readMacroPackages,
    addMacro,
    updateMacro,
    readAllMacros,
    setActiveMacroPackages,
    createLibrary,
    updateLibrary,
    readLibraryGraph,
    writeLibraryGraph,
    readLibraryCounters,
    listLibraries,
    readLibraryMeta,
    writeLibraryMeta
  } = snlDoc;

  const tmpRoot = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'snl-smoke-'));
  const root = Uri.file(tmpRoot);
  console.log(`temp workspace: ${tmpRoot}`);

  console.log('\n[1] initSnlDoc');
  const init = await initSnlDoc(root);
  assert(init.status === 'created', 'initSnlDoc -> created');

  console.log('\n[2] applyEntryKindsPreset(fulcrum-math-notes)');
  const applied = await applyEntryKindsPreset(root, 'fulcrum-math-notes');
  assert(applied.status === 'applied', 'applyEntryKindsPreset -> applied');
  assert(applied.count === 16, `preset applied 16 kinds (got ${applied.count})`);

  const cfg = await readConfig(tmpRoot);
  assert(
    cfg.version === '0.0.3',
    `config.version === "0.0.3" (got ${cfg.version})`
  );
  assert(
    Array.isArray(cfg.entry_kinds) && cfg.entry_kinds.length === 16,
    `config has 16 entry_kinds (got ${cfg.entry_kinds?.length})`
  );
  const defn = cfg.entry_kinds.find((k) => k.id === 'definition');
  assert(!!defn, 'definition kind present');
  assert(
    defn.coloring &&
      defn.coloring.stroke === '#009C27' &&
      defn.coloring.background === '#D6FEE0',
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

  console.log('\n[3] addEntryKind (createEntryKind) fresh id');
  const created = await createEntryKind(root, {
    id: 'scratch-note',
    name: 'Scratch Note',
    stroke: '#123456',
    background: '#abcdef',
    defaultCounterName: 'scratch',
    style: ''
  });
  assert(created.status === 'created', 'createEntryKind -> created');
  const cfg2 = await readConfig(tmpRoot);
  assert(cfg2.entry_kinds.length === 17, 'entry_kinds now 17 after append');

  console.log('\n[4] addEntryKind duplicate id');
  const dupKind = await createEntryKind(root, {
    id: 'scratch-note',
    name: 'Scratch Note Again',
    stroke: '#000000',
    background: '#ffffff',
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
  const entries = await readEntries(tmpRoot);
  assert(
    entries.length === 1 && entries[0].id === entry.id,
    'entries.json has the appended entry'
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
    content: {},
    contribution_info: null,
    pointer: null
  });
  assert(noTitle.status === 'ok', 'addEntry with empty/whitespace title -> ok (v2)');

  console.log('\n[10] readEntries + readOverview.entries');
  const readBack = await readEntriesApi(root);
  // Two entries now: the one from [6] + the empty-title one from [9].
  assert(
    Array.isArray(readBack) && readBack.length === 2,
    `readEntries returns 2-element array (got ${readBack?.length})`
  );
  const firstEntry = readBack.find((e) => e.id === entry.id);
  assert(
    firstEntry &&
      firstEntry.kind === entry.kind &&
      firstEntry.title === entry.title,
    'readEntries record matches what was written'
  );
  const overview = await readOverview(root);
  assert(
    Array.isArray(overview.entries) &&
      overview.entries.length === 2 &&
      overview.entries.some((e) => e.id === entry.id),
    'readOverview.entries includes the entry with the same id'
  );

  console.log('\n[11] createMacroPackage(test_pkg)');
  const mkPkg = await createMacroPackage(root, 'test_pkg', 'Test Package', 'desc');
  assert(mkPkg.status === 'ok', 'createMacroPackage -> ok');
  assert(mkPkg.file === 'test_pkg.json', 'createMacroPackage file === test_pkg.json');

  console.log('\n[12] createMacroPackage duplicate');
  const dupPkg = await createMacroPackage(root, 'test_pkg', 'Test Package');
  assert(dupPkg.status === 'duplicate', 'createMacroPackage dup -> duplicate');

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
    readEmpty.pkg.name === 'Test Package' && readEmpty.pkg.version === '7',
    'readMacroPackage pkg metadata round-trips at canonical version 7'
  );

  const validMacro = {
    name: 'Add.add.infix',
    description: 'addition (infix)',
    source: { entries: [], urls: [] },
    dynamic_arity: false,
    tags: [],
    styles: [
      {
        style_name: 'infix',
        mode: 'formula_inline',
        template: '#0 + #1',
        tags: [],
        typst: { built_in: '', synthesis: { mode: 'formula', macro: '' } },
        latex: { built_in: '', synthesis: { mode: 'formula', macro: '' } },
        markdown: '',
        text: ''
      }
    ]
  };

  console.log('\n[15] addMacro valid');
  const addOkMacro = await addMacro(root, 'test_pkg', validMacro);
  assert(addOkMacro.status === 'ok', 'addMacro valid -> ok');
  assert(addOkMacro.name === 'Add.add.infix', 'addMacro returns name');

  console.log('\n[16] addMacro duplicate');
  const dupMacro = await addMacro(root, 'test_pkg', validMacro);
  assert(dupMacro.status === 'duplicate', 'addMacro dup -> duplicate');

  console.log('\n[17] addMacro empty template -> invalid');
  const badMacro = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'Bad.macro',
    styles: [{ style_name: 'default', mode: 'formula_inline', template: '   ', tags: [] }]
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
  // 2026-07-04-late 猫猫 naming rule: forbid @ # $ % whitespace ( ) [ ] { }.
  for (const badName of ['bad@name', 'bad#name', 'bad$name', 'bad%name', 'bad name', 'bad(name)', 'bad[name]', 'bad{name}']) {
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

  console.log('\n[17d] addMacro with duplicate style tags -> invalid');
  const dupTagMacro = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'DupTag.macro',
    styles: [
      { style_name: 'x', mode: 'formula_inline', template: '#0', tags: [] },
      { style_name: 'x', mode: 'text', template: '#0 (text)', tags: [] }
    ]
  });
  assert(dupTagMacro.status === 'invalid', 'addMacro duplicate tags -> invalid');

  console.log('\n[18] addMacro to missing package -> noFile');
  const noFileMacro = await addMacro(root, 'no_such_pkg', validMacro);
  assert(noFileMacro.status === 'noFile', 'addMacro missing pkg -> noFile');

  console.log('\n[19] readMacroPackage after add -> 1 macro');
  const readOne = await readMacroPackage(root, 'test_pkg.json');
  assert(readOne.status === 'ok', 'readMacroPackage (with .json) -> ok');
  assert(
    // Adjusted expected count: 1 initial (Add.add.infix) + 5 new allowed
    // (backslash, dotted, hyphen, greek, CJK) from [17c].
    readOne.macros.length === 6 && readOne.macros.some((m) => m.name === 'Add.add.infix'),
    'readMacroPackage returns the 6 appended macros (Add.add.infix + 5 unicode/backslash/hyphen/dotted names)'
  );

  console.log('\n[20] readMacroPackage missing -> noFile');
  const readMissing = await readMacroPackage(root, 'does_not_exist');
  assert(readMissing.status === 'noFile', 'readMacroPackage missing -> noFile');

  console.log('\n[20b] readMacroPackage normalizes a legacy-shape package on load');
  // Write an OLD-shape package straight to disk: two macros sharing a base name
  // (Mul.mul.infix + Mul.mul.implicit), each with katex_react.mode === 'math'
  // and typst/latex.synthesis.output_type (pre-0.4.0). readMacroPackage must
  // normalize them in-memory all the way to strict Macro v7: a single
  // `Mul.mul` macro with a styles array and canonical style_name/tags.
  const legacyPkgUri = Uri.joinPath(
    root,
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
  const readLegacy = await readMacroPackage(root, 'legacy_pkg');
  assert(readLegacy.status === 'ok', 'readMacroPackage legacy -> ok');
  const oldMacro = readLegacy.macros.find((m) => m.name === 'Mul.mul');
  assert(!!oldMacro, 'legacy macros grouped into base "Mul.mul"');
  assert(
    !('katex_react' in oldMacro),
    'katex_react dropped from normalized macro'
  );
  assert(oldMacro.dynamic_arity === false, 'v7: dynamic_arity=false (was arity=fixed)');
  assert(!('arity' in oldMacro), 'legacy arity field dropped in v7');
  assert(oldMacro.kind === 'const', 'kind lifted to top-level');
  assert(Array.isArray(oldMacro.styles), 'styles is a v7 array');
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
  assert(
    infixStyle.mode === 'formula_inline',
    "v7: per-style mode 'math'->'formula_inline' (no display=block on legacy)"
  );
  assert(!('display' in infixStyle), 'v6: display axis folded into mode');
  assert(
    infixStyle.template === '#0 \\cdot #1',
    'style template preserved'
  );
  assert(Array.isArray(oldMacro.tags) && oldMacro.tags.length === 0, 'v7 macro tags default to []');
  assert(oldMacro.styles.every((style) => Array.isArray(style.tags)), 'v7 style tags default to []');
  assert(
    infixStyle.typst.synthesis.mode === 'text' &&
      !('output_type' in infixStyle.typst.synthesis),
    'per-style typst.synthesis.output_type moved to .mode'
  );
  assert(
    infixStyle.latex.synthesis.mode === 'formula' &&
      !('output_type' in infixStyle.latex.synthesis),
    'per-style latex.synthesis.output_type moved to .mode'
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
    `snl-basics-defaults seeds 6 kinds (5 Lean-Expr + partial) (got ${mkApplied.count})`
  );
  const mkAfterPreset = await readMacroKinds(root);
  assert(mkAfterPreset.length === 6, 'readMacroKinds now 6 after preset');
  const ruleKind = mkAfterPreset.find((k) => k.id === 'rule');
  assert(!!ruleKind, 'rule macro kind present');
  assert(
    ruleKind.coloring.stroke === '#009C27' &&
      ruleKind.coloring.background === '#D6FEE0',
    'rule kind colors match DEFAULT_KIND_PALETTE (green)'
  );
  const partialKind = mkAfterPreset.find((k) => k.id === 'partial');
  assert(!!partialKind, 'partial macro kind present in preset');
  assert(
    partialKind.coloring.stroke === 'inherit' &&
      partialKind.coloring.background === 'transparent',
    'partial kind uses inherit / transparent (no visual frame)'
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
    coloring: { stroke: '#123456', background: '#abcdef' }
  });
  assert(mkCreated.status === 'created', 'createMacroKind -> created');
  const mkAfterCreate = await readMacroKinds(root);
  assert(mkAfterCreate.length === 7, 'readMacroKinds now 7 after create');
  const custom = mkAfterCreate.find((k) => k.id === 'custom');
  assert(
    !!custom &&
      custom.name === 'Custom' &&
      custom.description === 'A user-defined macro kind.' &&
      custom.coloring.stroke === '#123456' &&
      custom.coloring.background === '#abcdef',
    'created macro kind round-trips'
  );

  const mkDup = await createMacroKind(root, {
    id: 'rule',
    name: 'Dupe',
    description: '',
    coloring: { stroke: '#000000', background: '#ffffff' }
  });
  assert(mkDup.status === 'duplicate', 'createMacroKind dup id -> duplicate');

  const overviewMk = await readOverview(root);
  assert(
    Array.isArray(overviewMk.macroKinds) && overviewMk.macroKinds.length === 7,
    'readOverview surfaces 7 macroKinds (5 Lean-Expr + partial + custom)'
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
  // foo starts empty; give it one macro, then flip the active list to prove
  // readAllMacros gates purely on active-list membership.
  await addMacro(root, 'foo', { ...validMacro, name: 'Foo.only' });
  const allActive = await readAllMacros(root);
  assert(
    Object.prototype.hasOwnProperty.call(allActive, 'Foo.only'),
    'readAllMacros includes Foo.only while foo is active'
  );
  // Deactivate foo -> its macro disappears from readAllMacros.
  await setActiveMacroPackages(root, ['test_pkg']);
  const allFiltered = await readAllMacros(root);
  assert(
    !Object.prototype.hasOwnProperty.call(allFiltered, 'Foo.only'),
    'readAllMacros excludes Foo.only after foo removed from active list'
  );
  assert(
    Object.prototype.hasOwnProperty.call(allFiltered, 'Add.add.infix'),
    'readAllMacros still includes test_pkg macros (test_pkg active)'
  );

  // Cleanup.
  await fs.rm(tmpRoot, { recursive: true, force: true });

  console.log('\n[21] SNL-Basics submodule DB uses the v7 styles-array shape');
  const macroDb = JSON.parse(
    await fs.readFile(
      nodePath.resolve(
        process.cwd(),
        'node_modules/@snl-basics/react/dist-lib/snl-macro-db.json'
      ),
      'utf8'
    )
  );
  assert(macroDb['FOL.implies'], 'FOL.implies macro should exist');
  assert(
    Array.isArray(macroDb['FOL.implies'].styles),
    'FOL.implies styles is a v7 array'
  );
  assert(
    macroDb['FOL.implies'].dynamic_arity === false,
    'FOL.implies v7: dynamic_arity boolean present'
  );
  assert(
    macroDb['FOL.implies'].styles.some((s) => s.style_name === 'double'),
    'FOL.implies has a double (⇒) style'
  );
  assert(
    macroDb['FOL.implies'].styles[0].style_name === 'infix',
    'FOL.implies default (styles[0]) is infix'
  );
  assert(
    macroDb['FOL.implies'].styles[0].mode === 'formula_inline',
    'FOL.implies infix style v7: mode is formula_inline'
  );
  assert(
    !('display' in macroDb['FOL.implies'].styles[0]),
    'v7: display axis absent from bundled DB'
  );
  // The typed binders stay separate macros (different arity).
  assert(macroDb['FOL.forall.typed'], 'forall.typed macro should exist');
  assert(macroDb['FOL.exists.typed'], 'exists.typed macro should exist');
  // Ordinary arithmetic operators belong to downstream macro packages.
  for (const name of ['Add.add', 'Sub.sub', 'Mul.mul', 'DivRing.div']) {
    assert(!macroDb[name], `${name} should not be bundled`);
  }
  // Legacy top-level macro shape must be fully gone.
  assert(
    macroDb['FOL.implies'].mode === undefined &&
      macroDb['FOL.implies'].defaultStyle === undefined,
    'v5 macros drop top-level mode / defaultStyle'
  );
  // Old dotted-style macro names no longer exist as top-level entries.
  assert(!macroDb['DivRing.div.inlineDiv'], 'old DivRing.div.inlineDiv should not exist');
  assert(!macroDb['FOL.forall.binderTyped'], 'old forall.binderTyped should not exist');

  console.log('\n[22] v5/v6 package input auto-migrates to strict v7 on read');
  // A fresh temp workspace so we can drop a v5-shape file straight to disk
  // and confirm readMacroPackage rewrites it in memory to v7. This is the
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
    'v5→v7: arity=fixed → dynamic_arity=false, arity removed'
  );
  assert(
    migMatrix.dynamic_arity === true && !('arity' in migMatrix),
    'v5→v7: arity=variadic → dynamic_arity=true'
  );
  assert(
    migAdd.styles[0].mode === 'formula_inline' &&
      !('display' in migAdd.styles[0]),
    'v5→v7: formula+display=inline → formula_inline, display axis removed'
  );
  assert(
    migMatrix.styles[0].mode === 'formula_display' &&
      !('display' in migMatrix.styles[0]),
    'v5→v7: formula+display=block → formula_display, display axis removed'
  );
  assert(
    migMatrix.styles[0].separator === ' \\\\ ' &&
      migMatrix.styles[0].template === '#*',
    'v5→v7: variadic_join becomes separator and legacy dynamic fields compose #*'
  );
  assert(readV5.pkg.version === '7', 'readMacroPackage exposes canonical package version 7');

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
      migratedV6.styles[0].template === '[#*]' &&
      migratedV6.styles[0].separator === '' &&
      migratedV6.styles[0].block_template_name === 'list',
    'v6→v7 maps style/dynamic/block fields and preserves empty separator'
  );
  assert(
    migratedV6.extension_data.keep === true &&
      migratedV6.styles[0].extension_style_data === 42 &&
      migratedV6.styles[0].typst.built_in === 'legacy',
    'v6→v7 preserves macro/style extension fields and output backends'
  );
  const rewriteV7 = await updateMacro(root3, 'v6_count', migratedV6);
  assert(rewriteV7.status === 'updated', 'updating migrated macro writes strict v7');
  const writtenV7 = JSON.parse(await fs.readFile(
    nodePath.join(tmpRoot3, '.SNL_Doc', 'term_macros', 'v6_count.json'), 'utf8'
  ));
  const writtenStyle = writtenV7.macros.a.styles[0];
  assert(writtenV7.version === '7', 'all package writes stamp version 7');
  assert(
    writtenStyle.style_name === 'default' &&
      !('tag' in writtenStyle) && !('variadic_left' in writtenStyle) &&
      !('variadic_join' in writtenStyle) && !('variadic_right' in writtenStyle) &&
      !('react_renderer_key' in writtenStyle),
    'strict v7 writes contain no legacy runtime aliases'
  );
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
    { id: 'c-chapter', name: 'chapter', numbering: '1', children: [] },
    { id: 'c-section', name: 'section', numbering: '.1', children: [] },
    { id: 'c-theorem', name: 'theorem', numbering: 'A', children: [] },
    { id: 'c-remark', name: 'remark', numbering: '.1', children: [] }
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

  // Per-counter isolation invariant: changing s1_1 to the theorem counter
  // removes it from the section counter's sequence. s1_3 is now the second
  // section sibling (s1_2, s1_3), so its label becomes "1.2"; the theorem
  // sibling does not reshape the section template.
  const entriesTweak = new Map(entriesById);
  entriesTweak.set('uuid-1_1', { kind: 'theorem' });
  assert(
    numberFor(graph1, 's1_3', entriesTweak, kindsById, counters1) === '1.2',
    'different-counter sibling is excluded from this counter sequence (s1_3 → "1.2")'
  );

  // An unresolved sibling is likewise excluded from the section sequence;
  // s1_2 + s1_3 remain, making s1_3 the second section sibling.
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
  const upd = await updateLibrary(root5, 'pasted-lib', {
    title: 'Renamed Library',
    description: 'renamed via updateLibrary'
  });
  assert(upd.status === 'updated', 'updateLibrary -> updated');
  const readMeta = await readLibraryMeta(root5, 'pasted-lib');
  assert(readMeta.status === 'ok', 'readLibraryMeta -> ok');
  assert(readMeta.meta.title === 'Renamed Library', 'title changed on disk');
  assert(readMeta.meta.description === 'renamed via updateLibrary', 'description changed on disk');
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

  console.log(`\nALL SMOKE ASSERTS PASSED (${passed} checks).`);
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err.message);
  process.exit(1);
});
