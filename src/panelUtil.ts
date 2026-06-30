import * as vscode from 'vscode';
import * as fs from 'fs';

/**
 * Random nonce for the webview CSP `script-src` allowlist.
 * Centralized so every panel uses the same generator.
 */
export function getNonce(): string {
  let text = '';
  const possible =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * Render the boilerplate HTML for a webview panel: strict CSP + per-load
 * nonce + optional sibling .css link.
 *
 * Each entry is built as a self-contained classic `<script>` bundle by Vite
 * (see webview/vite.config.ts) and emitted into `media/webview/<entry>.js`.
 * The matching `<entry>.css` is linked only when Vite actually produced it,
 * to avoid dangling 404s / CSP noise.
 */
export function buildPanelHtml(
  extensionUri: vscode.Uri,
  webview: vscode.Webview,
  entry: string,
  title: string
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'webview', `${entry}.js`)
  );

  const cssPath = vscode.Uri.joinPath(
    extensionUri,
    'media',
    'webview',
    `${entry}.css`
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
  <title>${title}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** Helper: the first workspace folder URI, or undefined when none open. */
export function firstWorkspaceFolder(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}
