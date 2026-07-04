import * as vscode from 'vscode';
import { createLibrary, updateLibrary } from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';
import { readOverview } from './snlDoc';

/**
 * Per-mode-and-identity singleton manager for the SNL Library editor panel.
 *
 * Two entry points share this class:
 *  - `snlDoc.createLibrary` → create-mode panel (no identity).
 *  - `snlDoc.editLibrary`   → edit-mode panel keyed by library slug.
 *
 * Scope:
 *  - Requires `.SNL_Doc/` to already exist. Create adds a new library dir;
 *    edit updates the config entry's `title` in place (slug is immutable).
 *
 * Message protocol with the webview (`createLibrary.js`):
 *  - in  : `{ type: 'ready' }` (edit only — asks for context)
 *        | `{ type: 'create', title }`
 *        | `{ type: 'update', title }`
 *  - out : `{ type: 'context', mode, existing? }`
 *        | `{ type: 'created' | 'updated' | 'duplicate' | 'noSnlDoc'
 *            | 'notFound' | 'invalid' | 'error' | 'noWorkspace', ... }`
 */
export class CreateLibraryPanel {
  private static readonly instances = new Map<string, CreateLibraryPanel>();

  private static readonly viewType = 'snlCreateLibrary';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly mode: 'create' | 'edit';
  /** Only set when mode === 'edit'; the library slug being edited. */
  private readonly slug: string;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    CreateLibraryPanel.open(extensionUri, 'create', '');
  }

  public static editOrShow(extensionUri: vscode.Uri, slug: string): void {
    if (!slug) {
      return;
    }
    CreateLibraryPanel.open(extensionUri, 'edit', slug);
  }

  private static open(
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    slug: string
  ): void {
    const column = vscode.ViewColumn.Active;
    const key = `${mode}:${slug}`;

    const existing = CreateLibraryPanel.instances.get(key);
    if (existing) {
      existing.panel.reveal(column);
      return;
    }

    const title =
      mode === 'edit' ? `SNL Edit Library — ${slug}` : 'SNL Create Library';
    const panel = vscode.window.createWebviewPanel(
      CreateLibraryPanel.viewType,
      title,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateLibraryPanel.instances.set(
      key,
      new CreateLibraryPanel(panel, extensionUri, mode, slug)
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    slug: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.mode = mode;
    this.slug = slug;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'createLibrary',
      mode === 'edit' ? `SNL Edit Library — ${slug}` : 'SNL Create Library'
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushContext(): Promise<void> {
    if (this.mode === 'create') {
      void this.panel.webview.postMessage({ type: 'context', mode: 'create' });
      return;
    }
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'context',
        mode: 'edit',
        slug: this.slug,
        existing: null
      });
      return;
    }
    try {
      const ov = await readOverview(root);
      const lib = ov.libraries.find((l) => l.slug === this.slug) ?? null;
      void this.panel.webview.postMessage({
        type: 'context',
        mode: 'edit',
        slug: this.slug,
        existing: lib ? { slug: lib.slug, title: lib.title } : null
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as
      | { type?: string; title?: string }
      | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    if (msg.type === 'ready') {
      await this.pushContext();
      return;
    }
    if (msg.type !== 'create' && msg.type !== 'update') {
      return;
    }

    const workspaceRoot = firstWorkspaceFolder();
    if (!workspaceRoot) {
      const text = 'SNL Library editor requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const title = typeof msg.title === 'string' ? msg.title : '';

    try {
      if (msg.type === 'update' || this.mode === 'edit') {
        const result = await updateLibrary(workspaceRoot, this.slug, { title });
        switch (result.status) {
          case 'updated':
            vscode.window.showInformationMessage(
              `Library "${result.slug}" title updated to "${result.title}".`
            );
            void this.panel.webview.postMessage({
              type: 'updated',
              slug: result.slug,
              title: result.title
            });
            return;
          case 'notFound': {
            const text = `Library "${result.id}" no longer exists.`;
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'notFound',
              slug: result.id,
              message: text
            });
            return;
          }
          case 'noSnlDoc': {
            const text = '.SNL_Doc does not exist yet. Run "SNL: Init" first.';
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'noSnlDoc',
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
          case 'error':
            void this.panel.webview.postMessage({
              type: 'error',
              message: result.message
            });
            return;
        }
      }
      // Create path.
      const result = await createLibrary(workspaceRoot, title);
      switch (result.status) {
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
          const text = `Library "${result.slug}" already exists.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            slug: result.slug,
            message: text
          });
          return;
        }
        case 'created':
          vscode.window.showInformationMessage(
            `Library "${result.title}" created (slug: ${result.slug}).`
          );
          void this.panel.webview.postMessage({
            type: 'created',
            slug: result.slug,
            title: result.title
          });
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`SNL Library editor failed: ${text}`);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    const key = `${this.mode}:${this.slug}`;
    CreateLibraryPanel.instances.delete(key);

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
