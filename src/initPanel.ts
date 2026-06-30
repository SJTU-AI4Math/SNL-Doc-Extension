import * as vscode from 'vscode';
import * as fs from 'fs';
import { slugify } from './slug';

/**
 * Result of scaffolding `.SNL_Doc/` into a workspace.
 * Returned by {@link initSnlDoc} so callers (panel / tests) can react.
 */
export type InitResult =
  | { status: 'created'; slug: string }
  | { status: 'exists' };

const ENCODER = new TextEncoder();

function jsonBytes(value: unknown): Uint8Array {
  return ENCODER.encode(JSON.stringify(value, null, 2) + '\n');
}

/**
 * Scaffold the `.SNL_Doc/` directory tree under `workspaceRoot`.
 *
 * Pure-ish helper (only depends on `vscode.workspace.fs` + `vscode.Uri`) so it
 * can be reused/tested independently of the webview panel. Uses the VS Code
 * filesystem API throughout to stay compatible with remote / virtual FS.
 *
 * If `.SNL_Doc/` already exists it does NOT overwrite and returns
 * `{ status: 'exists' }`.
 */
export async function initSnlDoc(
  workspaceRoot: vscode.Uri,
  title: string
): Promise<InitResult> {
  const fsApi = vscode.workspace.fs;
  const snlRoot = vscode.Uri.joinPath(workspaceRoot, '.SNL_Doc');

  // Bail out if .SNL_Doc already exists; never clobber.
  try {
    await fsApi.stat(snlRoot);
    return { status: 'exists' };
  } catch {
    // stat throws when missing — proceed to create.
  }

  const slug = slugify(title);

  // Directory tree.
  // Note: entries.json lives at the .SNL_Doc/ top level (sibling of libraries/),
  // not inside each library. A library only carries its relationship graph;
  // the subset of entries it consumes is determined implicitly by the UUIDs
  // referenced from that graph. Rationale: many libraries reuse the same
  // entries pool, and forcing each to duplicate the entry list creates drift.
  const termMacrosDir = vscode.Uri.joinPath(snlRoot, 'term_macros');
  const libraryDir = vscode.Uri.joinPath(snlRoot, 'libraries', slug);
  const documentsDir = vscode.Uri.joinPath(libraryDir, 'documents');
  const typstDir = vscode.Uri.joinPath(documentsDir, 'Typst');
  const latexDir = vscode.Uri.joinPath(documentsDir, 'LaTeX');
  const markdownDir = vscode.Uri.joinPath(documentsDir, 'Markdown');

  await fsApi.createDirectory(snlRoot);
  await fsApi.createDirectory(termMacrosDir);
  await fsApi.createDirectory(libraryDir);
  await fsApi.createDirectory(documentsDir);
  await fsApi.createDirectory(typstDir);
  await fsApi.createDirectory(latexDir);
  await fsApi.createDirectory(markdownDir);

  // config.json — original (un-slugified) title preserved.
  const config = {
    version: '0.0.1',
    libraries: [{ slug, title: title.trim() }]
  };
  await fsApi.writeFile(
    vscode.Uri.joinPath(snlRoot, 'config.json'),
    jsonBytes(config)
  );

  // Top-level shared entries pool — sibling of libraries/.
  await fsApi.writeFile(
    vscode.Uri.joinPath(snlRoot, 'entries.json'),
    jsonBytes([])
  );

  // Per-library relationship graph (the only library-local data file).
  await fsApi.writeFile(
    vscode.Uri.joinPath(libraryDir, 'relationships.json'),
    jsonBytes({ nodes: [], edges: [] })
  );

  // .gitkeep placeholders for otherwise-empty directories.
  const gitkeep = ENCODER.encode('');
  await fsApi.writeFile(
    vscode.Uri.joinPath(termMacrosDir, '.gitkeep'),
    gitkeep
  );
  await fsApi.writeFile(vscode.Uri.joinPath(typstDir, '.gitkeep'), gitkeep);
  await fsApi.writeFile(vscode.Uri.joinPath(latexDir, '.gitkeep'), gitkeep);
  await fsApi.writeFile(
    vscode.Uri.joinPath(markdownDir, '.gitkeep'),
    gitkeep
  );

  return { status: 'created', slug };
}

/**
 * Singleton manager for the SNL Init guide webview panel.
 *
 * Mirrors {@link InfoviewPanel}: creates (or reveals) a single webview panel,
 * loads the Vite-built `init.js` bundle from media/webview/, and hardens the
 * embedded HTML with a strict CSP + per-load nonce. Handles `create` messages
 * from the webview by scaffolding `.SNL_Doc/` via {@link initSnlDoc}.
 */
export class InitPanel {
  public static currentPanel: InitPanel | undefined;

  private static readonly viewType = 'snlInit';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Active;

    if (InitPanel.currentPanel) {
      InitPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      InitPanel.viewType,
      'SNL Init',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    InitPanel.currentPanel = new InitPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as { type?: string; title?: string } | undefined;
    if (!msg || msg.type !== 'create') {
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      const text = 'SNL Init 需要先打开一个文件夹/工作区';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({ type: 'error', message: text });
      return;
    }

    const title = typeof msg.title === 'string' ? msg.title : '';

    try {
      const result = await initSnlDoc(workspaceRoot, title);
      if (result.status === 'exists') {
        vscode.window.showWarningMessage('.SNL_Doc 已存在，未做任何更改');
        void this.panel.webview.postMessage({ type: 'exists' });
        return;
      }
      vscode.window.showInformationMessage('SNL Doc 初始化完成');
      void this.panel.webview.postMessage({
        type: 'created',
        path: '.SNL_Doc',
        slug: result.slug
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`SNL Init 失败：${text}`);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'init.js')
    );

    // Vite only emits init.css when the init webview ships real stylesheets.
    const cssPath = vscode.Uri.joinPath(
      this.extensionUri,
      'media',
      'webview',
      'init.css'
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
  <title>SNL Init</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    InitPanel.currentPanel = undefined;

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
