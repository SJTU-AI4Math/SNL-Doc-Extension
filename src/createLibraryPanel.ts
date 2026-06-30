import * as vscode from 'vscode';
import { createLibrary } from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';

/**
 * Singleton manager for the `SNL: Create Library` webview panel.
 *
 * Scope:
 *  - Requires `.SNL_Doc/` to already exist (run `SNL: Init` first); the
 *    command short-circuits with an error if it doesn't.
 *  - Adds a single new library `<slug>` to `.SNL_Doc/libraries/` and appends
 *    its `{slug,title}` to `config.json#libraries`.
 *
 * Message protocol with the webview (`createLibrary.js`):
 *  - in  : `{ type: 'create', title }`
 *  - out : `{ type: 'created' | 'duplicate' | 'noSnlDoc' | 'error' | 'noWorkspace', ... }`
 */
export class CreateLibraryPanel {
  public static currentPanel: CreateLibraryPanel | undefined;

  private static readonly viewType = 'snlCreateLibrary';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Active;

    if (CreateLibraryPanel.currentPanel) {
      CreateLibraryPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CreateLibraryPanel.viewType,
      'SNL Create Library',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateLibraryPanel.currentPanel = new CreateLibraryPanel(
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
      'createLibrary',
      'SNL Create Library'
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as { type?: string; title?: string } | undefined;
    if (!msg || msg.type !== 'create') {
      return;
    }

    const workspaceRoot = firstWorkspaceFolder();
    if (!workspaceRoot) {
      const text = 'SNL Create Library requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const title = typeof msg.title === 'string' ? msg.title : '';

    try {
      const result = await createLibrary(workspaceRoot, title);
      switch (result.status) {
        case 'noSnlDoc': {
          const text =
            '.SNL_Doc does not exist yet. Run "SNL: Init" first.';
          vscode.window.showErrorMessage(text);
          void this.panel.webview.postMessage({
            type: 'noSnlDoc',
            message: text
          });
          return;
        }
        case 'duplicate': {
          const text = `Library "${result.slug}" already exists.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            slug: result.slug,
            message: text
          });
          return;
        }
        case 'created':
          vscode.window.showInformationMessage(
            `Library "${result.title}" created (slug: ${result.slug}).`
          );
          void this.panel.webview.postMessage({
            type: 'created',
            slug: result.slug,
            title: result.title
          });
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`SNL Create Library failed: ${text}`);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    CreateLibraryPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
