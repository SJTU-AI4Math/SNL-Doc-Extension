import * as vscode from 'vscode';
import {
  readMacroKinds,
  readMacroPackage,
  readMacroPackages,
  resolveActiveMacroPackages,
  setMacroPackageActive,
  batchDeleteMacros,
  batchMoveMacros,
  batchCopyMacros,
  batchPackageAsNew,
  batchMoveToNewPackage,
  readEntries,
  type MacroKind,
  type MacroPackageFile,
  type MacroPackageEntry
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage } from './panelUtil';
import { macroEntityPath, packageManifestPath } from './entityStorage';

/** Strip a trailing `.json` (case-insensitive) from a package file argument. */
function stripJsonExt(file: string): string {
  return file.replace(/\.json$/i, '');
}

/** Coerce an unknown into a non-empty `string[]`, or return null if invalid. */
function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || v.length === 0) return null;
    out.push(v);
  }
  return out;
}

/**
 * Per-file singleton manager for a macro-package panel.
 *
 * Unlike the other panels (which are global singletons), PackagePanel keys its
 * instances by the bare filename so the SAME file always reveals the SAME
 * panel while DIFFERENT files get DIFFERENT panels. A `Map<file, PackagePanel>`
 * tracks the live instances.
 *
 * Message protocol with the webview (`packagePanel.js`):
 *  - in  : `{ type: 'ready' }`         (initial pull)
 *        | `{ type: 'createMacro' }`   (big-plus bar → Create Macro)
 *  - out : `{ type: 'package', pkg, file, macros }`
 *        | `{ type: 'noFile', file }`
 *        | `{ type: 'error', message }`
 */
export class PackagePanel {
  private static readonly panels = new Map<string, PackagePanel>();

  private static readonly viewType = 'snlMacroPackage';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  /** Bare filename (no `.json`) this panel is bound to. */
  private readonly file: string;
  private disposables: vscode.Disposable[] = [];
  private packageGeneration = 0;
  private ownedMacroUris = new Set<string>();

