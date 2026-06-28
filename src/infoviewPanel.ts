import * as vscode from 'vscode';
import * as fs from 'fs';

// TODO: import SNL_render from snl-script lib

/**
 * Singleton manager for the SNL Infoview webview panel.
 *
 * Creates (or reveals an existing) webview panel in the Beside column,
 * loads the Vite-built React bundle from media/webview/, and hardens the
 * embedded HTML with a strict CSP + per-load nonce.
 */
export class InfoviewPanel {
  public static currentPanel: InfoviewPanel | undefined;

  private static readonly viewType = 'snlInfoview';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Beside;

    // Reuse an existing panel if we already have one.
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

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'main.js')
    );

    // Vite only emits main.css when the webview ships real stylesheets.
    // Link it only when present so we never trigger a dangling 404 / CSP noise.
    const cssPath = vscode.Uri.joinPath(
      this.extensionUri,
      'media',
      'webview',
      'main.css'
    );
    const styleUri = webview.asWebviewUri(cssPath);
    const hasCss = fs.existsSync(cssPath.fsPath);
    const styleTag = hasCss
      ? `<link href="${styleUri}" rel="stylesheet" />`
      : '';

    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${styleTag}
  <title>SNL Infoview</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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

function getNonce(): string {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
