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

/**
 * Shared handler for top-of-panel navigation messages posted by the
 * `PanelNav` webview component (cat 2026-07-09). Every editor / list
 * panel has a top-left back button and (where applicable) a right-side
 * "View in Infoview" button; the messages they post are all funneled
 * through this dispatcher so we don't repeat the 4 same case-branches
 * in every panel class.
 *
 * Returns `true` when the message was recognized as a nav message and
 * dispatched (so the caller should stop processing). Returns `false`
 * when it's not a nav message and the caller should continue its own
 * switch.
 */
export async function handlePanelNavMessage(message: unknown): Promise<boolean> {
  const msg = message as { type?: unknown } | null | undefined;
  if (!msg || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'nav.openDashboard':
      await vscode.commands.executeCommand('snlDoc.openDashboard');
      return true;
    case 'nav.openInfoview': {
      // Optional payload: `{ slug }` to open a specific library, `{ entryId }`
      // to open per-entry infoview. Either omit both for the browser root.
      const m = msg as { slug?: unknown; entryId?: unknown };
      if (typeof m.entryId === 'string' && m.entryId.trim()) {
        await vscode.commands.executeCommand(
          'snlDoc.openEntryInfoview',
          m.entryId.trim()
        );
      } else if (typeof m.slug === 'string' && m.slug.trim()) {
        await vscode.commands.executeCommand(
          'snlDoc.openInfoview',
          m.slug.trim()
        );
      } else {
        await vscode.commands.executeCommand('snlDoc.openInfoview');
      }
      return true;
    }
    default:
      return false;
  }
}
