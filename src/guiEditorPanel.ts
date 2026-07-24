import * as vscode from 'vscode';
import { buildPanelHtml, handlePanelNavMessage } from './panelUtil';

/** Singleton shell for the DOM/SVG based Entry GUI Editor canvas. */
export class GuiEditorPanel {
  private static currentPanel: GuiEditorPanel | undefined;
  private static readonly viewType = 'snlGuiEditor';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Active;
    if (GuiEditorPanel.currentPanel) {
      GuiEditorPanel.currentPanel.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      GuiEditorPanel.viewType,
      'SNL GUI Editor (Canvas)',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    GuiEditorPanel.currentPanel = new GuiEditorPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'guiEditor',
      'SNL GUI Editor (Canvas)'
    );
    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handleMessage(message: unknown): Promise<void> {
    await handlePanelNavMessage(message);
  }

  public dispose(): void {
    GuiEditorPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
