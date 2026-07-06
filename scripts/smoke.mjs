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
    readAllMacros,
    setActiveMacroPackages,
    createLibrary,
    updateLibrary,
    readLibraryGraph,
    writeLibraryGraph,
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
  assert(applied.count === 12, `preset applied 12 kinds (got ${applied.count})`);

  const cfg = await readConfig(tmpRoot);
  assert(
    cfg.version === '0.0.3',
    `config.version === "0.0.3" (got ${cfg.version})`
  );
  assert(
    Array.isArray(cfg.entry_kinds) && cfg.entry_kinds.length === 12,
    `config has 12 entry_kinds (got ${cfg.entry_kinds?.length})`
  );
  const defn = cfg.entry_kinds.find((k) => k.id === 'definition');
  assert(!!defn, 'definition kind present');
  assert(
    defn.coloring &&
      defn.coloring.stroke === '#009C27' &&
      defn.coloring.background === '#D6FEE0',
    'definition coloring matches Fulcrum preset'
  );
  assert(defn.numbering === '1.1.1', 'definition numbering === "1.1.1"');

  console.log('\n[3] addEntryKind (createEntryKind) fresh id');
  const created = await createEntryKind(root, {
    id: 'scratch-note',
    name: 'Scratch Note',
    stroke: '#123456',
    background: '#abcdef',
    numbering: '1',
    style: ''
  });
  assert(created.status === 'created', 'createEntryKind -> created');
  const cfg2 = await readConfig(tmpRoot);
  assert(cfg2.entry_kinds.length === 13, 'entry_kinds now 13 after append');

  console.log('\n[4] addEntryKind duplicate id');
  const dupKind = await createEntryKind(root, {
    id: 'scratch-note',
    name: 'Scratch Note Again',
    stroke: '#000000',
    background: '#ffffff',
    numbering: '',
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

  console.log('\n[9] addEntry missing title');
  const noTitle = await addEntry(root, {
    id: 'a1b2c3d4-0000-4000-8000-000000000003',
    kind: 'definition',
    title: '   ',
    content: {},
    contribution_info: null,
    pointer: null
  });
  assert(noTitle.status === 'invalid', 'addEntry no title -> invalid');

  console.log('\n[10] readEntries + readOverview.entries');
  const readBack = await readEntriesApi(root);
  assert(
    Array.isArray(readBack) && readBack.length === 1,
    `readEntries returns 1-element array (got ${readBack?.length})`
  );
  assert(
    readBack[0].id === entry.id &&
      readBack[0].kind === entry.kind &&
      readBack[0].title === entry.title,
    'readEntries record matches what was written'
  );
  const overview = await readOverview(root);
  assert(
    Array.isArray(overview.entries) &&
      overview.entries.length === 1 &&
      overview.entries[0].id === entry.id,
    'readOverview.entries is a 1-element array with the same id'
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
    readEmpty.pkg.name === 'Test Package' && readEmpty.pkg.version === '1',
    'readMacroPackage pkg metadata round-trips'
  );

  const validMacro = {
    name: 'Add.add.infix',
    description: 'addition (infix)',
    source: { entries: [], urls: [] },
    dynamic_arity: false,
    styles: [
      {
        tag: 'infix',
        mode: 'formula_inline',
        template: '#0 + #1',
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
    styles: [{ tag: 'default', mode: 'formula_inline', template: '   ' }]
  });
  assert(badMacro.status === 'invalid', 'addMacro empty template -> invalid');

  console.log('\n[17b] addMacro with legacy per-style mode "math" -> invalid');
  const legacyModeMacro = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'Legacy.mode',
    styles: [{ tag: 'default', mode: 'math', template: '#0' }]
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

  console.log('\n[17c] addMacro missing style.tag -> invalid');
  const noTagMacro = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'NoTag.macro',
    styles: [{ mode: 'formula_inline', template: '#0' }]
  });
  assert(noTagMacro.status === 'invalid', 'addMacro missing style.tag -> invalid');

  console.log('\n[17d] addMacro with duplicate style tags -> invalid');
  const dupTagMacro = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'DupTag.macro',
    styles: [
      { tag: 'x', mode: 'formula_inline', template: '#0' },
      { tag: 'x', mode: 'text', template: '#0 (text)' }
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
  // normalize them in-memory all the way to the v5 shape: a single `Mul.mul`
  // macro with a styles ARRAY (styles[0].tag === 'infix'), per-style mode
  // 'formula', and per-style synthesis.output_type moved to synthesis.mode.
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
  assert(oldMacro.dynamic_arity === false, 'v6: dynamic_arity=false (was arity=fixed)');
  assert(!('arity' in oldMacro), 'legacy arity field dropped in v6');
  assert(oldMacro.kind === 'const', 'kind lifted to top-level');
  assert(Array.isArray(oldMacro.styles), 'styles is a v6 array');
  assert(
    oldMacro.styles.length === 2,
    `both dotted suffixes became styles (got ${oldMacro.styles.length})`
  );
  const infixStyle = oldMacro.styles.find((s) => s.tag === 'infix');
  const implicitStyle = oldMacro.styles.find((s) => s.tag === 'implicit');
  assert(!!infixStyle && !!implicitStyle, 'infix and implicit styles present');
  assert(
    oldMacro.styles[0].tag === 'infix',
    `styles[0] (default) is the first legacy sibling (got ${oldMacro.styles[0].tag})`
  );
  assert(
    infixStyle.mode === 'formula_inline',
    "v6: per-style mode 'math'->'formula_inline' (no display=block on legacy)"
  );
  assert(!('display' in infixStyle), 'v6: display axis folded into mode');
  assert(
    infixStyle.template === '#0 \\cdot #1',
    'style template preserved'
  );
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

  console.log('\n[21] SNL-Basics submodule DB uses the v6 styles-array shape');
  const macroDb = JSON.parse(
    await fs.readFile(
      nodePath.resolve(
        process.cwd(),
        'node_modules/@snl-basics/react/dist-lib/snl-macro-db.json'
      ),
      'utf8'
    )
  );
  // DivRing.div collapsed frac + inlineDiv into a single macro with two styles.
  assert(macroDb['DivRing.div'], 'DivRing.div macro should exist');
  assert(
    Array.isArray(macroDb['DivRing.div'].styles),
    'DivRing.div styles is a v6 array'
  );
  assert(
    macroDb['DivRing.div'].dynamic_arity === false,
    'DivRing.div v6: dynamic_arity boolean present'
  );
  assert(
    macroDb['DivRing.div'].styles.some((s) => s.tag === 'inlineDiv'),
    'DivRing.div has an inlineDiv style'
  );
  assert(
    macroDb['DivRing.div'].styles[0].tag === 'frac',
    'DivRing.div default (styles[0]) is frac'
  );
  assert(
    macroDb['DivRing.div'].styles[0].mode === 'formula_inline',
    'DivRing.div frac style v6: mode is formula_inline'
  );
  assert(
    !('display' in macroDb['DivRing.div'].styles[0]),
    'v6: display axis absent from bundled DB'
  );
  // The typed binders stay separate macros (different arity).
  assert(macroDb['FOL.forall.typed'], 'forall.typed macro should exist');
  assert(macroDb['FOL.exists.typed'], 'exists.typed macro should exist');
  // FOL.implies gained a `double` (⇒) style alongside the default `infix` (→).
  assert(
    macroDb['FOL.implies'].styles.some((s) => s.tag === 'double'),
    'FOL.implies has a double (⇒) style'
  );
  assert(
    macroDb['FOL.implies'].styles[0].tag === 'infix',
    'FOL.implies default (styles[0]) is infix'
  );
  // Legacy top-level macro shape must be fully gone.
  assert(
    macroDb['Add.add'].mode === undefined &&
      macroDb['Add.add'].defaultStyle === undefined,
    'v5 macros drop top-level mode / defaultStyle'
  );
  // Old dotted-style macro names no longer exist as top-level entries.
  assert(!macroDb['DivRing.div.inlineDiv'], 'old DivRing.div.inlineDiv should not exist');
  assert(!macroDb['FOL.forall.binderTyped'], 'old forall.binderTyped should not exist');

  console.log('\n[22] v5-shape package on disk auto-migrates to v6 on read');
  // A fresh temp workspace so we can drop a v5-shape file straight to disk
  // and confirm readMacroPackage rewrites it in memory to v6. This is the
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
    'v5→v6: arity=fixed → dynamic_arity=false, arity removed'
  );
  assert(
    migMatrix.dynamic_arity === true && !('arity' in migMatrix),
    'v5→v6: arity=variadic → dynamic_arity=true'
  );
  assert(
    migAdd.styles[0].mode === 'formula_inline' &&
      !('display' in migAdd.styles[0]),
    'v5→v6: formula+display=inline → formula_inline, display axis removed'
  );
  assert(
    migMatrix.styles[0].mode === 'formula_display' &&
      !('display' in migMatrix.styles[0]),
    'v5→v6: formula+display=block → formula_display, display axis removed'
  );
  assert(
    migMatrix.styles[0].variadic_join === ' \\\\ ',
    'v5→v6: variadic_join preserved (delimiters left/right default empty)'
  );

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
      a: { description: '', source: { entries: [], urls: [] }, dynamic_arity: false, styles: [{ tag: 'default', mode: 'formula_inline', template: 'a' }] },
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
  await fs.rm(tmpRoot3, { recursive: true, force: true });
  await fs.rm(tmpRoot2, { recursive: true, force: true });

  // --- [24] libraryGraph: numbering engine (spec §4-§5) --------------------
  console.log('\n[24] libraryGraph numbering engine');
  const graphMod = await import(
    pathToFileURL(nodePath.resolve(process.cwd(), 'out', 'libraryGraph.js')).href
  );
  const { formatNumbering, numberFor, readingOrder } = graphMod;

  // §5 magic-string formatter
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
  // First-slot-wins invariant: second 1 stays literal.
  assert(formatNumbering('1.1', 3) === '3.1', 'formatNumbering("1.1", 3) → "3.1" (second slot is literal)');

  // §4 numberFor — the cat-supplied 1.3B.5 example verbatim from spec §6.
  const graph1 = {
    nodes: [
      { id: 'cSec', label: 'Counter', props: { numbering: '1' } },
      { id: 'cSubsec', label: 'Counter', props: { numbering: '.1' } },
      { id: 'cEntry', label: 'Counter', props: { numbering: 'A' } },
      { id: 'cSubentry', label: 'Counter', props: { numbering: '.1' } },

      { id: 's1', label: 'Section', props: { name: 'Chapter 1' } },

      { id: 's1a', label: 'Section', props: { name: 'Section 1.1' } },
      { id: 's1b', label: 'Section', props: { name: 'Section 1.2' } },
      { id: 's1c', label: 'Section', props: { name: 'Section 1.3' } },

      { id: 'eA', label: 'Entry', props: { entryId: 'uuid-A' } },
      { id: 'eB', label: 'Entry', props: { entryId: 'uuid-B' } },

      { id: 'eB1', label: 'Entry', props: { entryId: 'uuid-B1' } },
      { id: 'eB2', label: 'Entry', props: { entryId: 'uuid-B2' } },
      { id: 'eB3', label: 'Entry', props: { entryId: 'uuid-B3' } },
      { id: 'eB4', label: 'Entry', props: { entryId: 'uuid-B4' } },
      { id: 'eB5', label: 'Entry', props: { entryId: 'uuid-B5' } }
    ],
    relationships: [
      { from: 'cSec', to: 's1', label: 'count' },

      { from: 'cSubsec', to: 's1a', label: 'count' },
      { from: 's1a', to: 's1b', label: 'next' },
      { from: 's1b', to: 's1c', label: 'next' },

      { from: 'cEntry', to: 'eA', label: 'count' },
      { from: 'eA', to: 'eB', label: 'next' },

      { from: 'cSubentry', to: 'eB1', label: 'count' },
      { from: 'eB1', to: 'eB2', label: 'next' },
      { from: 'eB2', to: 'eB3', label: 'next' },
      { from: 'eB3', to: 'eB4', label: 'next' },
      { from: 'eB4', to: 'eB5', label: 'next' },

      { from: 's1', to: 's1c', label: 'branch' },
      { from: 's1c', to: 'eB', label: 'branch' },
      { from: 'eB', to: 'eB5', label: 'branch' },

      // reading-next chain over Entries (spec §7): eA → eB → eB1..eB5
      { from: 'eA', to: 'eB', label: 'reading-next' },
      { from: 'eB', to: 'eB1', label: 'reading-next' },
      { from: 'eB1', to: 'eB2', label: 'reading-next' },
      { from: 'eB2', to: 'eB3', label: 'reading-next' },
      { from: 'eB3', to: 'eB4', label: 'reading-next' },
      { from: 'eB4', to: 'eB5', label: 'reading-next' }
    ]
  };

  const n_eB5 = numberFor(graph1, 'eB5');
  assert(n_eB5 === '1.3B.5', `numberFor(eB5) → "1.3B.5" (got ${JSON.stringify(n_eB5)})`);
  // Intermediate numbers per spec §6 walk-through.
  assert(numberFor(graph1, 's1') === '1', 'numberFor(s1) → "1"');
  assert(numberFor(graph1, 's1c') === '1.3', 'numberFor(s1c) → "1.3"');
  assert(numberFor(graph1, 'eB') === '1.3B', 'numberFor(eB) → "1.3B"');
  // eA has count+next chain (ordinal 1, template "A" → "A") but no incoming
  // branch edge in this fragment, so it has no sectional prefix. That's the
  // expected shape for a sibling not on the specific branch chain being
  // rendered — surrounding levels still position it via its own counter.
  assert(numberFor(graph1, 'eA') === 'A', 'numberFor(eA) → "A" (no branch parent → bare counter segment)');
  // Missing node → null.
  assert(numberFor(graph1, 'nope') === null, 'numberFor(missing) → null');

  // §7 reading order
  const order = readingOrder(graph1);
  const expectedOrder = ['eA', 'eB', 'eB1', 'eB2', 'eB3', 'eB4', 'eB5'];
  assert(
    JSON.stringify(order) === JSON.stringify(expectedOrder),
    `readingOrder → ${JSON.stringify(expectedOrder)} (got ${JSON.stringify(order)})`
  );

  // Empty graph & orphan graph corner cases.
  assert(
    JSON.stringify(readingOrder({ nodes: [], relationships: [] })) === '[]',
    'readingOrder(empty) → []'
  );
  assert(
    numberFor({ nodes: [], relationships: [] }, 'anything') === null,
    'numberFor(empty, anything) → null'
  );
  const orphanGraph = {
    nodes: [{ id: 'e1', label: 'Entry', props: { entryId: 'x' } }],
    relationships: []
  };
  assert(
    numberFor(orphanGraph, 'e1') === null,
    'numberFor on Entry with no count/next chain → null (unpositioned)'
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

  // writeLibraryGraph round-trip.
  const write1 = await writeLibraryGraph(root4, 'graphtest', {
    nodes: [
      { id: 'c', label: 'Counter', props: { numbering: '1' } },
      { id: 's', label: 'Section', props: { name: 'Chapter' } }
    ],
    relationships: [{ from: 'c', to: 's', label: 'count' }]
  });
  assert(write1.status === 'ok', 'writeLibraryGraph -> ok');
  const read1 = await readLibraryGraph(root4, 'graphtest');
  assert(read1.status === 'ok', 'readLibraryGraph -> ok after write');
  assert(
    read1.result.graph.nodes.length === 2 &&
      read1.result.graph.relationships.length === 1,
    'round-trip preserves 2 nodes + 1 rel'
  );
  assert(read1.result.warnings.length === 0, 'clean graph has no warnings');

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

  console.log(`\nALL SMOKE ASSERTS PASSED (${passed} checks).`);
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err.message);
  process.exit(1);
});
