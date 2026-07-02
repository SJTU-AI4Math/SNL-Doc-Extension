import * as vscode from 'vscode';
import { addMacro, readMacroPackage, type SnlMacro } from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';

/** Strip a trailing `.json` (case-insensitive) from a package file argument. */
function stripJsonExt(file: string): string {
  return file.replace(/\.json$/i, '');
}

/**
 * Per-file singleton manager for the `SNL: Create Macro` editor panel.
 *
 * Keyed by the package's bare filename so at most one Create-Macro editor is
 * open per package. Mirrors {@link PackagePanel}'s Map-based instance tracking.
 *
 * On `ready`, the host reads the target package and sends the existing macro
 * names (so the editor can warn about duplicates) plus the package display
 * name. On `create`, the assembled {@link SnlMacro} is appended via
 * {@link addMacro}.
 *
 * Message protocol with the webview (`createMacro.js`):
 *  - in  : `{ type: 'ready' }`
 *        | `{ type: 'create', macro: SnlMacro }`
 *  - out : `{ type: 'context', file, packageName, existingNames }`
 *        | `{ type: 'created', name }`
 *        | `{ type: 'duplicate', name, message }`
 *        | `{ type: 'invalid', reason }`
 *        | `{ type: 'noFile' | 'error' | 'noWorkspace', message }`
 */
export class CreateMacroPanel {
  private static readonly panels = new Map<string, CreateMacroPanel>();

  private static readonly viewType = 'snlCreateMacro';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  /** Bare filename (no `.json`) of the target package. */
  private readonly file: string;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, file: string): void {
    const bare = stripJsonExt(file);
    const column = vscode.ViewColumn.Active;

    const existing = CreateMacroPanel.panels.get(bare);
    if (existing) {
      existing.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CreateMacroPanel.viewType,
      `SNL Create Macro — ${bare}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateMacroPanel.panels.set(
      bare,
      new CreateMacroPanel(panel, extensionUri, bare)
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
      'createMacro',
      `SNL Create Macro — ${this.file}`
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushContext(): Promise<void> {
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'context',
        file: `${this.file}.json`,
        packageName: this.file,
        existingNames: []
      });
      return;
    }
    const read = await readMacroPackage(root, this.file);
    if (read.status === 'ok') {
      void this.panel.webview.postMessage({
        type: 'context',
        file: `${this.file}.json`,
        packageName: read.pkg.name,
        existingNames: read.macros.map((m) => m.name)
      });
      return;
    }
    // noFile / error → still let the editor open, just with no existing names.
    void this.panel.webview.postMessage({
      type: 'context',
      file: `${this.file}.json`,
      packageName: this.file,
      existingNames: []
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as
      | { type?: string; macro?: SnlMacro }
      | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    if (msg.type === 'ready') {
      await this.pushContext();
      return;
    }
    if (msg.type !== 'create') {
      return;
    }

    const root = firstWorkspaceFolder();
    if (!root) {
      const text = 'SNL Create Macro requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const macro = msg.macro;
    if (!macro || typeof macro !== 'object') {
      void this.panel.webview.postMessage({
        type: 'invalid',
        reason: 'no macro payload'
      });
      return;
    }

    try {
      const result = await addMacro(root, this.file, macro);
      switch (result.status) {
        case 'ok':
          vscode.window.showInformationMessage(
            `Macro "${result.name}" added to ${this.file}.json.`
          );
          void this.panel.webview.postMessage({
            type: 'created',
            name: result.name
          });
          // Refresh the editor's existing-names list.
          await this.pushContext();
          return;
        case 'duplicate': {
          const text = `Macro "${result.name}" already exists in this package.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            name: result.name,
            message: text
          });
          return;
        }
        case 'noFile': {
          const text = `Package ${this.file}.json no longer exists.`;
          vscode.window.showErrorMessage(text);
          void this.panel.webview.postMessage({
            type: 'noFile',
            message: text
          });
          return;
        }
        case 'invalid':
          void this.panel.webview.postMessage({
            type: 'invalid',
            reason: result.reason
          });
          return;
        case 'error':
          void this.panel.webview.postMessage({
            type: 'error',
            message: result.message
          });
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`SNL Create Macro failed: ${text}`);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    CreateMacroPanel.panels.delete(this.file);

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
