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
    addMacro
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
    arity: 'fixed',
    styles: [
      {
        tag: 'infix',
        mode: 'formula',
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
    styles: [{ tag: 'default', mode: 'formula', template: '   ' }]
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
    'addMacro legacy per-style mode:"math" -> invalid (renamed to formula)'
  );

  console.log('\n[17c] addMacro missing style.tag -> invalid');
  const noTagMacro = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'NoTag.macro',
    styles: [{ mode: 'formula', template: '#0' }]
  });
  assert(noTagMacro.status === 'invalid', 'addMacro missing style.tag -> invalid');

  console.log('\n[17d] addMacro with duplicate style tags -> invalid');
  const dupTagMacro = await addMacro(root, 'test_pkg', {
    ...validMacro,
    name: 'DupTag.macro',
    styles: [
      { tag: 'x', mode: 'formula', template: '#0' },
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
    readOne.macros.length === 1 && readOne.macros[0].name === 'Add.add.infix',
    'readMacroPackage returns the 1 appended macro (with name)'
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
  assert(
    !('mode' in oldMacro) && !('defaultStyle' in oldMacro),
    'top-level mode / defaultStyle stripped in v5 shape'
  );
  assert(oldMacro.arity === 'fixed', 'arity lifted to top-level');
  assert(oldMacro.kind === 'const', 'kind lifted to top-level');
  assert(Array.isArray(oldMacro.styles), 'styles is a v5 array');
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
  assert(infixStyle.mode === 'formula', "per-style mode normalized 'math'->'formula'");
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
    mkApplied.count === 5,
    `snl-basics-defaults seeds 5 kinds (got ${mkApplied.count})`
  );
  const mkAfterPreset = await readMacroKinds(root);
  assert(mkAfterPreset.length === 5, 'readMacroKinds now 5 after preset');
  const ruleKind = mkAfterPreset.find((k) => k.id === 'rule');
  assert(!!ruleKind, 'rule macro kind present');
  assert(
    ruleKind.coloring.stroke === '#009C27' &&
      ruleKind.coloring.background === '#D6FEE0',
    'rule kind colors match DEFAULT_KIND_PALETTE (green)'
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
  assert(mkAfterCreate.length === 6, 'readMacroKinds now 6 after create');
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
    Array.isArray(overviewMk.macroKinds) && overviewMk.macroKinds.length === 6,
    'readOverview surfaces 6 macroKinds'
  );

  // Cleanup.
  await fs.rm(tmpRoot, { recursive: true, force: true });

  console.log('\n[21] SNL-Basics submodule DB uses the v5 styles-array shape');
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
    'DivRing.div styles is a v5 array'
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
    macroDb['DivRing.div'].styles[0].mode === 'formula',
    'DivRing.div frac style has per-style mode formula'
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

  console.log(`\nALL SMOKE ASSERTS PASSED (${passed} checks).`);
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err.message);
  process.exit(1);
});
