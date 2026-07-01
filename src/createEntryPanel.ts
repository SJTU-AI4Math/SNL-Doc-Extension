import * as vscode from 'vscode';
import { addEntry, listEntryKinds, type EntryData } from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';

/**
 * Singleton manager for the `SNL: Create Entry` webview panel.
 *
 * The panel hosts the Entry editor MVP: title + id, a kind dropdown (seeded
 * from `config.json#entry_kinds`), a kind-aware live preview, and per-format
 * content tabs (SNL / Typst / LaTeX / Markdown / Text). On submit it appends
 * one {@link EntryData} to `.SNL_Doc/entries.json` via {@link addEntry}.
 *
 * Message protocol with the webview (`createEntry.js`):
 *  - in  : `{ type: 'ready' }`                       (ask for kind list)
 *        | `{ type: 'create', entry: EntryData }`    (submit)
 *  - out : `{ type: 'kinds', kinds: EntryKind[] }`
 *        | `{ type: 'created', id }`
 *        | `{ type: 'duplicate', id }`
 *        | `{ type: 'unknownKind', kind }`
 *        | `{ type: 'invalid', reason }`
 *        | `{ type: 'noSnlDoc' | 'noWorkspace' | 'error', message }`
 */
export class CreateEntryPanel {
  public static currentPanel: CreateEntryPanel | undefined;

  private static readonly viewType = 'snlCreateEntry';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Active;

    if (CreateEntryPanel.currentPanel) {
      CreateEntryPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CreateEntryPanel.viewType,
      'SNL Create Entry',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateEntryPanel.currentPanel = new CreateEntryPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'createEntry',
      'SNL Create Entry'
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushKinds(): Promise<void> {
    const root = firstWorkspaceFolder();
    const kinds = root ? await listEntryKinds(root) : [];
    void this.panel.webview.postMessage({ type: 'kinds', kinds });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as
      | { type?: string; entry?: EntryData }
      | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    if (msg.type === 'ready') {
      await this.pushKinds();
      return;
    }
    if (msg.type !== 'create') {
      return;
    }

    const root = firstWorkspaceFolder();
    if (!root) {
      const text = 'SNL Create Entry requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const entry = msg.entry;
    if (!entry || typeof entry !== 'object') {
      void this.panel.webview.postMessage({
        type: 'invalid',
        reason: 'no entry payload'
      });
      return;
    }

    try {
      const result = await addEntry(root, entry);
      switch (result.status) {
        case 'ok':
          vscode.window.showInformationMessage(
            `Entry "${entry.title}" (${result.id}) created.`
          );
          void this.panel.webview.postMessage({
            type: 'created',
            id: result.id
          });
          return;
        case 'duplicate': {
          const text = `Entry id "${result.id}" already exists.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            id: result.id,
            message: text
          });
          return;
        }
        case 'unknownKind': {
          const text = `Unknown entry kind: "${result.kind}".`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'unknownKind',
            kind: result.kind,
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
        case 'noSnlDoc': {
          const text = '.SNL_Doc does not exist yet. Run "SNL: Init" first.';
          vscode.window.showErrorMessage(text);
          void this.panel.webview.postMessage({
            type: 'noSnlDoc',
            message: text
          });
          return;
        }
        case 'error':
          void this.panel.webview.postMessage({
            type: 'error',
            message: result.message
          });
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`SNL Create Entry failed: ${text}`);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    CreateEntryPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
