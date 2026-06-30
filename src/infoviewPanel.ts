import * as vscode from 'vscode';
import { buildPanelHtml } from './panelUtil';

// TODO: import SNL_render from snl-script lib

/**
 * Singleton manager for the SNL Infoview webview panel.
 *
 * The Infoview is the READING surface (renders SNL documents). Compare with
 * {@link DashboardPanel}, which is the *management* surface.
 *
 * Creates (or reveals an existing) webview panel in the Beside column and
 * loads the Vite-built `main.js` bundle. HTML boilerplate (CSP / nonce /
 * optional CSS link) is shared via {@link buildPanelHtml}.
 */
export class InfoviewPanel {
  public static currentPanel: InfoviewPanel | undefined;

  private static readonly viewType = 'snlInfoview';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Beside;

    if (InfoviewPanel.currentPanel) {
      InfoviewPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      InfoviewPanel.viewType,
      'SNL Infoview',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    InfoviewPanel.currentPanel = new InfoviewPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'main',
      'SNL Infoview'
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public dispose(): void {
    InfoviewPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
