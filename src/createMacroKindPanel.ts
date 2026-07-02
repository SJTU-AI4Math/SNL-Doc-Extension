import * as vscode from 'vscode';
import { createMacroKind } from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';

/**
 * Singleton manager for the `SNL: Create Macro Kind` webview panel.
 *
 * Takes one macro-kind record and appends it to
 * `config.json#macro_kinds`. Rejects empty ids/names and duplicate ids.
 *
 * Message protocol with the webview (`createMacroKind.js`):
 *  - in  : `{ type: 'create', payload: { id, name, description, stroke, background } }`
 *  - out : `{ type: 'created', kind }`
 *        | `{ type: 'duplicate' | 'invalid' | 'noSnlDoc' | 'noWorkspace' | 'error', message, ... }`
 */
export class CreateMacroKindPanel {
  public static currentPanel: CreateMacroKindPanel | undefined;

  private static readonly viewType = 'snlCreateMacroKind';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Active;

    if (CreateMacroKindPanel.currentPanel) {
      CreateMacroKindPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CreateMacroKindPanel.viewType,
      'SNL Create Macro Kind',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateMacroKindPanel.currentPanel = new CreateMacroKindPanel(
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
      'createMacroKind',
      'SNL Create Macro Kind'
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
            description?: string;
            stroke?: string;
            background?: string;
          };
        }
      | undefined;
    if (!msg || msg.type !== 'create') {
      return;
    }

    const root = firstWorkspaceFolder();
    if (!root) {
      const text = 'SNL Create Macro Kind requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const p = msg.payload ?? {};
    try {
      const result = await createMacroKind(root, {
        id: p.id ?? '',
        name: p.name ?? '',
        description: p.description ?? '',
        coloring: {
          stroke: p.stroke ?? '',
          background: p.background ?? ''
        }
      });
      switch (result.status) {
        case 'created':
          vscode.window.showInformationMessage(
            `Macro kind "${result.kind.name}" (${result.kind.id}) created.`
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
          const text = `Macro kind id "${result.id}" already exists.`;
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
        `SNL Create Macro Kind failed: ${text}`
      );
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    CreateMacroKindPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
