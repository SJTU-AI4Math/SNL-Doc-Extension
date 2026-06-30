import * as vscode from 'vscode';
import { initSnlDoc } from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';

/**
 * Singleton manager for the `SNL: Init` guide webview panel.
 *
 * Scope:
 *  - Only responsible for SCAFFOLDING the empty `.SNL_Doc/` skeleton.
 *  - Does NOT create any library — that's the job of `SNL: Create Library`.
 *  - Refuses (exits early, surfaces a warning) when `.SNL_Doc/` already
 *    exists, so the two commands stay non-overlapping.
 *
 * The webview itself is a single-button form (`init.js`); message protocol:
 *  - in  : `{ type: 'init' }` — user clicked "Initialize"
 *  - out : `{ type: 'created' | 'exists' | 'error' | 'noWorkspace', ... }`
 */
export class InitPanel {
  public static currentPanel: InitPanel | undefined;

  private static readonly viewType = 'snlInit';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Active;

    if (InitPanel.currentPanel) {
      InitPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      InitPanel.viewType,
      'SNL Init',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    InitPanel.currentPanel = new InitPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'init',
      'SNL Init'
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as { type?: string } | undefined;
    if (!msg || msg.type !== 'init') {
      return;
    }

    const workspaceRoot = firstWorkspaceFolder();
    if (!workspaceRoot) {
      const text = 'SNL Init requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    try {
      const result = await initSnlDoc(workspaceRoot);
      if (result.status === 'exists') {
        vscode.window.showWarningMessage(
          '.SNL_Doc already exists — use "SNL: Create Library" to add libraries.'
        );
        void this.panel.webview.postMessage({ type: 'exists' });
        return;
      }
      vscode.window.showInformationMessage(
        'SNL Doc skeleton initialized. Use "SNL: Create Library" to add your first library.'
      );
      void this.panel.webview.postMessage({
        type: 'created',
        path: '.SNL_Doc'
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`SNL Init failed: ${text}`);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    InitPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
