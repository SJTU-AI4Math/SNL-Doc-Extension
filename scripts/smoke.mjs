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
    addEntry,
    readEntries: readEntriesApi,
    readOverview
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

  // Cleanup.
  await fs.rm(tmpRoot, { recursive: true, force: true });

  console.log(`\nALL SMOKE ASSERTS PASSED (${passed} checks).`);
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err.message);
  process.exit(1);
});
