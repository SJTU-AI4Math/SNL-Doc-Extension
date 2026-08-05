import * as vscode from 'vscode';
import { bind_preferences_panel_title } from './preferencesHost';
import {
  readAllMacros,
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
import { packageManifestPath } from './entityStorage';
import { stripJsonExt } from './macroPackageName';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { extension_preferences_runtime } from './preferences';

const PACKAGE_HOST_MESSAGES = defineHostMessages(
  {
    title: 'SNL Macros — {file}',
    deletePrompt: { arg: 'count', one: 'Delete {count} macro from this package?', other: 'Delete {count} macros from this package?' },
    deleteDetail: 'This cannot be undone. The package JSON is rewritten with these macros removed.',
    deleteAction: 'Delete',
    invalidNames: '{operation}: macroNames must be a string array',
    packageNotFound: 'Package file not found.',
    invalidMode: "batchTransfer: mode must be 'copy' or 'move'",
    invalidTarget: "batchTransfer: target must be 'existing' or 'new'",
    destinationRequired: 'batchTransfer: destFile is required when target=existing',
    moveOperation: 'Move',
    copyOperation: 'Copy',
    destinationConflict: '{operation} refused — the destination package already has: {names}. Rename or remove the conflicts first.',
    destinationNotFound: 'Destination package not found.',
    sourceNotFound: 'Source package not found.',
    newFileRequired: 'batchTransfer: newFile is required when target=new',
    duplicatePackage: 'A package named "{file}" already exists.',
    invalidActive: 'setPackageActive: active must be a boolean',
    noWorkspace: 'No workspace folder open.'
  },
  {
    title: 'SNL 宏 — {file}',
    deletePrompt: '要从此包中删除 {count} 个宏吗？',
    deleteDetail: '此操作无法撤销。将重写包 JSON 并移除这些宏。',
    deleteAction: '删除',
    invalidNames: '{operation}：macroNames 必须是字符串数组',
    packageNotFound: '找不到包文件。',
    invalidMode: "batchTransfer：mode 必须是 'copy' 或 'move'",
    invalidTarget: "batchTransfer：target 必须是 'existing' 或 'new'",
    destinationRequired: 'batchTransfer：target=existing 时必须指定 destFile',
    moveOperation: '移动',
    copyOperation: '复制',
    destinationConflict: '拒绝{operation}——目标包中已存在：{names}。请先重命名或移除冲突项。',
    destinationNotFound: '找不到目标包。',
    sourceNotFound: '找不到源包。',
    newFileRequired: 'batchTransfer：target=new 时必须指定 newFile',
    duplicatePackage: '名为“{file}”的包已存在。',
    invalidActive: 'setPackageActive：active 必须是布尔值',
    noWorkspace: '未打开工作区文件夹。'
  }
);

export function createPackageHostTranslator(language: string) {
  return createHostTranslator(language, PACKAGE_HOST_MESSAGES);
}

function packageT() {
  return createPackageHostTranslator(extension_preferences_runtime.query_environment().language);
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
      packageT()('title', { file: bare }),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    bind_preferences_panel_title(panel, () => packageT()('title', { file: bare }));

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
      packageT()('title', { file: this.file })
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
    macroWatcher.onDidCreate(refresh, null, this.disposables);
    macroWatcher.onDidChange(refresh, null, this.disposables);
    macroWatcher.onDidDelete(refresh, null, this.disposables);
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

      const [macroKinds, workspaceMacros]: [MacroKind[], Record<string, MacroPackageEntry>] = await Promise.all([
        readMacroKinds(root),
        readAllMacros(root)
      ]);

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
        workspaceMacros,
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
          void this.postError(packageT()('invalidNames', { operation: 'batchDelete' }));
          return;
        }
        // Host-side modal (cat 2026-07-09) — window.confirm is CSP-blocked
        // in webviews. The previous webview-side confirm was a silent no-op.
        const t = packageT();
        const confirmed = await vscode.window.showWarningMessage(
          t('deletePrompt', { count: names.length }),
          {
            modal: true,
            detail: t('deleteDetail')
          },
          t('deleteAction')
        );
        if (confirmed !== t('deleteAction')) {
          void this.panel.webview.postMessage({ type: 'batchCancelled' });
          return;
        }
        await this.runBatch(async (root) => {
          const res = await batchDeleteMacros(root, this.file, names);
          if (res.status === 'ok') return null;
          if (res.status === 'noFile') return packageT()('packageNotFound');
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
          void this.postError(packageT()('invalidNames', { operation: 'batchTransfer' }));
          return;
        }
        const mode = m.mode === 'move' ? 'move' : m.mode === 'copy' ? 'copy' : null;
        if (!mode) {
          void this.postError(packageT()('invalidMode'));
          return;
        }
        const target =
          m.target === 'new' ? 'new' : m.target === 'existing' ? 'existing' : null;
        if (!target) {
          void this.postError(packageT()('invalidTarget'));
          return;
        }

        if (target === 'existing') {
          const destFile = m.destFile;
          if (typeof destFile !== 'string' || !destFile) {
            void this.postError(packageT()('destinationRequired'));
            return;
          }
          await this.runBatch(async (root) => {
            const res =
              mode === 'move'
                ? await batchMoveMacros(root, this.file, destFile, names)
                : await batchCopyMacros(root, this.file, destFile, names);
            if (res.status === 'ok') return null;
            if (res.status === 'conflict') {
              return packageT()('destinationConflict', {
                operation: mode === 'move'
                  ? packageT()('moveOperation')
                  : packageT()('copyOperation'),
                names: res.conflictNames.join(', ')
              });
            }
            if (res.status === 'noFile') {
              return res.which === 'dest'
                ? packageT()('destinationNotFound')
                : packageT()('sourceNotFound');
            }
            return res.message;
          });
          return;
        }

        // target === 'new'
        if (typeof m.newFile !== 'string' || !m.newFile) {
          void this.postError(packageT()('newFileRequired'));
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
            return packageT()('duplicatePackage', { file: res.file });
          }
          if (res.status === 'noFile') return packageT()('sourceNotFound');
          if (res.status === 'invalid') return res.reason;
          return res.message;
        });
        return;
      }
      case 'setPackageActive': {
        const active = (msg as { active?: unknown }).active;
        if (typeof active !== 'boolean') {
          void this.postError(packageT()('invalidActive'));
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
      void this.postError(packageT()('noWorkspace'));
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
