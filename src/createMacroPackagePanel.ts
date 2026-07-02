import * as vscode from 'vscode';
import { createMacroPackage } from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';

/**
 * Singleton manager for the `SNL: Create Macro Package` webview panel.
 *
 * Scope:
 *  - Requires `.SNL_Doc/` to already exist (run `SNL: Init` first).
 *  - Creates an EMPTY canonical macro package at
 *    `.SNL_Doc/term_macros/<file>.json` via {@link createMacroPackage}.
 *
 * Message protocol with the webview (`createMacroPackage.js`):
 *  - in  : `{ type: 'create', file, name, description }`
 *  - out : `{ type: 'created' | 'duplicate' | 'noSnlDoc' | 'invalid'
 *            | 'error' | 'noWorkspace', ... }`
 */
export class CreateMacroPackagePanel {
  public static currentPanel: CreateMacroPackagePanel | undefined;

  private static readonly viewType = 'snlCreateMacroPackage';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Active;

    if (CreateMacroPackagePanel.currentPanel) {
      CreateMacroPackagePanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CreateMacroPackagePanel.viewType,
      'SNL Create Macro Package',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateMacroPackagePanel.currentPanel = new CreateMacroPackagePanel(
      panel,
      extensionUri
    );
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'createMacroPackage',
      'SNL Create Macro Package'
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as
      | { type?: string; file?: string; name?: string; description?: string }
      | undefined;
    if (!msg || msg.type !== 'create') {
      return;
    }

    const workspaceRoot = firstWorkspaceFolder();
    if (!workspaceRoot) {
      const text =
        'SNL Create Macro Package requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const file = typeof msg.file === 'string' ? msg.file : '';
    const name = typeof msg.name === 'string' ? msg.name : '';
    const description =
      typeof msg.description === 'string' ? msg.description : undefined;

    try {
      const result = await createMacroPackage(
        workspaceRoot,
        file,
        name,
        description
      );
      switch (result.status) {
        case 'ok':
          vscode.window.showInformationMessage(
            `Macro package "${result.file}" created.`
          );
          void this.panel.webview.postMessage({
            type: 'created',
            file: result.file
          });
          // Open the new package's panel right away for a smooth flow.
          void vscode.commands.executeCommand(
            'snlDoc.openMacroPackage',
            result.file
          );
          return;
        case 'duplicate': {
          const text = `Macro package "${result.file}" already exists.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            file: result.file,
            message: text
          });
          return;
        }
        case 'noSnlDoc': {
          const text = '.SNL_Doc does not exist yet. Run "SNL: Init" first.';
          vscode.window.showErrorMessage(text);
          void this.panel.webview.postMessage({
            type: 'noSnlDoc',
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
      vscode.window.showErrorMessage(
        `SNL Create Macro Package failed: ${text}`
      );
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    CreateMacroPackagePanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
