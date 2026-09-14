// Real compiled Macro Host/writer, with only VS Code's platform API shimmed.
import Module, { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
let cachedVscode;
export function macroPanelHost(repo, workspace, postMessage) {
  class Uri {
    constructor(path) { this.path = this.fsPath = path; this.scheme = 'file'; this.authority = ''; }
    static file(path) { return new Uri(path); }
    static joinPath(base, ...parts) { return new Uri(join(base.path, ...parts)); }
    toString() { return `file://${this.path}`; }
  }
  const root = Uri.file(workspace);
  const events = [];
  const disposable = () => ({ dispose() {} });
  const vscode = {
    Uri, FileType: { File: 1, Directory: 2, SymbolicLink: 64 }, RelativePattern: class {},
    ColorThemeKind: { Light: 1, Dark: 2 }, env: { language: 'en' },
    window: { activeColorTheme: { kind: 2 }, showInformationMessage() {}, showErrorMessage() {},
      showWarningMessage() {}, createOutputChannel() {}, onDidChangeActiveColorTheme: disposable },
    commands: { executeCommand: async () => {} },
    workspace: {
      workspaceFolders: [{ uri: root }], getConfiguration: () => ({ get: () => undefined }),
      onDidChangeConfiguration: disposable,
      createFileSystemWatcher: () => ({ onDidCreate: h => events.push(h), onDidChange: h => events.push(h), onDidDelete: h => events.push(h), dispose() {} }),
      fs: {
        stat: async u => { const s = await fs.lstat(u.path); return { type: s.isSymbolicLink() ? 64 : s.isDirectory() ? 2 : 1, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; },
        readFile: u => fs.readFile(u.path),
        writeFile: async (u, bytes) => { await fs.mkdir(dirname(u.path), { recursive: true }); await fs.writeFile(u.path, bytes); },
        createDirectory: u => fs.mkdir(u.path, { recursive: true }),
        rename: (a, b) => fs.rename(a.path, b.path),
        delete: (u, o = {}) => fs.rm(u.path, { recursive: o.recursive === true, force: true }),
        readDirectory: async u => (await fs.readdir(u.path, { withFileTypes: true })).map(d => [d.name, d.isDirectory() ? 2 : d.isSymbolicLink() ? 64 : 1])
      }
    }
  };
  if (cachedVscode) Object.assign(cachedVscode, vscode);
  else cachedVscode = vscode;
  const original = Module._load;
  Module._load = function (request, parent, main) {
    return request === 'vscode' ? cachedVscode : original.call(this, request, parent, main);
  };
  const require = createRequire(import.meta.url);
  let doc, CreateMacroPanel, installSnlDocWatcher;
  try {
    doc = require(join(repo, 'out/snlDoc.js'));
    ({ CreateMacroPanel } = require(join(repo, 'out/createMacroPanel.js')));
    ({ installSnlDocWatcher } = require(join(repo, 'out/panelUtil.js')));
  } finally { Module._load = original; }
  const originalRead = doc.readMacroPackage;
  let gate;
  doc.readMacroPackage = async (...args) => {
    if (gate) { const held = gate; gate = undefined; held.started(); await held.promise; if (held.fail) throw Error('Injected post-save package read failure'); }
    return originalRead(...args);
  };
  let instance;
  const disposables = [];
  installSnlDocWatcher(disposables, () => instance.pushContext());
  return {
    doc, root,
    configure(mode, file, name, prefill) {
      instance = Object.assign(Object.create(CreateMacroPanel.prototype), {
        mode, file, macroName: name, prefill, instanceKey: `${mode}:${file}:${name}`,
        contextGeneration: 0, disposables: [], panel: { webview: { postMessage }, title: '' }
      });
    },
    handle: m => instance.handleMessage(m),
    watcher: () => events.forEach(h => h(Uri.joinPath(root, '.SNL_Doc', 'config.json'))),
    holdRead(fail = false) {
      let release, started;
      const promise = new Promise(done => { release = done; });
      const entered = new Promise(done => { started = done; });
      gate = { promise, started, fail };
      return { release, entered };
    },
    close() {
      doc.readMacroPackage = originalRead;
      if (instance && CreateMacroPanel.instances.get(instance.instanceKey) === instance) CreateMacroPanel.instances.delete(instance.instanceKey);
      disposables.forEach(d => d?.dispose());
    }
  };
}