  public static createOrShow(extensionUri: vscode.Uri, file: string): void {
    const bare = stripJsonExt(file);
    const column = vscode.ViewColumn.Active;

    const existing = PackagePanel.panels.get(bare);
    if (existing) {
      existing.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      PackagePanel.viewType,
      `SNL Macros — ${bare}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    PackagePanel.panels.set(
      bare,
      new PackagePanel(panel, extensionUri, bare)
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    file: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.file = file;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'packagePanel',
      `SNL Macros — ${this.file}`
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.installWatcher();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /**
   * Watch this package's own `.SNL_Doc/term_macros/<file>.json` and refresh
   * on change. On delete, the underlying package is gone, so the panel disposes
   * itself to avoid a stale view.
   */
  private installWatcher(): void {
    const root = firstWorkspaceFolder();
    if (!root) {
      return;
    }
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (): void => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void this.pushPackage();
      }, 120);
    };
    this.disposables.push({ dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); } });
    const install = (glob: string, disposeOnDelete = false): void => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, glob)
      );
      watcher.onDidCreate(refresh, null, this.disposables);
      watcher.onDidChange(refresh, null, this.disposables);
      watcher.onDidDelete(disposeOnDelete ? () => this.dispose() : refresh, null, this.disposables);
      this.disposables.push(watcher);
    };

    install(`.SNL_Doc/term_macros/${this.file}.json`);
    install(`.SNL_Doc/${packageManifestPath(this.file)}`, true);
    install('.SNL_Doc/config.json');
    install('.SNL_Doc/term_macros/*.json');
    install('.SNL_Doc/packages/*.json');
    // Macro entity filenames hash the Macro identity, not the package alone;
    // refresh on any Macro change, but never dispose the package panel when a
    // single Macro entity is deleted.
    const macroWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, '.SNL_Doc/macros/*.json')
    );
    const refreshOwnedMacro = async (uri: vscode.Uri): Promise<void> => {
      try {
        const raw = JSON.parse(new TextDecoder('utf-8').decode(
          await vscode.workspace.fs.readFile(uri)
        )) as { package?: unknown };
        if (raw?.package === this.file) refresh();
      } catch {
        // A transient or malformed file is handled by the strict package read.
        refresh();
      }
    };
    macroWatcher.onDidCreate((uri) => { void refreshOwnedMacro(uri); }, null, this.disposables);
    macroWatcher.onDidChange((uri) => { void refreshOwnedMacro(uri); }, null, this.disposables);
    macroWatcher.onDidDelete((uri) => {
      if (this.ownedMacroUris.has(uri.toString())) refresh();
    }, null, this.disposables);
    this.disposables.push(macroWatcher);
    install('.SNL_Doc/entries.json');
    install('.SNL_Doc/entries/*.json');
  }

  private async pushPackage(): Promise<void> {
    const generation = ++this.packageGeneration;
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'noFile',
        file: `${this.file}.json`
      });
      return;
    }
    try {
      const result = await readMacroPackage(root, this.file);
      if (generation !== this.packageGeneration) return;
      if (result.status === 'noFile') {
        void this.panel.webview.postMessage({
          type: 'noFile',
          file: `${this.file}.json`
        });
        return;
      }
      if (result.status === 'error') {
        void this.panel.webview.postMessage({
          type: 'error',
          message: result.message
        });
        return;
      }
      const pkg: MacroPackageFile = result.pkg;
      const macros: MacroPackageEntry[] = result.macros;
      this.ownedMacroUris = new Set(macros.map((macro) =>
        vscode.Uri.joinPath(root, '.SNL_Doc', ...macroEntityPath(this.file, macro.name).split('/'))
          .toString()
      ));
      const macroKinds: MacroKind[] = await readMacroKinds(root);

      // Bootstrap the "Move to package" dropdown with OTHER active packages
      // (bare file + display name). Best-effort: a package that fails to read
      // is simply omitted from the list.
      const active = await resolveActiveMacroPackages(root);
      const summaries = await readMacroPackages(root);
      const otherPackages: Array<{ file: string; name: string }> = [];
      for (const summary of summaries) {
        const bare = summary.file.replace(/\.json$/i, '');
        if (bare === this.file) continue;
        if (!active.includes(bare)) continue;
        const other = await readMacroPackage(root, bare);
        otherPackages.push({
          file: bare,
          name: other.status === 'ok' ? other.pkg.name : bare
        });
      }
      otherPackages.sort((a, b) => a.name.localeCompare(b.name));

      // Ship the entry-pool id set so the macro table can render each
      // row's src status (green/yellow/red) without an extra round-trip.
      // Cat 2026-07-10 §2.
      const entryPool = await readEntries(root);
      const entryPoolIds = entryPool.map((e) => e.id);
      if (generation !== this.packageGeneration) return;

      void this.panel.webview.postMessage({
        type: 'package',
        pkg,
        file: `${this.file}.json`,
        macros,
        macroKinds,
        otherPackages,
        active: active.includes(this.file),
        entryPoolIds
      });
    } catch (err) {
      if (generation !== this.packageGeneration) return;
      const text = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as { type?: string } | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    if (await handlePanelNavMessage(message, () => this.pushPackage())) {
      return;
    }
        switch (msg.type) {
      case 'ready':
        await this.pushPackage();
        return;
      case 'createMacro':
        await vscode.commands.executeCommand('snlDoc.createMacro', this.file);
        return;
      case 'copyMacro': {
        const name = (msg as { name?: unknown }).name;
        if (typeof name === 'string' && name) {
          await vscode.commands.executeCommand(
            'snlDoc.createMacro',
            this.file,
            { copyFrom: name }
          );
        }
        return;
      }
      case 'editMacroPackage':
        await vscode.commands.executeCommand(
          'snlDoc.editMacroPackage',
          this.file
        );
        return;
      case 'editMacro': {
        const name = (msg as { name?: unknown }).name;
        if (typeof name === 'string' && name) {
          await vscode.commands.executeCommand(
            'snlDoc.editMacro',
            this.file,
            name
          );
        }
        return;
      }
      case 'batchDelete': {
        const names = toStringArray((msg as { macroNames?: unknown }).macroNames);
        if (!names) {
          void this.postError('batchDelete: macroNames must be a string array');
          return;
        }
        // Host-side modal (cat 2026-07-09) — window.confirm is CSP-blocked
        // in webviews. The previous webview-side confirm was a silent no-op.
        const noun = `${names.length} macro${names.length === 1 ? '' : 's'}`;
        const confirmed = await vscode.window.showWarningMessage(
          `Delete ${noun} from this package?`,
          {
            modal: true,
            detail:
              'This cannot be undone. The package JSON is rewritten with these macros removed.'
          },
          'Delete'
        );
        if (confirmed !== 'Delete') {
          void this.panel.webview.postMessage({ type: 'batchCancelled' });
          return;
        }
        await this.runBatch(async (root) => {
          const res = await batchDeleteMacros(root, this.file, names);
          if (res.status === 'ok') return null;
          if (res.status === 'noFile') return 'Package file not found.';
          return res.message;
        });
        return;
      }
      case 'batchTransfer': {
        // Unified copy/move dispatcher for the merged "Copy/Move macros"
        // dialog. `mode`: 'copy' | 'move'. `target`: 'existing' picks
        // {destFile}; 'new' creates a fresh package from
        // {newFile, newDisplayName?, newDescription?}. The four
        // combinations map onto:
        //   copy+existing -> batchCopyMacros
        //   move+existing -> batchMoveMacros
        //   copy+new      -> batchPackageAsNew
        //   move+new      -> batchMoveToNewPackage
        const m = msg as {
          mode?: unknown;
          target?: unknown;
          macroNames?: unknown;
          destFile?: unknown;
          newFile?: unknown;
          newDisplayName?: unknown;
          newDescription?: unknown;
        };
        const names = toStringArray(m.macroNames);
        if (!names) {
          void this.postError(
            'batchTransfer: macroNames must be a string array'
          );
          return;
        }
        const mode = m.mode === 'move' ? 'move' : m.mode === 'copy' ? 'copy' : null;
        if (!mode) {
          void this.postError("batchTransfer: mode must be 'copy' or 'move'");
          return;
        }
        const target =
          m.target === 'new' ? 'new' : m.target === 'existing' ? 'existing' : null;
        if (!target) {
          void this.postError(
            "batchTransfer: target must be 'existing' or 'new'"
          );
          return;
        }

        if (target === 'existing') {
          const destFile = m.destFile;
          if (typeof destFile !== 'string' || !destFile) {
            void this.postError(
              'batchTransfer: destFile is required when target=existing'
            );
            return;
          }
          await this.runBatch(async (root) => {
            const res =
              mode === 'move'
                ? await batchMoveMacros(root, this.file, destFile, names)
                : await batchCopyMacros(root, this.file, destFile, names);
            if (res.status === 'ok') return null;
            if (res.status === 'conflict') {
              return (
                `${mode === 'move' ? 'Move' : 'Copy'} refused — the destination package already has: ` +
                res.conflictNames.join(', ') +
                '. Rename or remove the conflicts first.'
              );
            }
            if (res.status === 'noFile') {
              return res.which === 'dest'
                ? 'Destination package not found.'
                : 'Source package not found.';
            }
            return res.message;
          });
          return;
        }

        // target === 'new'
        if (typeof m.newFile !== 'string' || !m.newFile) {
          void this.postError(
            'batchTransfer: newFile is required when target=new'
          );
          return;
        }
        const newFile = m.newFile;
        const newDisplayName =
          typeof m.newDisplayName === 'string' ? m.newDisplayName : undefined;
        const newDescription =
          typeof m.newDescription === 'string' ? m.newDescription : undefined;
        await this.runBatch(async (root) => {
          const res =
            mode === 'move'
              ? await batchMoveToNewPackage(
                  root,
                  this.file,
                  names,
                  newFile,
                  newDisplayName,
                  newDescription
                )
              : await batchPackageAsNew(
                  root,
                  this.file,
                  names,
                  newFile,
                  newDisplayName,
                  newDescription
                );
          if (res.status === 'ok') return null;
          if (res.status === 'duplicate') {
            return `A package named "${res.file}" already exists.`;
          }
          if (res.status === 'noFile') return 'Source package not found.';
          if (res.status === 'invalid') return res.reason;
          return res.message;
        });
        return;
      }
      case 'setPackageActive': {
        const active = (msg as { active?: unknown }).active;
        if (typeof active !== 'boolean') {
          void this.postError('setPackageActive: active must be a boolean');
          return;
        }
        await this.runBatch(async (root) => {
          await setMacroPackageActive(root, this.file, active);
          return null;
        });
        return;
      }
      default:
        return;
    }
  }
  private async postError(message: string): Promise<void> {
    await this.panel.webview.postMessage({ type: 'error', message });
  }

  /**
   * Run a batch operation with a resolved workspace root. The callback
   * returns `null` on success (panel is refreshed) or an error string to
   * surface to the webview as a toast.
   */
  private async runBatch(
    op: (root: vscode.Uri) => Promise<string | null>
  ): Promise<void> {
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.postError('No workspace folder open.');
      return;
    }
    try {
      const err = await op(root);
      if (err) {
        void this.postError(err);
        return;
      }
      await this.pushPackage();
    } catch (e) {
      void this.postError(e instanceof Error ? e.message : String(e));
    }
  }

  public dispose(): void {
    PackagePanel.panels.delete(this.file);

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
