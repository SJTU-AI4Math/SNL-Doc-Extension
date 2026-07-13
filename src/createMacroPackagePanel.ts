import * as vscode from 'vscode';
import {
  createMacroPackage,
  readMacroPackage,
  updateMacroPackage
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage,
  installSnlDocWatcher
} from './panelUtil';

/**
 * Per-mode-and-identity singleton manager for the SNL Macro Package editor
 * panel.
 *
 * Two entry points share this class:
 *  - `snlDoc.createMacroPackage` → create-mode panel (asks for a filename).
 *  - `snlDoc.editMacroPackage`   → edit-mode panel keyed by bare filename;
 *                                  only meta (name, description) is editable.
 *
 * Message protocol with the webview (`createMacroPackage.js`):
 *  - in  : `{ type: 'ready' }` (asks for context)
 *        | `{ type: 'create', file, name, description }`
 *        | `{ type: 'update', name, description }`
 *  - out : `{ type: 'context', mode, file?, existing? }`
 *        | `{ type: 'created' | 'updated' | 'duplicate' | 'notFound'
 *            | 'noSnlDoc' | 'invalid' | 'error' | 'noWorkspace', ... }`
 */
export class CreateMacroPackagePanel {
  private static readonly instances = new Map<string, CreateMacroPackagePanel>();

  private static readonly viewType = 'snlCreateMacroPackage';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly mode: 'create' | 'edit';
  /** Bare filename (no `.json`); only meaningful in edit mode. */
  private readonly file: string;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    CreateMacroPackagePanel.open(extensionUri, 'create', '');
  }

  public static editOrShow(extensionUri: vscode.Uri, file: string): void {
    const bare = (file ?? '').replace(/\.json$/i, '');
    if (!bare) {
      return;
    }
    CreateMacroPackagePanel.open(extensionUri, 'edit', bare);
  }

  private static open(
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    file: string
  ): void {
    const column = vscode.ViewColumn.Active;
    const key = `${mode}:${file}`;

    const existing = CreateMacroPackagePanel.instances.get(key);
    if (existing) {
      existing.panel.reveal(column);
      return;
    }

    const title =
      mode === 'edit'
        ? `SNL Edit Macro Package — ${file}`
        : 'SNL Create Macro Package';
    const panel = vscode.window.createWebviewPanel(
      CreateMacroPackagePanel.viewType,
      title,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateMacroPackagePanel.instances.set(
      key,
      new CreateMacroPackagePanel(panel, extensionUri, mode, file)
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    file: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.mode = mode;
    this.file = file;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'createMacroPackage',
      mode === 'edit'
        ? `SNL Edit Macro Package — ${file}`
        : 'SNL Create Macro Package'
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    installSnlDocWatcher(this.disposables, () => this.pushContext());

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
        file: this.file,
        existing: null
      });
      return;
    }
    const read = await readMacroPackage(root, this.file);
    if (read.status === 'ok') {
      void this.panel.webview.postMessage({
        type: 'context',
        mode: 'edit',
        file: this.file,
        existing: {
          file: this.file,
          name: read.pkg.name,
          description: read.pkg.description ?? ''
        }
      });
      return;
    }
    void this.panel.webview.postMessage({
      type: 'context',
      mode: 'edit',
      file: this.file,
      existing: null
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    // Nav messages (back to Dashboard / Infoview) MUST be intercepted
    // before any type-filter early-return below drops them silently.
    // Cat 2026-07-10 caught this on Edit Library; every save-oriented
    // panel had the same shape.
    if (await handlePanelNavMessage(message, () => this.pushContext())) {
      return;
    }
    const msg = message as
      | { type?: string; file?: string; name?: string; description?: string }
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
      const text =
        'SNL Macro Package editor requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const name = typeof msg.name === 'string' ? msg.name : '';
    const description =
      typeof msg.description === 'string' ? msg.description : '';

    try {
      if (msg.type === 'update' || this.mode === 'edit') {
        const result = await updateMacroPackage(workspaceRoot, this.file, {
          name,
          description
        });
                switch (result.status) {
          case 'updated':
            vscode.window.showInformationMessage(
              `Macro package "${result.file}" updated.`
            );
            void this.panel.webview.postMessage({
              type: 'updated',
              file: result.file,
              name: result.name
            });
            return;
          case 'notFound': {
            const text = `Macro package "${result.id}" no longer exists.`;
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'notFound',
              file: result.id,
              message: text
            });
            return;
          }
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
          case 'invalid':
            void this.panel.webview.postMessage({
              type: 'invalid',
              reason: result.message
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
      const file = typeof msg.file === 'string' ? msg.file : '';
      const result = await createMacroPackage(
        workspaceRoot,
        file,
        name,
        description
      );
      switch (result.status) {
        case 'ok':
          vscode.window.showInformationMessage(
            `Macro package "${result.file}" created.`
          );
          void this.panel.webview.postMessage({
            type: 'created',
            file: result.file
          });
          // Open the new package's panel right away for a smooth flow.
          void vscode.commands.executeCommand(
            'snlDoc.openMacroPackage',
            result.file
          );
          return;
        case 'duplicate': {
          const text = `Macro package "${result.file}" already exists.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            file: result.file,
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
            reason: result.reason
          });
          return;
        case 'error':
          void this.panel.webview.postMessage({
            type: 'error',
            message: result.message
          });
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `SNL Macro Package editor failed: ${text}`
      );
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    const key = `${this.mode}:${this.file}`;
    CreateMacroPackagePanel.instances.delete(key);

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
