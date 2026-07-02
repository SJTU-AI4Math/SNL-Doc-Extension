import * as vscode from 'vscode';
import {
  readMacroPackage,
  type MacroPackageFile,
  type MacroPackageEntry
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';

/** Strip a trailing `.json` (case-insensitive) from a package file argument. */
function stripJsonExt(file: string): string {
  return file.replace(/\.json$/i, '');
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
    const pattern = new vscode.RelativePattern(
      root,
      `.SNL_Doc/term_macros/${this.file}.json`
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const refresh = (): void => {
      void this.pushPackage();
    };
    watcher.onDidCreate(refresh, null, this.disposables);
    watcher.onDidChange(refresh, null, this.disposables);
    watcher.onDidDelete(() => this.dispose(), null, this.disposables);
    this.disposables.push(watcher);
  }

  private async pushPackage(): Promise<void> {
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
      void this.panel.webview.postMessage({
        type: 'package',
        pkg,
        file: `${this.file}.json`,
        macros
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as { type?: string } | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    switch (msg.type) {
      case 'ready':
        await this.pushPackage();
        return;
      case 'createMacro':
        await vscode.commands.executeCommand('snlDoc.createMacro', this.file);
        return;
      default:
        return;
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
