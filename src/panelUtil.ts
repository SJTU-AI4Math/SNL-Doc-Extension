import * as vscode from 'vscode';
import { type Trace } from './trace';
import * as fs from 'fs';
import { extension_preferences_runtime } from './preferences';
import { register_preferences_webview } from './preferencesHost';
import {
  brand_html_attributes,
  escape_html_attribute,
  preference_html_attributes
} from './panelHtml';

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

  register_preferences_webview(webview);
  const preferences = extension_preferences_runtime.query_environment();
  const htmlAttributes = preference_html_attributes(preferences);
  const blackLogoUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'icons', 'logoCSS_black.svg')
  );
  const whiteLogoUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'icons', 'logoCSS_white.svg')
  );
  const brandAttributes = brand_html_attributes(
    blackLogoUri.toString(),
    whiteLogoUri.toString()
  );
  const safeTitle = escape_html_attribute(title);

  return `<!DOCTYPE html>
<html ${htmlAttributes} ${brandAttributes}>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script nonce="${nonce}">
    /* Cat 2026-07-25: this must be the FIRST thing in the document.
       Placed above the stylesheet link on purpose — a render-blocking
       <link> in <head> delays everything after it, so a probe in <body>
       cannot distinguish "VS Code booting the webview host" from "waiting
       on our CSS". Three marks bracket the two costs:
         head-start  -> document parsing began
         css-loaded  -> the stylesheet finished (or errored)
         dom-ready   -> parsing done */
    try {
      const api = acquireVsCodeApi();
      window.__snlApi = api;
      const mark = function (stage) {
        api.postMessage({ type: 'trace', stage: stage, ms: performance.now() });
      };
      window.__snlMark = mark;
      mark('head-start');
      document.addEventListener('DOMContentLoaded', function () {
        mark('dom-ready');
      });
    } catch (e) { /* tracing must never break the panel */ }
  </script>
  ${styleTag}
  <script nonce="${nonce}">
    try { window.__snlMark && window.__snlMark('css-loaded'); } catch (e) {}
  </script>
  <title>${safeTitle}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    try { window.__snlMark && window.__snlMark('document-start'); } catch (e) {}
  </script>
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
  // Coalesce bursts. Saving one entry rewrites several files, and every
  // open panel installs one of these — without a debounce a single save
  // fanned out to (files × panels) full workspace re-reads, which is what
  // made panels feel sluggish while editing.
  // Cat 2026-07-25: "各个 Panel 开起来都非常慢".
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (uri: vscode.Uri): void => {
    // Ignore churn we never read: only the entry pool, macro packages and
    // config feed panel state.
    if (!SNL_DOC_WATCHED_PATH.test(uri.path)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, SNL_DOC_WATCH_DEBOUNCE_MS);
  };
  watcher.onDidCreate(fire, null, disposables);
  watcher.onDidChange(fire, null, disposables);
  watcher.onDidDelete(fire, null, disposables);
  disposables.push(watcher);
  disposables.push({
    dispose: () => {
      if (timer) clearTimeout(timer);
    }
  });
}

/** How long to coalesce a burst of `.SNL_Doc` writes before refreshing. */
export const SNL_DOC_WATCH_DEBOUNCE_MS = 120;

/**
 * The `.SNL_Doc` paths whose contents actually feed panel state, matching the
 * URI helpers in snlDoc.ts (`configUri`, `entriesUri`, `relationshipsUri`,
 * `termMacrosDirUri`, `libraryDirUri`). Anything else under `.SNL_Doc/**`
 * (assets, scratch files, editor temp files) must not trigger a re-read.
 *
 * Entry kinds live inside `config.json`, so there is no separate file here.
 */
export const SNL_DOC_WATCHED_PATH = new RegExp(
  '\\.SNL_Doc/(' +
    'config\\.json|' +
    'entries\\.json|' +
    '(entries|packages|macros)/[^/]+\\.json|' +
    'relationships\\.json|' +
    'term_macros/[^/]+\\.json|' +
    'libraries/[^/]+/[^/]+\\.json' +
    ')$',
  'i'
);

/**
 * Shared handler for top-of-panel navigation messages posted by the
 * `PanelHeader` webview component (cat 2026-07-09, unified 2026-08-03). Every editor / list
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
 * A `refresh` callback can be passed to opt into the shared PanelHeader
 * refresh button (cat 2026-07-13 '手动刷新键也没有'). When the webview
 * posts `{ type: 'nav.refresh' }` and a callback is supplied, we invoke
 * it and swallow the message; otherwise we hand it back to the caller
 * (false) so a panel that doesn't opt in stays unaffected.
 */
/**
 * Fold a webview-reported timing mark into `trace`, if it is one.
 *
 * Every panel gets this for free so we can compare panel types against each
 * other. Putting them on one timeline is what refuted the original theory:
 * cat 2026-07-26 established that the Infoview's FIRST open is just as slow
 * as an editor panel's, and only its in-webview navigation is fast. So panel
 * type is not the variable — calling `createWebviewPanel` is.
 *
 * Returns true when the message was a trace mark and needs no further
 * handling.
 */
export function handleWebviewTraceMessage(
  message: unknown,
  trace: Trace | undefined
): boolean {
  const msg = message as { type?: unknown; stage?: unknown; ms?: unknown } | null;
  if (!msg || msg.type !== 'trace' || typeof msg.stage !== 'string') return false;
  trace?.mark(
    `webview:${msg.stage}`,
    typeof msg.ms === 'number' ? `webviewClock=${msg.ms.toFixed(1)}ms` : undefined
  );
  return true;
}

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
