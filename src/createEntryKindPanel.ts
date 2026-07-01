import * as vscode from 'vscode';
import { createEntryKind } from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';

/**
 * Singleton manager for the `SNL: Create Entry Kind` webview panel.
 *
 * Takes one entry-kind record and appends it to
 * `config.json#entry_kinds`. Rejects empty ids/names and duplicate ids.
 *
 * Message protocol with the webview (`createEntryKind.js`):
 *  - in  : `{ type: 'create', payload: { id, name, stroke, background, numbering, style } }`
 *  - out : `{ type: 'created', kind }`
 *        | `{ type: 'duplicate' | 'invalid' | 'noSnlDoc' | 'noWorkspace' | 'error', message, ... }`
 */
export class CreateEntryKindPanel {
  public static currentPanel: CreateEntryKindPanel | undefined;

  private static readonly viewType = 'snlCreateEntryKind';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Active;

    if (CreateEntryKindPanel.currentPanel) {
      CreateEntryKindPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CreateEntryKindPanel.viewType,
      'SNL Create Entry Kind',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateEntryKindPanel.currentPanel = new CreateEntryKindPanel(
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
      'createEntryKind',
      'SNL Create Entry Kind'
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
      | {
          type?: string;
          payload?: {
            id?: string;
            name?: string;
            stroke?: string;
            background?: string;
            numbering?: string;
            style?: string;
          };
        }
      | undefined;
    if (!msg || msg.type !== 'create') {
      return;
    }

    const root = firstWorkspaceFolder();
    if (!root) {
      const text = 'SNL Create Entry Kind requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const p = msg.payload ?? {};
    try {
      const result = await createEntryKind(root, {
        id: p.id ?? '',
        name: p.name ?? '',
        stroke: p.stroke ?? '',
        background: p.background ?? '',
        numbering: p.numbering ?? '',
        style: p.style ?? ''
      });
      switch (result.status) {
        case 'created':
          vscode.window.showInformationMessage(
            `Entry kind "${result.kind.name}" (${result.kind.id}) created.`
          );
          void this.panel.webview.postMessage({
            type: 'created',
            kind: result.kind
          });
          return;
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
          const text = `Entry kind id "${result.id}" already exists.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            id: result.id,
            message: text
          });
          return;
        }
        case 'invalid':
          void this.panel.webview.postMessage({
            type: 'invalid',
            message: result.message
          });
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `SNL Create Entry Kind failed: ${text}`
      );
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    CreateEntryKindPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
