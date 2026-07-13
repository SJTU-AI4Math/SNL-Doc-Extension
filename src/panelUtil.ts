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
 * Install a shared `.SNL_Doc/**` file-system watcher that fires `refresh`
 * on any create / change / delete beneath the workspace's `.SNL_Doc/`
 * folder (config, entries, macros, kinds, libraries, relationships…).
 *
 * Every editor panel needs this so a sibling panel's save (or a
 * hand-edit of a data file) shows up without a close-and-reopen. Cat
 * 2026-07-13: '数据文件改完以后各个浏览和编辑界面的自动同步还是不
 * 正常, 必须要关掉重开.' Panels that already had bespoke watchers
 * (Dashboard, GraphPanel, Infoview) keep them for their narrower globs;
 * this helper is for every OTHER panel that had no watcher at all.
 *
 * The single `.SNL_Doc/**` glob catches everything — writes are rare
 * enough that overfiring is fine, and the panel's own `pushContext()`
 * is idempotent.
 */
export function installSnlDocWatcher(
  disposables: vscode.Disposable[],
  refresh: () => void | Promise<void>
): void {
  const root = firstWorkspaceFolder();
  if (!root) return;
  const pattern = new vscode.RelativePattern(root, '.SNL_Doc/**');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const fire = (): void => {
    void refresh();
  };
  watcher.onDidCreate(fire, null, disposables);
  watcher.onDidChange(fire, null, disposables);
  watcher.onDidDelete(fire, null, disposables);
  disposables.push(watcher);
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
 *
 * A `refresh` callback can be passed to opt into the shared PanelNav
 * refresh button (cat 2026-07-13 '手动刷新键也没有'). When the webview
 * posts `{ type: 'nav.refresh' }` and a callback is supplied, we invoke
 * it and swallow the message; otherwise we hand it back to the caller
 * (false) so a panel that doesn't opt in stays unaffected.
 */
export async function handlePanelNavMessage(
  message: unknown,
  refresh?: () => void | Promise<void>
): Promise<boolean> {
  const msg = message as { type?: unknown } | null | undefined;
  if (!msg || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'nav.openDashboard':
      await vscode.commands.executeCommand('snlDoc.openDashboard');
      return true;
    case 'nav.refresh':
      if (refresh) {
        await refresh();
        return true;
      }
      return false;
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
